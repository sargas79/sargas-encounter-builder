/**
 * PF2eAdapter: the only place PF2e data paths appear.
 * Every accessor is documented in docs/VERIFICATION.md §2.
 */
import { rankReusableActors } from "../core/deployment.js";
import type { ActorSummary } from "../core/party.js";

/** Ports used by services, so they can be unit tested with mocks. */
export interface ActorResolver {
  resolve(uuid: string): Promise<ActorSummary>;
  /** Live member UUIDs from a PF2e Party actor, or null when not a Party actor / not found. */
  partyMemberUuids(partyUuid: string): Promise<string[] | null>;
  /** All Party actors in the world, for selection. */
  listPartyActors(): { uuid: string; name: string }[];
}

export interface VariantInfo {
  /** Proficiency Without Level enabled (`pf2e.proficiencyVariant`). */
  pwol: boolean;
}

export interface SystemXPHelper {
  available: boolean;
  /** Total XP computed by `game.pf2e.gm.calculateXP` for in-range creature levels. */
  total(partyLevel: number, partySize: number, npcLevels: number[], pwol: boolean): number | null;
}

const COMPANION_TRAITS = new Set(["eidolon", "minion"]);

export function summarizeActor(actor: ActorDocument | null, uuid: string): ActorSummary {
  if (!actor) return { uuid, name: uuid, type: "unknown", level: null, accessible: false };
  const type = String(actor.type ?? "unknown");
  const level =
    typeof actor.level === "number" ? actor.level : numberOrNull(actor.system?.details?.level?.value);
  // Animal companions and eidolons are "character" actors in PF2e with class-feature markers; treat the
  // commonly flagged ones as companion-like so they are listed but not counted.
  const traits: unknown = actor.system?.traits?.value;
  const isCompanionLike =
    type === "character" &&
    (actor.system?.details?.companion === true ||
      (Array.isArray(traits) && traits.some((t) => typeof t === "string" && COMPANION_TRAITS.has(t))));
  return { uuid, name: actor.name, type, level, accessible: true, isCompanionLike };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class PF2eAdapter implements ActorResolver {
  async resolve(uuid: string): Promise<ActorSummary> {
    try {
      const doc = (await fromUuid(uuid)) as ActorDocument | null;
      if (!doc || doc.documentName !== "Actor") return summarizeActor(null, uuid);
      if (!doc.testUserPermission(game.user, "LIMITED")) return summarizeActor(null, uuid);
      return summarizeActor(doc, uuid);
    } catch {
      return summarizeActor(null, uuid);
    }
  }

  async partyMemberUuids(partyUuid: string): Promise<string[] | null> {
    const doc = (await fromUuid(partyUuid)) as ActorDocument | null;
    if (!doc || doc.type !== "party") return null;
    const members: unknown = doc.system?.details?.members;
    if (!Array.isArray(members)) return [];
    return members
      .map((m) => (m && typeof m === "object" ? String((m as { uuid?: string }).uuid ?? "") : ""))
      .filter(Boolean);
  }

  listPartyActors(): { uuid: string; name: string }[] {
    return game.actors.filter((a) => a.type === "party").map((a) => ({ uuid: a.uuid, name: a.name }));
  }

  variantInfo(): VariantInfo {
    try {
      const fromNamespace = game.pf2e?.settings?.variants?.pwol?.enabled;
      if (typeof fromNamespace === "boolean") return { pwol: fromNamespace };
      return { pwol: !!game.settings.get("pf2e", "proficiencyVariant") };
    } catch {
      return { pwol: false };
    }
  }

  systemXPHelper(): SystemXPHelper {
    const fn = game.pf2e?.gm?.calculateXP;
    if (typeof fn !== "function") return { available: false, total: () => null };
    return {
      available: true,
      total(partyLevel, partySize, npcLevels, pwol) {
        try {
          return fn(partyLevel, partySize, npcLevels, [], { pwol }).totalXP;
        } catch (error) {
          console.warn("sargas-encounter-builder | calculateXP cross-check failed", error);
          return null;
        }
      },
    };
  }

  /** Per-creature XP under Proficiency Without Level, delegated to the system (null when unavailable). */
  pwolCreatureXP(partyLevel: number, creatureLevel: number): number | null {
    const helper = this.systemXPHelper();
    if (!helper.available) return null;
    return helper.total(partyLevel, 4, [creatureLevel], true);
  }

  /** World NPC actors whose compendium source matches, for reuse-on-import (best first; same rule as deployment). */
  worldActorsFromSource(sourceUuid: string): ActorDocument[] {
    return rankReusableActors(game.actors.contents, sourceUuid);
  }
}
