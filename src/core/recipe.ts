/**
 * Pure recipe construction and recalculation. Persistence lives in src/foundry/encounter-repository.ts.
 */
import { evaluateEncounter } from "./budget.js";
import {
  adjustedLevel,
  entryKey,
  toRecipeEntries,
  type Draft,
  type DraftEntry,
  type DraftEvaluation,
} from "./draft.js";
import type { RosterState } from "./party.js";
import type { EvaluationSnapshot, PartyProfile, Recipe, RecipeEntry } from "./schemas.js";

export function snapshotEvaluation(
  profile: PartyProfile | null,
  roster: RosterState | null,
  evaluation: DraftEvaluation | null,
): EvaluationSnapshot | null {
  if (!roster || !evaluation) return null;
  const inferred = evaluation.inferred;
  return {
    timestamp: Date.now(),
    partyProfileId: profile?.id ?? null,
    partyName: profile?.name ?? "",
    memberLevels: roster.counted.map((m) => ({ uuid: m.uuid, name: m.name, level: m.level ?? 0 })),
    partySize: evaluation.partySize,
    referenceLevel: evaluation.referenceLevel,
    referencePolicy: roster.reference.policy,
    selectedThreat: evaluation.selectedThreat,
    target: evaluation.tier?.available ? evaluation.tier.target : null,
    supportedXP: evaluation.supportedXP,
    complete: evaluation.complete,
    inferredLabel: inferred.label + (inferred.unquantified ? " (unquantified)" : ""),
    difference: evaluation.difference,
  };
}

export function recipeFromDraft(
  name: string,
  draft: Draft,
  snapshot: EvaluationSnapshot | null,
  notes = "",
): Recipe {
  const now = Date.now();
  const recipe: Recipe = {
    schemaVersion: 1,
    name: name.trim() || "Encounter",
    notes,
    entries: toRecipeEntries(draft),
    origin: draft.origin,
    evaluation: snapshot,
    createdAt: now,
    updatedAt: now,
  };
  if (draft.generation) recipe.generation = draft.generation;
  if (draft.trace !== undefined) recipe.trace = draft.trace;
  if (draft.variantOf) recipe.variantOf = draft.variantOf;
  if (draft.origin === "table")
    recipe.policy = draft.generation?.inputs?.policy === "partyScaled" ? "partyScaled" : "classic";
  return recipe;
}

/** Recipe -> draft. Missing sources keep their saved name/level so the GM sees what is gone. */
export function draftFromRecipe(
  recipe: Recipe,
  lookup: (uuid: string) => Partial<DraftEntry> | null,
): { draft: Draft; missing: RecipeEntry[] } {
  const missing: RecipeEntry[] = [];
  const entries: DraftEntry[] = recipe.entries.map((e) => {
    const found = lookup(e.uuid);
    if (!found) missing.push(e);
    return {
      uuid: e.uuid,
      name: found?.name ?? e.name,
      level: found?.level ?? e.level,
      ...(e.adjustment ? { adjustment: e.adjustment } : {}),
      quantity: e.quantity,
      locked: e.locked,
      img: found?.img ?? null,
      packLabel: found?.packLabel ?? null,
      traits: found?.traits ?? [],
    };
  });
  const draft: Draft = { entries, origin: recipe.origin };
  if (recipe.generation) draft.generation = recipe.generation;
  if (recipe.trace !== undefined) draft.trace = recipe.trace;
  if (recipe.variantOf) draft.variantOf = recipe.variantOf;
  return { draft, missing };
}

/**
 * Recalculate a recipe against a party without touching the saved snapshot.
 * Returns the fresh evaluation summary side by side with the saved one.
 */
export function recalculateRecipe(
  recipe: Recipe,
  partySize: number,
  referenceLevel: number,
): EvaluationSnapshot {
  const evaluation = evaluateEncounter({
    partySize,
    referenceLevel,
    selectedThreat: recipe.evaluation?.selectedThreat ?? null,
    entries: recipe.entries.map((e) => ({
      id: entryKey(e),
      name: e.name,
      level: adjustedLevel(e.level, e.adjustment),
      quantity: e.quantity,
    })),
  });
  return {
    timestamp: Date.now(),
    partyProfileId: null,
    partyName: "",
    memberLevels: [],
    partySize,
    referenceLevel,
    referencePolicy: null,
    selectedThreat: evaluation.selectedThreat,
    target: evaluation.tier?.available ? evaluation.tier.target : null,
    supportedXP: evaluation.supportedXP,
    complete: evaluation.complete,
    inferredLabel: evaluation.inferred.label + (evaluation.inferred.unquantified ? " (unquantified)" : ""),
    difference: evaluation.difference,
  };
}

export function duplicateRecipe(recipe: Recipe, name: string): Recipe {
  const now = Date.now();
  return { ...structuredClone(recipe), name, createdAt: now, updatedAt: now };
}
