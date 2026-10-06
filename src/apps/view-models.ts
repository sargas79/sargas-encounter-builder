/**
 * View-model helpers: turn core results into the plain objects the Handlebars templates read.
 * No Foundry access beyond `t()` (which falls back to the key outside Foundry), so they run in tests.
 */
import { THREAT_LEVELS, tierBudget } from "../core/budget.js";
import { totalCreatures, type Draft, type DraftEvaluation } from "../core/draft.js";
import type { PackLoadState } from "../foundry/creature-catalog.js";
import { t } from "../foundry/i18n.js";
import type { ResolvedParty } from "../foundry/party-service.js";

export type TabId = "party" | "build" | "treasure" | "tables" | "saved" | "deploy";
export const TABS: TabId[] = ["party", "build", "treasure", "tables", "saved", "deploy"];
/** Tabs that need a ready party (no roster blockers, a reference level). */
export const GATED_TABS: TabId[] = ["build", "treasure", "tables", "deploy"];

const TAB_ICONS: Record<TabId, string> = {
  party: "fa-solid fa-users",
  build: "fa-solid fa-hammer",
  treasure: "fa-solid fa-gem",
  tables: "fa-solid fa-table-list",
  saved: "fa-solid fa-folder-open",
  deploy: "fa-solid fa-chess-knight",
};

