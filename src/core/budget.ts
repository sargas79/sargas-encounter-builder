/**
 * EncounterBudget: pure PF2e encounter budgeting functions.
 *
 * No Foundry or PF2e system imports. Everything here is deterministic and unit-tested.
 * Rule constants live in ../rules/encounter-tables.ts (ORC Licensed Material).
 */
import {
  BASE_PARTY_SIZE,
  CREATURE_XP_BY_RELATIVE_LEVEL,
  MAX_CHARACTER_LEVEL,
  MAX_RELATIVE_LEVEL,
  MIN_CHARACTER_LEVEL,
  MIN_RELATIVE_LEVEL,
  THREAT_BUDGETS,
  THREAT_LEVELS,
  type ThreatLevel,
} from "../rules/encounter-tables.js";

export type { ThreatLevel };
export { THREAT_LEVELS };

/* -------------------------------------------- */
/*  Party validation                            */
/* -------------------------------------------- */

export interface PartyValidationError {
  code: "partySizeInvalid" | "partyEmpty" | "referenceLevelInvalid";
  data?: Record<string, unknown>;
}

export function isValidPartySize(partySize: number): boolean {
  return Number.isInteger(partySize) && partySize >= 1;
}

export function isValidReferenceLevel(level: number): boolean {
  return Number.isInteger(level) && level >= MIN_CHARACTER_LEVEL && level <= MAX_CHARACTER_LEVEL;
}

export function validatePartyInputs(
  partySize: number,
  referenceLevel: number | null,
): PartyValidationError[] {
  const errors: PartyValidationError[] = [];
  if (!Number.isInteger(partySize) || partySize < 0) {
    errors.push({ code: "partySizeInvalid", data: { partySize } });
  } else if (partySize === 0) {
    errors.push({ code: "partyEmpty" });
  }
  if (referenceLevel === null || !isValidReferenceLevel(referenceLevel)) {
    errors.push({
      code: "referenceLevelInvalid",
      data: { referenceLevel, min: MIN_CHARACTER_LEVEL, max: MAX_CHARACTER_LEVEL },
    });
  }
  return errors;
}

/* -------------------------------------------- */
/*  Target budgets                              */
/* -------------------------------------------- */

export interface TierBudget {
  threat: ThreatLevel;
  /** Computed target. May be <= 0 for small parties, in which case `available` is false. */
  target: number;
  /** Whether this tier can be used for this party size. */
  available: boolean;
  /** Trivial is a ceiling; the other tiers are targets. */
  isCeiling: boolean;
  /** Per-character adjustment, also used as the near-fit tolerance by the generator. */
  perCharacter: number;
  /** True when party size exceeds the range the rules give explicit guidance for. */
  largeParty: boolean;
}

/** The party size above which the rules offer no specific guidance. */
export const LARGE_PARTY_THRESHOLD = 8;

/**
 * Raw target budget: `base + (partySize - 4) * perCharacter`.
 * Does not validate; see `tierBudget` for availability.
 */
export function targetBudget(threat: ThreatLevel, partySize: number): number {
  const { base, perCharacter } = THREAT_BUDGETS[threat];
  return base + (partySize - BASE_PARTY_SIZE) * perCharacter;
}

export function tierBudget(threat: ThreatLevel, partySize: number): TierBudget {
  const target = targetBudget(threat, partySize);
  return {
    threat,
    target,
    available: isValidPartySize(partySize) && target > 0,
    isCeiling: threat === "trivial",
    perCharacter: THREAT_BUDGETS[threat].perCharacter,
    largeParty: partySize > LARGE_PARTY_THRESHOLD,
  };
}

export function budgetsForParty(partySize: number): Record<ThreatLevel, TierBudget> {
  const out = {} as Record<ThreatLevel, TierBudget>;
  for (const threat of THREAT_LEVELS) out[threat] = tierBudget(threat, partySize);
  return out;
}

/* -------------------------------------------- */
/*  Creature XP                                 */
/* -------------------------------------------- */

export type CreatureXPStatus = "supported" | "belowRange" | "aboveRange";

export interface CreatureXP {
  relativeLevel: number;
  /** XP per creature, or null when the relative level is outside the table. */
  xp: number | null;
  status: CreatureXPStatus;
}

export function creatureXP(creatureLevel: number, referenceLevel: number): CreatureXP {
  const relativeLevel = creatureLevel - referenceLevel;
  if (relativeLevel < MIN_RELATIVE_LEVEL) return { relativeLevel, xp: null, status: "belowRange" };
  if (relativeLevel > MAX_RELATIVE_LEVEL) return { relativeLevel, xp: null, status: "aboveRange" };
  const xp = CREATURE_XP_BY_RELATIVE_LEVEL.get(relativeLevel);
  if (xp === undefined) throw new Error(`No XP value for relative level ${relativeLevel}`);
  return { relativeLevel, xp, status: "supported" };
}

