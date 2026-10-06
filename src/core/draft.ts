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
import type { RecipeEntry } from "./schemas.js";

export interface DraftEntry {
  uuid: string;
  name: string;
  level: number;
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

export function entryFromCatalog(entry: CatalogEntry, quantity = 1): DraftEntry {
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

export function addEntry(draft: Draft, entry: DraftEntry): Draft {
  const existing = draft.entries.find((e) => e.uuid === entry.uuid);
  const entries = existing
    ? draft.entries.map((e) => (e.uuid === entry.uuid ? { ...e, quantity: e.quantity + entry.quantity } : e))
    : [...draft.entries, entry];
  return { ...draft, entries };
}

export function setQuantity(draft: Draft, uuid: string, quantity: number): Draft {
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  const entries = draft.entries
    .map((e) => (e.uuid === uuid ? { ...e, quantity: q } : e))
    .filter((e) => e.quantity > 0);
  return { ...draft, entries };
}

export function removeEntry(draft: Draft, uuid: string): Draft {
  return { ...draft, entries: draft.entries.filter((e) => e.uuid !== uuid) };
}

export function toggleLock(draft: Draft, uuid: string): Draft {
  return { ...draft, entries: draft.entries.map((e) => (e.uuid === uuid ? { ...e, locked: !e.locked } : e)) };
}

export function totalCreatures(draft: Draft): number {
  return draft.entries.reduce((n, e) => n + e.quantity, 0);
}

export function toRecipeEntries(draft: Draft): RecipeEntry[] {
  return draft.entries.map((e) => ({
    uuid: e.uuid,
    name: e.name,
    level: e.level,
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
    entries: draft.entries.map((e) => ({ id: e.uuid, name: e.name, level: e.level, quantity: e.quantity })),
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