export function tabsContext(activeTab: TabId, ready: boolean): Record<string, unknown>[] {
  return TABS.map((id) => ({
    id,
    label: t(`tabs.${id}`),
    icon: TAB_ICONS[id],
    active: id === activeTab,
    disabled: GATED_TABS.includes(id) && !ready,
    tooltip: GATED_TABS.includes(id) && !ready ? t("gate.tooltip") : "",
  }));
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Localized inferred threat. `label` is a threat level or "beyondExtreme"; saved snapshots store it
 * with a literal suffix (e.g. "beyondExtreme (unquantified)"), which is kept as is.
 */
export function inferredThreatLabel(label: string, unquantified = false): string {
  const text = label.startsWith("beyondExtreme")
    ? label.replace("beyondExtreme", t("evaluation.beyondExtreme"))
    : t(`threat.${label}`);
  return unquantified ? `${text} ${t("evaluation.unquantified")}` : text;
}

/** Context for the threat meter: five tiers with the target tick and the actual marker. */
export function meterContext(evaluation: DraftEvaluation): Record<string, unknown> {
  const extreme = tierBudget("extreme", evaluation.partySize).target;
  const scaleMax = Math.max(extreme * 1.15, evaluation.supportedXP * 1.05, 1);
  const pct = (xp: number) => Math.min(100, Math.max(0, (xp / scaleMax) * 100));
  const tiers = THREAT_LEVELS.map((threat) => {
    const tier = tierBudget(threat, evaluation.partySize);
    return {
      threat,
      label: t(`threat.${threat}`),
      target: tier.target,
      available: tier.available,
      left: pct(tier.target),
      selected: evaluation.selectedThreat === threat,
    };
  });
  // Adjacent tier labels can sit ~11% apart, which is less than a label's width in a narrow
  // panel. Drop a label onto a second row when it would collide with the previous one on its row.
  const MIN_GAP = 16;
  let lastRow0: number | null = null;
  const tiersStaggered = tiers.map((tier) => {
    const row = lastRow0 === null || tier.left - lastRow0 >= MIN_GAP ? 0 : 1;
    if (row === 0) lastRow0 = tier.left;
    return { ...tier, row };
  });
  const inferred = evaluation.inferred;
  const over = evaluation.difference !== null && evaluation.difference > 0;
  return {
    tiers: tiersStaggered,
    staggered: tiersStaggered.some((tier) => tier.row === 1),
    fill: pct(evaluation.supportedXP),
    supportedXP: evaluation.supportedXP,
    target: evaluation.tier?.available ? evaluation.tier.target : null,
    targetLeft: evaluation.tier?.available ? pct(evaluation.tier.target) : null,
    difference: evaluation.difference,
    differenceLabel: evaluation.difference === null ? "" : signed(evaluation.difference),
    over,
    complete: evaluation.complete,
    inferredLabel: inferredThreatLabel(inferred.label, inferred.unquantified),
    selectedLabel: evaluation.selectedThreat ? t(`threat.${evaluation.selectedThreat}`) : "—",
    creatureCount: evaluation.creatureCount,
    warnings: evaluation.warnings
      .filter((w) => w.code !== "underBudget")
      .map((w) => ({
        level: w.code === "overBudget" || w.code.startsWith("incomplete") ? "warn" : "info",
        text: t(`evaluation.warnings.${w.code}`, w.data),
      })),
    systemCalculation: evaluation.systemCalculation,
    variantUnsupported: evaluation.variantUnsupported,
    stateClass: inferred.unquantified
      ? "is-unquantified"
      : over
        ? "is-over"
        : evaluation.difference === 0
          ? "is-exact"
          : "",
  };
}

export function describePackState(state: PackLoadState | undefined): string {
  if (!state) return t("build.packState.notLoaded");
  switch (state.state) {
    case "loaded":
      return t("build.packState.loaded", { count: state.count, skipped: state.skipped });
    case "inaccessible":
      return t("build.packState.inaccessible");
    case "missing":
      return t("build.packState.missing");
    case "error":
      return t("build.packState.error", { message: state.message });
  }
}

/** Draft size and origin, shown in the Build tab and the footer. */
export function draftSummary(draft: Draft): { draftCount: number; hasDraft: boolean; originLabel: string } {
  return {
    draftCount: totalCreatures(draft),
    hasDraft: draft.entries.length > 0,
    originLabel: t(`saved.origin.${draft.origin}`),
  };
}

/** Header strip: party summary, reference level and the threat picker with each tier's target. */
export function headerContext(
  resolved: ResolvedParty | null,
  evaluation: DraftEvaluation | null,
  pwol: boolean,
): Record<string, unknown> {
  const roster = resolved?.roster ?? null;
  const ref = roster?.reference;
  const threats = THREAT_LEVELS.map((threat) => {
    const tier = roster && roster.partySize > 0 ? tierBudget(threat, roster.partySize) : null;
    return {
      value: threat,
      label: t(`threat.${threat}`),
      target: tier ? (tier.available ? `${tier.target} XP` : t("party.unavailable")) : "",
      active: resolved?.profile.selectedThreat === threat,
      disabled: tier ? !tier.available : false,
    };
  });
  return {
    hasParty: !!resolved,
    partyName: resolved?.profile.name ?? t("party.none"),
    sourceLabel: resolved ? t(`party.kind.${resolved.profile.kind}`) : "",
    participating: roster?.partySize ?? 0,
    levels: roster ? roster.counted.map((m) => m.level).join(" · ") || "—" : "—",
    referenceLevel: ref?.level ?? "—",
    policy: ref?.policy ? t(`party.policy.${ref.policy}`) : "",
    isEstimate: !!ref?.isEstimate,
    threats,
    target: evaluation?.tier ? (evaluation.tier.available ? evaluation.tier.target : null) : null,
    pwol,
    variantUnsupported: evaluation?.variantUnsupported ?? false,
    systemCalculation: evaluation?.systemCalculation ?? false,
    blockers: roster?.blockers.map((code) => t(`party.blockers.${code}`)) ?? [],
    missing: roster?.missing.length ?? 0,
  };
}

/**
 * Everything party-related the workspace displays: the resolved roster, the profile list and the
 * linkable Party actors. Equal signatures mean a re-render would paint the same party data.
 */
export function partySignature(
  resolved: ResolvedParty | null,
  profiles: unknown[],
  partyActors: { uuid: string; name: string }[],
): string {
  return JSON.stringify([resolved, profiles, partyActors]);
}
