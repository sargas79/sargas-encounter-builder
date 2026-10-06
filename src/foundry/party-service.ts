/**
 * PartyService: party profiles (world setting), live roster resolution through an ActorResolver,
 * reference-level policy, and change notification on relevant actor updates.
 */
import { MODULE_ID, SETTINGS } from "../constants.js";
import {
  addMemberToProfile,
  buildRoster,
  newProfile,
  removeMember,
  setMemberActive,
  setMemberCountsAsMember,
  type ActorSummary,
  type RosterState,
} from "../core/party.js";
import { validatePartyProfile, type PartyProfile } from "../core/schemas.js";
import type { ThreatLevel } from "../rules/encounter-tables.js";
import type { ReferenceLevelPolicy } from "../core/budget.js";
import type { ActorResolver } from "./pf2e-adapter.js";

export interface ProfileStore {
  load(): PartyProfile[];
  save(profiles: PartyProfile[]): Promise<void>;
  activeId(): string;
  setActiveId(id: string): Promise<void>;
}

export class SettingsProfileStore implements ProfileStore {
  load(): PartyProfile[] {
    const stored: unknown = game.settings.get(MODULE_ID, SETTINGS.partyProfiles);
    const out: PartyProfile[] = [];
    for (const r of Array.isArray(stored) ? stored : []) {
      const v = validatePartyProfile(r);
      if (v.ok) out.push(v.value);
      else console.warn(`${MODULE_ID} | Ignoring invalid party profile`, v.errors, r);
    }
    return out;
  }
  async save(profiles: PartyProfile[]): Promise<void> {
    // Preserve records that failed validation (e.g. written by a newer build) instead of dropping them.
    const stored: unknown = game.settings.get(MODULE_ID, SETTINGS.partyProfiles);
    const raw = Array.isArray(stored) ? stored : [];
    const invalid = raw.filter((r) => !validatePartyProfile(r).ok);
    await game.settings.set(MODULE_ID, SETTINGS.partyProfiles, [...profiles, ...invalid]);
  }
  activeId(): string {
    return String(game.settings.get(MODULE_ID, SETTINGS.activeParty) ?? "");
  }
  async setActiveId(id: string): Promise<void> {
    await game.settings.set(MODULE_ID, SETTINGS.activeParty, id);
  }
}

export interface ResolvedParty {
  profile: PartyProfile;
  roster: RosterState;
  /** Member UUIDs read from the linked Party actor (linked profiles only). */
  linkedMemberUuids: string[] | null;
}

export class PartyService {
  #listeners = new Set<() => void>();
  #hookIds: number[] = [];
  #summaryCache = new Map<string, ActorSummary>();
  /** Members last read from each linked Party actor, so their updates count as relevant. */
  #linkedMembers = new Map<string, string[]>();

  constructor(
    private readonly resolver: ActorResolver,
    private readonly store: ProfileStore,
    private readonly idFactory: () => string = () => Math.random().toString(36).slice(2, 12),
  ) {}

  /* ---------------------------- profiles ---------------------------- */

  profiles(): PartyProfile[] {
    return this.store.load();
  }

  getProfile(id: string): PartyProfile | null {
    return this.profiles().find((p) => p.id === id) ?? null;
  }

  activeProfile(): PartyProfile | null {
    const id = this.store.activeId();
    return this.getProfile(id) ?? this.profiles()[0] ?? null;
  }

  async setActive(id: string): Promise<void> {
    await this.store.setActiveId(id);
    this.#emit();
  }

  async createProfile(
    name: string,
    kind: PartyProfile["kind"],
    partyActorUuid?: string,
  ): Promise<PartyProfile> {
    const profile = newProfile(this.idFactory(), name.trim() || "Party", kind, partyActorUuid);
    await this.store.save([...this.profiles(), profile]);
    await this.store.setActiveId(profile.id);
    this.#emit();
    return profile;
  }

  async updateProfile(profile: PartyProfile): Promise<void> {
    const validation = validatePartyProfile(profile);
    if (!validation.ok) throw new Error(`Invalid party profile: ${validation.errors.join(", ")}`);
    await this.store.save(this.profiles().map((p) => (p.id === profile.id ? profile : p)));
    this.#emit();
  }

  async deleteProfile(id: string): Promise<void> {
    await this.store.save(this.profiles().filter((p) => p.id !== id));
    if (this.store.activeId() === id) await this.store.setActiveId(this.profiles()[0]?.id ?? "");
    this.#emit();
  }

  async renameProfile(id: string, name: string): Promise<void> {
    const profile = this.getProfile(id);
    if (profile) await this.updateProfile({ ...profile, name: name.trim() || profile.name });
  }

  /* ---------------------------- membership -------------------------- */

