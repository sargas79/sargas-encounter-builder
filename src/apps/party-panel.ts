/**
 * Party tab: party profiles (standalone or linked to a Party actor), roster members, reference-level
 * policy, and actor drops onto the roster. Writes go through the party service, whose change event
 * re-renders the workspace.
 */
import type { ReferenceLevelPolicy } from "../core/budget.js";
import type { RosterState } from "../core/party.js";
import { escapeHtml } from "../core/util.js";
import { isGM } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { confirm, promptSelect, promptText } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import type { Panel } from "./panel.js";
import { actorTypeLabel } from "./view-models.js";

export class PartyPanel implements Panel {
  constructor(private readonly app: EncounterBuilderApp) {}

  /* ---------------------------- context ----------------------------- */

  async prepareContext(): Promise<Record<string, unknown>> {
    const { party, adapter } = services();
    const resolved = this.app.state.resolved;
    const roster = resolved?.roster ?? null;
    return {
      profiles: party.profiles().map((p) => ({
        ...p,
        selected: p.id === resolved?.profile.id,
        kindLabel: t(`party.kind.${p.kind}`),
        count: p.members.length,
      })),
      profile: resolved?.profile ?? null,
      isLinked: resolved?.profile.kind === "linked",
      partyActors: adapter.listPartyActors(),
      roster: roster ? rosterContext(roster) : null,
      policies: (["averageFloor", "highest", "lowest", "manual"] as ReferenceLevelPolicy[]).map((value) => ({
        value,
        label: t(`party.policy.${value}`),
        selected: resolved?.profile.referencePolicy === value,
      })),
      showPolicy: !!roster && roster.reference.distinctLevels.length > 1,
      manualLevel: resolved?.profile.manualReferenceLevel ?? "",
      isManual: resolved?.profile.referencePolicy === "manual",
      blockers: roster?.blockers.map((code) => t(`party.blockers.${code}`)) ?? [],
    };
  }

  /* ---------------------------- inputs ------------------------------ */

  async onChange(name: string, value: string): Promise<boolean> {
    const { party } = services();
    const profile = this.app.state.resolved?.profile;
    switch (name) {
      case "referencePolicy":
        if (profile)
          await party.setReferencePolicy(
            profile.id,
            (value || null) as ReferenceLevelPolicy | null,
            profile.manualReferenceLevel,
          );
        return true;
      case "manualReferenceLevel":
        if (profile) await party.setReferencePolicy(profile.id, "manual", Number.parseInt(value, 10) || null);
        return true;
      default:
        return false;
    }
  }

  async onDrop(purpose: string | undefined, data: Record<string, unknown>): Promise<boolean> {
    if (purpose !== "party") return false;
    if (data?.type !== "Actor" || typeof data.uuid !== "string") {
      this.app.pushMessage("warn", t("messages.dropNotActor"));
      await this.app.render({ parts: ["header"] });
      return true;
    }
    await this.addMember(data.uuid);
    return true;
  }

  /* ---------------------------- actions ----------------------------- */

  async createProfile(): Promise<void> {
    if (!isGM()) return;
    const name = await promptText(
      t("party.newProfileTitle"),
      t("party.newProfileLabel"),
      t("party.defaultName"),
    );
    if (name === null) return;
    await services().party.createProfile(name, "standalone");
  }

  async linkPartyActor(target: HTMLElement): Promise<void> {
    if (!isGM()) return;
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    const existing = services()
      .party.profiles()
      .find((p) => p.kind === "linked" && p.partyActorUuid === uuid);
    if (existing) {
      await services().party.setActive(existing.id);
      return;
    }
    const actor = services()
      .adapter.listPartyActors()
      .find((p) => p.uuid === uuid);
    await services().party.createProfile(actor?.name ?? t("party.defaultName"), "linked", uuid);
  }

  async selectProfile(target: HTMLElement): Promise<void> {
    const id = target.dataset.id;
    if (id) await services().party.setActive(id);
  }

  async renameProfile(): Promise<void> {
    const profile = this.app.state.resolved?.profile;
    if (!profile || !isGM()) return;
    const name = await promptText(t("party.renameTitle"), t("party.newProfileLabel"), profile.name);
    if (name !== null) await services().party.renameProfile(profile.id, name);
  }

  async deleteProfile(): Promise<void> {
    const profile = this.app.state.resolved?.profile;
    if (!profile || !isGM()) return;
    const ok = await confirm(
      t("party.deleteTitle"),
      t("party.deleteConfirm", { name: escapeHtml(profile.name) }),
      "fa-solid fa-trash",
    );
    if (ok) await services().party.deleteProfile(profile.id);
  }

  async toggleMember(target: HTMLElement): Promise<void> {
    const profile = this.app.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    const member = this.app.state.resolved?.roster.members.find((m) => m.uuid === uuid);
    await services().party.setMemberActive(profile.id, uuid, !(member?.active ?? true));
  }

  async toggleCounts(target: HTMLElement): Promise<void> {
    const profile = this.app.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    const member = this.app.state.resolved?.roster.members.find((m) => m.uuid === uuid);
    await services().party.setMemberCounts(profile.id, uuid, !(member?.countsAsMember ?? false));
  }

  async removeMember(target: HTMLElement): Promise<void> {
    const profile = this.app.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    await services().party.removeMember(profile.id, uuid);
  }

  async pickMember(): Promise<void> {
    if (!isGM()) return;
    const candidates = game.actors
      .filter((a) => a.type === "character" || a.type === "npc")
      .map((a) => ({ uuid: a.uuid, name: `${a.name} (${a.type}, ${t("party.level")} ${a.level ?? "?"})` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const uuid = await promptSelect(t("party.pickTitle"), t("party.pickLabel"), candidates);
    if (uuid) await this.addMember(uuid);
  }

  async refreshParty(): Promise<void> {
    services().party.invalidate();
    await this.app.refreshParty();
  }

  async addMember(uuid: string): Promise<void> {
    const { party } = services();
    const profile = this.app.state.resolved?.profile;
    if (!profile) {
      this.app.pushMessage("warn", t("party.noProfile"));
      await this.app.render({ parts: ["header"] });
      return;
    }
    const result = await party.addMember(profile.id, uuid);
    if (!result.ok) {
      this.app.pushMessage("warn", t(`party.reject.${result.reason}`));
      await this.app.render({ parts: ["header"] });
    }
  }
}

function rosterContext(roster: RosterState): Record<string, unknown> {
  return {
    members: roster.members.map((m) => ({
      ...m,
      statusLabel: t(`party.status.${m.reason}`),
      rowClass:
        m.status === "inactive"
          ? "is-inactive"
          : m.status === "missing"
            ? "is-missing"
            : m.status === "notCounted"
              ? "is-muted"
              : "",
      counted: m.status === "counted" || m.status === "overrideCounted",
      canToggleCounts: m.type === "npc" && m.status !== "missing",
      level: m.level ?? "?",
      typeLabel: actorTypeLabel(m.type),
    })),
    partySize: roster.partySize,
    distinctLevels: roster.reference.distinctLevels.join(", "),
    missingCount: roster.missing.length,
  };
}