/** XP for an in-range relative level. Throws for out-of-range input; use `creatureXP` for tolerant lookups. */
export function xpForRelativeLevel(relativeLevel: number): number {
  const xp = CREATURE_XP_BY_RELATIVE_LEVEL.get(relativeLevel);
  if (xp === undefined)
    throw new RangeError(
      `Relative level ${relativeLevel} is outside ${MIN_RELATIVE_LEVEL}..${MAX_RELATIVE_LEVEL}`,
    );
  return xp;
}

/* -------------------------------------------- */
/*  Inferred threat                             */
/* -------------------------------------------- */

export type InferredThreatLabel = ThreatLevel | "beyondExtreme";

export interface InferredThreat {
  label: InferredThreatLabel;
  /** True when a creature above +4 is present: the danger cannot be quantified. */
  unquantified: boolean;
  /** True when creatures below -4 were skipped; the label is a lower bound in theory but practically accurate. */
  incompleteNegligible: boolean;
}

/**
 * Normative inferred-threat algorithm (README §"Inferred threat"):
 * 1. Any creature above +4  -> beyondExtreme, unquantified.
 * 2. xp > extreme target    -> beyondExtreme.
 * 3. xp <= trivial target   -> trivial.
 * 4. Otherwise the lowest available tier whose target >= xp.
 * 5. Creatures below -4 only add the `incompleteNegligible` flag.
 */
export function inferThreat(
  supportedXP: number,
  partySize: number,
  flags: { hasAboveRange?: boolean; hasBelowRange?: boolean } = {},
): InferredThreat {
  const incompleteNegligible = !!flags.hasBelowRange;
  if (flags.hasAboveRange) return { label: "beyondExtreme", unquantified: true, incompleteNegligible };

  const budgets = budgetsForParty(partySize);
  if (supportedXP > budgets.extreme.target)
    return { label: "beyondExtreme", unquantified: false, incompleteNegligible };
  if (supportedXP <= budgets.trivial.target)
    return { label: "trivial", unquantified: false, incompleteNegligible };

  for (const threat of THREAT_LEVELS) {
    const tier = budgets[threat];
    if (!tier.available) continue;
    if (tier.target >= supportedXP) return { label: threat, unquantified: false, incompleteNegligible };
  }
  // Unreachable: extreme.target >= supportedXP was established above.
  return { label: "extreme", unquantified: false, incompleteNegligible };
}

/* -------------------------------------------- */
/*  Encounter evaluation                        */
/* -------------------------------------------- */

export interface EncounterEntryInput {
  /** Stable identity (source UUID). */
  id: string;
  name?: string;
  /** Current effective creature level. */
  level: number;
  quantity: number;
}

export interface EvaluatedEntry extends EncounterEntryInput {
  relativeLevel: number;
  status: CreatureXPStatus;
  xpEach: number | null;
  subtotal: number | null;
}

export interface EvaluationWarning {
  code:
    | "incompleteBelowRange"
    | "incompleteAboveRange"
    | "overBudget"
    | "underBudget"
    | "threatUnavailable"
    | "largeParty"
    | "quantityInvalid";
  data?: Record<string, unknown>;
}

export interface EncounterEvaluation {
  partySize: number;
  referenceLevel: number;
  selectedThreat: ThreatLevel | null;
  /** The selected tier's budget, or null when no threat is selected. */
  tier: TierBudget | null;
  entries: EvaluatedEntry[];
  creatureCount: number;
  supportedXP: number;
  complete: boolean;
  belowRange: EvaluatedEntry[];
  aboveRange: EvaluatedEntry[];
  /** supportedXP - target, or null without a usable target. Positive means over budget. */
  difference: number | null;
  inferred: InferredThreat;
  warnings: EvaluationWarning[];
}

export interface EvaluateOptions {
  partySize: number;
  referenceLevel: number;
  selectedThreat?: ThreatLevel | null;
  entries: EncounterEntryInput[];
}

/**
 * Evaluate a set of creature entries against a party. Callers must validate party inputs first
 * (`validatePartyInputs`); this function throws on invalid party size or reference level so that
 * invalid targets never leak into UI or generation.
 */