  async addMember(profileId: string, uuid: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, reason: "profileMissing" };
    const summary = await this.#summary(uuid, true);
    if (!summary.accessible) return { ok: false, reason: "missing" };
    const result = addMemberToProfile(profile, summary);
    if (!result.ok) return result;
    await this.updateProfile(result.profile);
    return { ok: true };
  }

  async setMemberActive(profileId: string, uuid: string, active: boolean): Promise<void> {
    const profile = this.getProfile(profileId);
    if (profile) await this.updateProfile(setMemberActive(profile, uuid, active));
  }

  async setMemberCounts(profileId: string, uuid: string, counts: boolean): Promise<void> {
    const profile = this.getProfile(profileId);
    if (profile) await this.updateProfile(setMemberCountsAsMember(profile, uuid, counts));
  }

  async removeMember(profileId: string, uuid: string): Promise<void> {
    const profile = this.getProfile(profileId);
    if (profile) await this.updateProfile(removeMember(profile, uuid));
  }

  async setReferencePolicy(
    profileId: string,
    policy: ReferenceLevelPolicy | null,
    manualLevel: number | null,
  ): Promise<void> {
    const profile = this.getProfile(profileId);
    if (profile)
      await this.updateProfile({ ...profile, referencePolicy: policy, manualReferenceLevel: manualLevel });
  }

  async setThreat(profileId: string, threat: ThreatLevel): Promise<void> {
    const profile = this.getProfile(profileId);
    if (profile) await this.updateProfile({ ...profile, selectedThreat: threat });
  }

  /* ---------------------------- resolution -------------------------- */

  async resolve(profile: PartyProfile, { fresh = false }: { fresh?: boolean } = {}): Promise<ResolvedParty> {
    let linkedMemberUuids: string[] | null = null;
    if (profile.kind === "linked" && profile.partyActorUuid) {
      linkedMemberUuids = await this.resolver.partyMemberUuids(profile.partyActorUuid);
      if (linkedMemberUuids !== null) this.#linkedMembers.set(profile.partyActorUuid, linkedMemberUuids);
      if (linkedMemberUuids === null) {
        // The Party actor is gone: fall back to overrides so the GM sees what used to be there.
        linkedMemberUuids = profile.members.map((m) => m.uuid);
      }
    }
    const uuids = linkedMemberUuids ?? profile.members.map((m) => m.uuid);
    const summaries = new Map<string, ActorSummary>();
    for (const uuid of uuids) summaries.set(uuid, await this.#summary(uuid, fresh));
    const roster = buildRoster(profile, summaries, linkedMemberUuids);
    return { profile, roster, linkedMemberUuids };
  }

  async resolveActive(options?: { fresh?: boolean }): Promise<ResolvedParty | null> {
    const profile = this.activeProfile();
    return profile ? this.resolve(profile, options) : null;
  }

  async #summary(uuid: string, fresh: boolean): Promise<ActorSummary> {
    if (!fresh) {
      const cached = this.#summaryCache.get(uuid);
      if (cached) return cached;
    }
    const summary = await this.resolver.resolve(uuid);
    this.#summaryCache.set(uuid, summary);
    return summary;
  }

  /** Drop cached summaries for a UUID (or all). */
  invalidate(uuid?: string): void {
    if (uuid) this.#summaryCache.delete(uuid);
    else this.#summaryCache.clear();
  }

  /* ---------------------------- change events ----------------------- */

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const l of this.#listeners) {
      try {
        l();
      } catch (error) {
        console.error(`${MODULE_ID} | party listener failed`, error);
      }
    }
  }

  /**
   * UUIDs whose changes can alter what the workspace shows: members of every profile (the party
   * panel lists them all), each linked Party actor, and the members last read from those actors.
   */
  #watchedUuids(): Set<string> {
    const out = new Set<string>();
    for (const profile of this.profiles()) {
      for (const m of profile.members) out.add(m.uuid);
      if (profile.partyActorUuid) {
        out.add(profile.partyActorUuid);
        for (const uuid of this.#linkedMembers.get(profile.partyActorUuid) ?? []) out.add(uuid);
      }
    }
    return out;
  }

  /**
   * Called from Foundry hooks (registered once) when an actor changes. Emits only when the actor
   * belongs to a profile or linked Party (a combatant's HP change must not re-render the workspace);
   * creating or deleting a Party actor also emits, since it changes the linkable parties.
   */
  handleActorChange(
    actorUuid: string,
    changed?: Record<string, unknown>,
    { actorType }: { actorType?: string } = {},
  ): void {
    const relevantFields =
      !changed || "system" in changed || "name" in changed || "ownership" in changed || "items" in changed;
    if (!relevantFields) return;
    this.invalidate(actorUuid);
    const lifecycle = !changed;
    if (this.#watchedUuids().has(actorUuid) || (lifecycle && actorType === "party")) this.#emit();
  }

  /** Register Foundry hooks once; returns an unregister function. */
  registerHooks(): () => void {
    if (this.#hookIds.length) return () => this.unregisterHooks();
    const onUpdate = (actor: ActorDocument, changed: Record<string, unknown>) =>
      this.handleActorChange(actor.uuid, changed);
    const onLifecycle = (actor: ActorDocument) =>
      this.handleActorChange(actor.uuid, undefined, { actorType: actor.type });
    this.#hookIds.push(
      Hooks.on("updateActor", onUpdate),
      Hooks.on("deleteActor", onLifecycle),
      Hooks.on("createActor", onLifecycle),
    );
    return () => this.unregisterHooks();
  }

  unregisterHooks(): void {
    const names = ["updateActor", "deleteActor", "createActor"];
    this.#hookIds.forEach((id, i) => Hooks.off(names[i] ?? "updateActor", id));
    this.#hookIds = [];
  }
}
