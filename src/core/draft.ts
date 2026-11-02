/**
 * The in-progress encounter ("draft"): creature entries with quantities and locks, plus evaluation
 * against a resolved party. Pure; the app owns an instance and persists it to recipes on save.
 */
import {
  evaluateEncounter,
  inferThreat,
  type EncounterEvaluation,
  type EvaluatedEntry,
  type ThreatLevel,
} from "./budget.js";
import type { CatalogEntry } from "./catalog.js";
import type { CreatureAdjustment, RecipeEntry } from "./schemas.js";

export type { CreatureAdjustment };

export interface DraftEntry {
  uuid: string;
  name: string;
  /** The source creature's level; see `effectiveLevel` for the level after an adjustment. */
  level: number;
  /** Elite or weak adjustment; absent or null means the unmodified creature. */
  adjustment?: CreatureAdjustment | null;
  quantity: number;
  locked: boolean;
  img: string | null;
  packLabel: string | null;
  traits: string[];
}

export interface Draft {
  entries: DraftEntry[];
  /** Where the current draft came from, for saving. */
  origin: "manual" | "generated" | "table" | "variant";
  generation?: { seed: string | null; inputs: Record<string, unknown> };
  trace?: unknown;
  variantOf?: { original: RecipeEntry[]; diff: import("./schemas.js").VariantDiffEntry[] };
}

export function emptyDraft(): Draft {
  return { entries: [], origin: "manual" };
}

/** What a draft entry needs from a catalog entry, generator result, table roll or world actor. */
export type DraftEntrySource = Pick<CatalogEntry, "uuid" | "name" | "level" | "img" | "traits"> & {
  packLabel: string | null;
};

/** A new unlocked draft entry from any creature source. */
export function entryFromCatalog(entry: DraftEntrySource, quantity = 1): DraftEntry {
  return {
    uuid: entry.uuid,
    name: entry.name,
    level: entry.level,
    quantity,
    locked: false,
    img: entry.img,
    packLabel: entry.packLabel,
    traits: entry.traits,
  };
}

/**
 * Level after the elite/weak adjustment (GM Core): elite is +1, or +2 from level -1 or 0;
 * weak is -1, or -2 from level 1.
 */
export function adjustedLevel(level: number, adjustment: CreatureAdjustment | null | undefined): number {
  if (adjustment === "elite") return level <= 0 ? level + 2 : level + 1;
  if (adjustment === "weak") return level === 1 ? level - 2 : level - 1;
  return level;
}

export function effectiveLevel(entry: Pick<DraftEntry, "level" | "adjustment">): number {
  return adjustedLevel(entry.level, entry.adjustment);
}

/**
 * Draft identity: the source uuid plus the adjustment, so an elite and a normal copy of the same
 * creature are separate rows. An unadjusted entry's key is its uuid.
 */
export function entryKey(entry: Pick<DraftEntry, "uuid" | "adjustment">): string {
  return entry.adjustment ? `${entry.uuid}#${entry.adjustment}` : entry.uuid;
}

export function addEntry(draft: Draft, entry: DraftEntry): Draft {
  const key = entryKey(entry);
  const existing = draft.entries.find((e) => entryKey(e) === key);
  const entries = existing
    ? draft.entries.map((e) => (entryKey(e) === key ? { ...e, quantity: e.quantity + entry.quantity } : e))
    : [...draft.entries, entry];
  return { ...draft, entries };
}

export function setQuantity(draft: Draft, key: string, quantity: number): Draft {
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  const entries = draft.entries
    .map((e) => (entryKey(e) === key ? { ...e, quantity: q } : e))
    .filter((e) => e.quantity > 0);
  return { ...draft, entries };
}

export function removeEntry(draft: Draft, key: string): Draft {
  return { ...draft, entries: draft.entries.filter((e) => entryKey(e) !== key) };
}

/** Every entry of a source creature, whatever its adjustment (e.g. when excluding it from generation). */
export function removeCreature(draft: Draft, uuid: string): Draft {
  return { ...draft, entries: draft.entries.filter((e) => e.uuid !== uuid) };
}

export function toggleLock(draft: Draft, key: string): Draft {
  return {
    ...draft,
    entries: draft.entries.map((e) => (entryKey(e) === key ? { ...e, locked: !e.locked } : e)),
  };
}

/**
 * Change an entry's adjustment in place. When another row already has that creature with the new
 * adjustment, the two merge (quantities add; the merged row is locked if either was).
 */
export function setAdjustment(draft: Draft, key: string, adjustment: CreatureAdjustment | null): Draft {
  const entry = draft.entries.find((e) => entryKey(e) === key);
  if (!entry || (entry.adjustment ?? null) === adjustment) return draft;
  const updated: DraftEntry = { ...entry, adjustment };
  const twin = draft.entries.find((e) => entryKey(e) === entryKey(updated));
  if (!twin) return { ...draft, entries: draft.entries.map((e) => (e === entry ? updated : e)) };
  const entries = draft.entries
    .filter((e) => e !== entry)
    .map((e) =>
      e === twin ? { ...e, quantity: e.quantity + entry.quantity, locked: e.locked || entry.locked } : e,
    );
  return { ...draft, entries };
}