export function evaluateEncounter(options: EvaluateOptions): EncounterEvaluation {
  const { partySize, referenceLevel, entries } = options;
  const selectedThreat = options.selectedThreat ?? null;
  const errors = validatePartyInputs(partySize, referenceLevel);
  if (errors.length > 0) {
    throw new Error(`Cannot evaluate encounter: ${errors.map((e) => e.code).join(", ")}`);
  }

  const warnings: EvaluationWarning[] = [];
  const evaluated: EvaluatedEntry[] = entries.map((entry) => {
    const quantity = Number.isInteger(entry.quantity) && entry.quantity > 0 ? entry.quantity : 0;
    if (quantity !== entry.quantity)
      warnings.push({ code: "quantityInvalid", data: { id: entry.id, quantity: entry.quantity } });
    const { relativeLevel, xp, status } = creatureXP(entry.level, referenceLevel);
    return {
      ...entry,
      quantity,
      relativeLevel,
      status,
      xpEach: xp,
      subtotal: xp === null ? null : xp * quantity,
    };
  });

  const belowRange = evaluated.filter((e) => e.status === "belowRange" && e.quantity > 0);
  const aboveRange = evaluated.filter((e) => e.status === "aboveRange" && e.quantity > 0);
  const supportedXP = evaluated.reduce((sum, e) => sum + (e.subtotal ?? 0), 0);
  const creatureCount = evaluated.reduce((sum, e) => sum + e.quantity, 0);
  const complete = belowRange.length === 0 && aboveRange.length === 0;

  if (belowRange.length > 0)
    warnings.push({ code: "incompleteBelowRange", data: { ids: belowRange.map((e) => e.id) } });
  if (aboveRange.length > 0)
    warnings.push({ code: "incompleteAboveRange", data: { ids: aboveRange.map((e) => e.id) } });

  const tier = selectedThreat ? tierBudget(selectedThreat, partySize) : null;
  let difference: number | null = null;
  if (tier) {
    if (!tier.available) {
      warnings.push({ code: "threatUnavailable", data: { threat: tier.threat, target: tier.target } });
    } else {
      difference = supportedXP - tier.target;
      if (difference > 0) warnings.push({ code: "overBudget", data: { difference } });
      else if (difference < 0 && !tier.isCeiling)
        warnings.push({ code: "underBudget", data: { difference } });
    }
  }
  // Independent of the selected threat: the party-size caveat applies to every evaluation.
  if (partySize > LARGE_PARTY_THRESHOLD) warnings.push({ code: "largeParty", data: { partySize } });

  const inferred = inferThreat(supportedXP, partySize, {
    hasAboveRange: aboveRange.length > 0,
    hasBelowRange: belowRange.length > 0,
  });

  return {
    partySize,
    referenceLevel,
    selectedThreat,
    tier,
    entries: evaluated,
    creatureCount,
    supportedXP,
    complete,
    belowRange,
    aboveRange,
    difference,
    inferred,
    warnings,
  };
}

/* -------------------------------------------- */
/*  Reference level policies                    */
/* -------------------------------------------- */

export type ReferenceLevelPolicy = "uniform" | "averageFloor" | "highest" | "lowest" | "manual";

export interface ReferenceLevelResolution {
  /** Resolved level or null when no policy applies yet / inputs are invalid. */
  level: number | null;
  policy: ReferenceLevelPolicy | null;
  /** True when levels differ and the GM must choose a policy. */
  requiresChoice: boolean;
  /** True when the policy is an estimate rather than a rules-backed value. */
  isEstimate: boolean;
  distinctLevels: number[];
}

/**
 * Resolve a reference level from active character levels.
 * - All equal -> that level, policy "uniform" (any provided policy is ignored).
 * - Mixed -> requires an explicit policy; "manual" requires `manualLevel`.
 */
export function resolveReferenceLevel(
  levels: number[],
  policy: ReferenceLevelPolicy | null,
  manualLevel: number | null = null,
): ReferenceLevelResolution {
  const valid = levels.filter((l) => Number.isInteger(l));
  const distinctLevels = [...new Set(valid)].sort((a, b) => a - b);
  if (distinctLevels.length === 0) {
    return { level: null, policy: null, requiresChoice: false, isEstimate: false, distinctLevels };
  }
  if (distinctLevels.length === 1) {
    return {
      level: distinctLevels[0]!,
      policy: "uniform",
      requiresChoice: false,
      isEstimate: false,
      distinctLevels,
    };
  }
  switch (policy) {
    case "averageFloor": {
      const avg = Math.floor(valid.reduce((a, b) => a + b, 0) / valid.length);
      return { level: avg, policy, requiresChoice: false, isEstimate: true, distinctLevels };
    }
    case "highest":
      return {
        level: distinctLevels[distinctLevels.length - 1]!,
        policy,
        requiresChoice: false,
        isEstimate: false,
        distinctLevels,
      };
    case "lowest":
      return { level: distinctLevels[0]!, policy, requiresChoice: false, isEstimate: false, distinctLevels };
    case "manual":
      return {
        level: manualLevel !== null && isValidReferenceLevel(manualLevel) ? manualLevel : null,
        policy,
        requiresChoice: false,
        isEstimate: true,
        distinctLevels,
      };
    case "uniform":
    case null:
    default:
      return { level: null, policy: null, requiresChoice: true, isEstimate: false, distinctLevels };
  }
}