/**
 * A rerolled draft's rows: the kept rows as they were (lock state and elite/weak adjustment included),
 * then the newly generated creatures. The generator echoes kept rows back as locked entries; those are
 * skipped. A generated creature that matches an unadjusted kept row adds to its quantity.
 */
export function mergeGenerated(
  kept: DraftEntry[],
  generated: (DraftEntrySource & { quantity: number; locked: boolean })[],
): DraftEntry[] {
  let draft: Draft = { entries: kept, origin: "generated" };
  for (const e of generated) if (!e.locked) draft = addEntry(draft, entryFromCatalog(e, e.quantity));
  return draft.entries;
}

export function totalCreatures(draft: Draft): number {
  return draft.entries.reduce((n, e) => n + e.quantity, 0);
}

export function toRecipeEntries(draft: Draft): RecipeEntry[] {
  return draft.entries.map((e) => ({
    uuid: e.uuid,
    name: e.name,
    level: e.level,
    ...(e.adjustment ? { adjustment: e.adjustment } : {}),
    quantity: e.quantity,
    locked: e.locked,
  }));
}

/* -------------------------------------------- */
/*  Evaluation with optional PWL delegation     */
/* -------------------------------------------- */

export interface DraftEvaluation extends EncounterEvaluation {
  /** True when per-creature XP came from the system helper (Proficiency Without Level). */
  systemCalculation: boolean;
  /** True when PWL is on but the system helper is unavailable: numbers use standard rules and are flagged. */
  variantUnsupported: boolean;
}

export interface EvaluateDraftOptions {
  partySize: number;
  referenceLevel: number;
  selectedThreat: ThreatLevel | null;
  pwol?: boolean;
  /** Per-creature XP under PWL from the system; null when unavailable. */
  pwolCreatureXP?: (referenceLevel: number, creatureLevel: number) => number | null;
}

export function evaluateDraft(draft: Draft, options: EvaluateDraftOptions): DraftEvaluation {
  const base = evaluateEncounter({
    partySize: options.partySize,
    referenceLevel: options.referenceLevel,
    selectedThreat: options.selectedThreat,
    entries: draft.entries.map((e) => ({
      id: entryKey(e),
      name: e.name,
      level: effectiveLevel(e),
      quantity: e.quantity,
    })),
  });
  if (!options.pwol) return { ...base, systemCalculation: false, variantUnsupported: false };

  const helper = options.pwolCreatureXP;
  const probe = helper ? helper(options.referenceLevel, options.referenceLevel) : null;
  if (!helper || probe === null) return { ...base, systemCalculation: false, variantUnsupported: true };

  // Delegate per-creature XP to the system under PWL. The system clamps its own (wider) range;
  // a creature it still cannot price is reported like an out-of-range creature on the standard
  // path (no XP, excluded from the total, evaluation incomplete) rather than silently counted as 0.
  const entries: EvaluatedEntry[] = base.entries.map((entry) => {
    const xp = helper(options.referenceLevel, entry.level);
    if (xp === null || !Number.isFinite(xp)) {
      const status = entry.relativeLevel < 0 ? ("belowRange" as const) : ("aboveRange" as const);
      return { ...entry, status, xpEach: null, subtotal: null };
    }
    return { ...entry, status: "supported" as const, xpEach: xp, subtotal: xp * entry.quantity };
  });
  const belowRange = entries.filter((e) => e.status === "belowRange" && e.quantity > 0);
  const aboveRange = entries.filter((e) => e.status === "aboveRange" && e.quantity > 0);
  const supportedXP = entries.reduce((s, e) => s + (e.subtotal ?? 0), 0);
  const difference = base.tier && base.tier.available ? supportedXP - base.tier.target : null;
  const warnings = base.warnings.filter(
    (w) => !["incompleteBelowRange", "incompleteAboveRange", "overBudget", "underBudget"].includes(w.code),
  );
  if (belowRange.length > 0)
    warnings.push({ code: "incompleteBelowRange", data: { ids: belowRange.map((e) => e.id) } });
  if (aboveRange.length > 0)
    warnings.push({ code: "incompleteAboveRange", data: { ids: aboveRange.map((e) => e.id) } });
  if (difference !== null && difference > 0) warnings.push({ code: "overBudget", data: { difference } });
  else if (difference !== null && difference < 0 && !base.tier?.isCeiling)
    warnings.push({ code: "underBudget", data: { difference } });
  return {
    ...base,
    entries,
    supportedXP,
    complete: belowRange.length === 0 && aboveRange.length === 0,
    belowRange,
    aboveRange,
    difference,
    inferred: inferThreat(supportedXP, options.partySize, {
      hasAboveRange: aboveRange.length > 0,
      hasBelowRange: belowRange.length > 0,
    }),
    warnings,
    systemCalculation: true,
    variantUnsupported: false,
  };
}
