/**
 * EncounterGenerator: bounded, enumerative, randomized constraint solving.
 *
 * 1. Subtract locked entries from the budget (fail if they exceed it).
 * 2. Exhaustively enumerate multisets of relative levels that fit (pruned, capped).
 * 3. Drop multisets the candidate pool cannot fill, including within the distinct-stat-block limits.
 * 4. Classify exact / near / under; pick randomly among the best class.
 * 5. Fill each level slot with a random eligible creature.
 *
 * Pure: no Foundry imports. RNG is injectable for reproducibility.
 */
import { tierBudget, xpForRelativeLevel, type ThreatLevel, type TierBudget } from "./budget.js";
import type { CompositionPreference } from "./schemas.js";
import { MAX_RELATIVE_LEVEL, MIN_RELATIVE_LEVEL } from "../rules/encounter-tables.js";
import { pickWeighted, shuffle, type Rng } from "./rng.js";

export interface GeneratorCandidate {
  uuid: string;
  name: string;
  level: number;
  traits: string[];
  img?: string | null;
  packLabel?: string | null;
}

export interface LockedEntry {
  uuid: string;
  name: string;
  level: number;
  quantity: number;
  traits?: string[];
  img?: string | null;
  packLabel?: string | null;
}

export interface GeneratorInput {
  threat: ThreatLevel;
  partySize: number;
  referenceLevel: number;
  /** Candidates already filtered by pack/trait/tag/rarity in the catalog. Level bounds are applied here. */
  candidates: GeneratorCandidate[];
  /** Relative level bounds (inclusive). Clamped to -4..+4. */
  relativeMin?: number;
  relativeMax?: number;
  /** Total creature count bounds (including locked entries). */
  minCount?: number;
  maxCount?: number;
  composition?: CompositionPreference;
  /** Maximum copies of one creature (including locked quantity). */
  duplicateCap?: number;
  excludeUuids?: string[];
  locked?: LockedEntry[];
  /** Minimum / maximum number of distinct stat blocks among generated (non-locked) creatures. */
  minDistinctCreatures?: number;
  maxDistinctCreatures?: number;
  rng?: Rng;
  /** Enumeration budget; reported as `capped` when hit. */
  maxEnumerated?: number;
}

export interface GeneratedEntry {
  uuid: string;
  name: string;
  level: number;
  relativeLevel: number;
  quantity: number;
  locked: boolean;
  traits: string[];
  img: string | null;
  packLabel: string | null;
}

export type FitClass = "exact" | "near" | "under";

export type GeneratorFailure =
  | "threatUnavailable"
  | "invalidParty"
  | "countRangeInvalid"
  | "lockedOutOfRange"
  | "lockedOverBudget"
  | "lockedViolatesComposition"
  | "emptyCatalog"
  | "noCandidatesInLevelBounds"
  | "noFeasibleComposition"
  | "enumerationCapped";

export interface GeneratorSuccess {
  ok: true;
  entries: GeneratedEntry[];
  fit: FitClass;
  totalXP: number;
  target: number;
  /** totalXP - target (<= 0 always, except never > 0). */
  difference: number;
  tier: TierBudget;
  explanation: string[];
  enumerated: number;
  capped: boolean;
  /** Number of feasible level-multisets found, for diagnostics. */
  feasibleMultisets: number;
}

export interface GeneratorFailureResult {
  ok: false;
  reason: GeneratorFailure;
  detail: Record<string, unknown>;
  enumerated: number;
  capped: boolean;
}

export type GeneratorResult = GeneratorSuccess | GeneratorFailureResult;

export const DEFAULT_MAX_ENUMERATED = 50_000;
export const DEFAULT_MAX_COUNT = 8;

/* -------------------------------------------- */
/*  Composition rules (hard constraints)        */
/* -------------------------------------------- */

/** Validate a full multiset of relative levels (locked + generated) against a composition preference. */
export function compositionSatisfied(relativeLevels: number[], composition: CompositionPreference): boolean {
  const n = relativeLevels.length;
  switch (composition) {
    case "unrestricted":
      return n >= 1;
    case "solo":
      return n === 1;
    case "pair":
      return n === 2;
    case "group":
      return n >= 3 && relativeLevels.every((r) => r <= 1);
    case "bossWithSupport": {
      if (n < 2) return false;
      const max = Math.max(...relativeLevels);
      const bosses = relativeLevels.filter((r) => r === max).length;
      if (bosses !== 1) return false;
      return relativeLevels.filter((r) => r !== max).every((r) => r <= max - 2);
    }
    case "warband": {
      // One leader strictly above 2+ troops.
      if (n < 3) return false;
      const max = Math.max(...relativeLevels);
      if (relativeLevels.filter((r) => r === max).length !== 1) return false;
      return relativeLevels.filter((r) => r !== max).every((r) => r <= max - 1);
    }
    case "mixedPatrol": {
      // 2–5 creatures within two levels of each other.
      if (n < 2 || n > 5) return false;
      return Math.max(...relativeLevels) - Math.min(...relativeLevels) <= 2;
    }
  }
}

/** Can the partial multiset still lead to a valid composition? Used for pruning. */
function compositionStillPossible(
  partial: number[],
  composition: CompositionPreference,
  maxTotal: number,
): boolean {
  const n = partial.length;
  switch (composition) {
    case "unrestricted":
      return true;
    case "solo":
      return n <= 1;
    case "pair":
      return n <= 2;
    case "group":
      return partial.every((r) => r <= 1) && maxTotal >= 3;
    case "bossWithSupport":
      // At most one creature may hold the current maximum; we validate fully at the leaf.
      return maxTotal >= 2;
    case "warband":
      return maxTotal >= 3;
    case "mixedPatrol":
      return n <= 5 && (n < 2 || Math.max(...partial) - Math.min(...partial) <= 2);
  }
}

/* -------------------------------------------- */
/*  Generator                                   */
/* -------------------------------------------- */

/**
 * Range of new distinct stat blocks that can fill `count` slots at one level, given the spare capacity of the
 * stat blocks already used at that level and the spare capacities of unused ones. Null when the level cannot
 * be filled at all. Every value in the range is achievable (one creature cannot span two levels, so levels
 * are independent).
 */
function newDistinctRange(
  count: number,
  reuseCapacity: number,
  freshCapacities: number[],
): { min: number; max: number } | null {
  if (count <= 0) return { min: 0, max: 0 };
  const sorted = freshCapacities.filter((c) => c > 0).sort((a, b) => b - a);
  let covered = reuseCapacity;
  let min = 0;
  while (covered < count) {
    if (min >= sorted.length) return null;
    covered += sorted[min]!;
    min++;
  }
  return { min, max: Math.min(count, sorted.length) };
}

interface LevelSlot {
  relative: number;
  xp: number;
  candidates: GeneratorCandidate[];
  /** Max creatures this level can supply given duplicate caps and locked usage. */
  capacity: number;
}

export function generateEncounter(input: GeneratorInput): GeneratorResult {
  const rng = input.rng ?? Math.random;
  const maxEnumerated = input.maxEnumerated ?? DEFAULT_MAX_ENUMERATED;
  const composition = input.composition ?? "unrestricted";
  const duplicateCap = Math.max(1, Math.floor(input.duplicateCap ?? 4));
  const relMin = Math.max(MIN_RELATIVE_LEVEL, input.relativeMin ?? MIN_RELATIVE_LEVEL);
  const relMax = Math.min(MAX_RELATIVE_LEVEL, input.relativeMax ?? MAX_RELATIVE_LEVEL);
  const minCount = Math.max(1, Math.floor(input.minCount ?? 1));
  const maxCount = Math.max(1, Math.floor(input.maxCount ?? DEFAULT_MAX_COUNT));
  const excluded = new Set(input.excludeUuids ?? []);
  const locked = (input.locked ?? []).filter((l) => l.quantity > 0);

  const fail = (
    reason: GeneratorFailure,
    detail: Record<string, unknown> = {},
    enumerated = 0,
    capped = false,
  ): GeneratorFailureResult => ({
    ok: false,
    reason,
    detail,
    enumerated,
    capped,
  });

  if (!Number.isInteger(input.partySize) || input.partySize < 1 || !Number.isInteger(input.referenceLevel)) {
    return fail("invalidParty", { partySize: input.partySize, referenceLevel: input.referenceLevel });
  }
  const tier = tierBudget(input.threat, input.partySize);
  if (!tier.available) return fail("threatUnavailable", { threat: input.threat, target: tier.target });
  if (minCount > maxCount) return fail("countRangeInvalid", { minCount, maxCount });

  // Locked entries.
  let lockedXP = 0;
  let lockedCount = 0;
  const lockedRelatives: number[] = [];
  const lockedUsage = new Map<string, number>();
  for (const entry of locked) {
    const rel = entry.level - input.referenceLevel;
    if (rel < MIN_RELATIVE_LEVEL || rel > MAX_RELATIVE_LEVEL) {
      return fail("lockedOutOfRange", { uuid: entry.uuid, name: entry.name, relativeLevel: rel });
    }
    lockedXP += xpForRelativeLevel(rel) * entry.quantity;
    lockedCount += entry.quantity;
    for (let i = 0; i < entry.quantity; i++) lockedRelatives.push(rel);
    lockedUsage.set(entry.uuid, (lockedUsage.get(entry.uuid) ?? 0) + entry.quantity);
  }
  const target = tier.target;
  if (lockedXP > target) return fail("lockedOverBudget", { lockedXP, target, overage: lockedXP - target });
  if (lockedCount > maxCount) return fail("countRangeInvalid", { lockedCount, maxCount });
  if (!compositionStillPossible(lockedRelatives, composition, maxCount)) {
    return fail("lockedViolatesComposition", { composition, lockedCount });
  }

  // Candidate pool by relative level.
  if (input.candidates.length === 0 && locked.length === 0) return fail("emptyCatalog");
  const slots: LevelSlot[] = [];
  for (let rel = relMax; rel >= relMin; rel--) {
    const candidates = input.candidates.filter(
      (c) => c.level - input.referenceLevel === rel && !excluded.has(c.uuid),
    );
    const capacity = candidates.reduce(
      (sum, c) => sum + Math.max(0, duplicateCap - (lockedUsage.get(c.uuid) ?? 0)),
      0,
    );
    if (candidates.length > 0 && capacity > 0)
      slots.push({ relative: rel, xp: xpForRelativeLevel(rel), candidates, capacity });
  }
  const remaining = target - lockedXP;
  const minAdd = Math.max(0, minCount - lockedCount);
  const maxAdd = maxCount - lockedCount;

  if (slots.length === 0 && minAdd > 0) {
    return input.candidates.length === 0
      ? fail("emptyCatalog")
      : fail("noCandidatesInLevelBounds", { relMin, relMax });
  }

  // Enumerate multisets: counts per slot.
  interface Multiset {
    counts: number[];
    xp: number;
    size: number;
  }
  const feasible: Multiset[] = [];
  let enumerated = 0;
  let capped = false;
  const counts = new Array<number>(slots.length).fill(0);

  const dfs = (slotIndex: number, xpSoFar: number, sizeSoFar: number): void => {
    if (capped) return;
    enumerated++;
    if (enumerated > maxEnumerated) {
      capped = true;
      return;
    }
    if (slotIndex === slots.length) {
      if (sizeSoFar < minAdd) return;
      const full = [...lockedRelatives];
      slots.forEach((slot, i) => {
        for (let k = 0; k < counts[i]!; k++) full.push(slot.relative);
      });
      if (full.length === 0) return;
      if (!compositionSatisfied(full, composition)) return;
      feasible.push({ counts: [...counts], xp: xpSoFar, size: sizeSoFar });
      return;
    }
    const slot = slots[slotIndex]!;
    const maxHere = Math.min(slot.capacity, maxAdd - sizeSoFar, Math.floor((remaining - xpSoFar) / slot.xp));
    for (let k = maxHere; k >= 0; k--) {
      counts[slotIndex] = k;
      const partial = [...lockedRelatives];
      for (let i = 0; i <= slotIndex; i++)
        for (let j = 0; j < counts[i]!; j++) partial.push(slots[i]!.relative);
      if (!compositionStillPossible(partial, composition, maxCount)) continue;
      dfs(slotIndex + 1, xpSoFar + k * slot.xp, sizeSoFar + k);
      if (capped) return;
    }
    counts[slotIndex] = 0;
  };
  dfs(0, 0, 0);

  if (feasible.length === 0) {
    return capped
      ? fail("enumerationCapped", { maxEnumerated }, enumerated, true)
      : fail(
          "noFeasibleComposition",
          {
            composition,
            minCount,
            maxCount,
            remaining,
            relMin,
            relMax,
            slots: slots.map((s) => ({ relative: s.relative, capacity: s.capacity })),
          },
          enumerated,
          false,
        );
  }

  // Distinct-count limits: drop multisets that cannot be filled within them, so the random pick below never
  // lands on a level mix the fill step would have to reject.
  const minDistinct = Math.max(0, Math.floor(input.minDistinctCreatures ?? 0));
  const maxDistinct = Math.max(1, Math.floor(input.maxDistinctCreatures ?? Number.MAX_SAFE_INTEGER));
  const spare = (c: GeneratorCandidate): number => Math.max(0, duplicateCap - (lockedUsage.get(c.uuid) ?? 0));
  // Per-level ranges depend only on the count at that level; cache them (there may be many multisets).
  const rangeCache = slots.map(() => new Map<number, ReturnType<typeof newDistinctRange>>());
  const slotRange = (i: number, count: number) => {
    const cache = rangeCache[i]!;
    if (!cache.has(count)) cache.set(count, newDistinctRange(count, 0, slots[i]!.candidates.map(spare)));
    return cache.get(count) ?? null;
  };
  const slotRanges = (m: Multiset) => m.counts.map((count, i) => slotRange(i, count));
  const distinctFeasible = (m: Multiset): boolean => {
    if (m.size === 0) return true;
    let lo = 0;
    let hi = 0;
    for (const range of slotRanges(m)) {
      if (!range) return false;
      lo += range.min;
      hi += range.max;
    }
    return lo <= maxDistinct && hi >= minDistinct;
  };
  const fillable = feasible.filter(distinctFeasible);
  if (fillable.length === 0) {
    return fail(
      "noFeasibleComposition",
      { stage: "distinct", composition, minDistinct, maxDistinct, feasibleMultisets: feasible.length },
      enumerated,
      capped,
    );
  }

  // Classify.
  const classify = (xp: number): FitClass => {
    const total = xp + lockedXP;
    if (total === target) return "exact";
    if (target - total <= tier.perCharacter) return "near";
    return "under";
  };
  const byClass: Record<FitClass, Multiset[]> = { exact: [], near: [], under: [] };
  for (const m of fillable) byClass[classify(m.xp)].push(m);
  const fit: FitClass = byClass.exact.length ? "exact" : byClass.near.length ? "near" : "under";
  // Under-budget results are only returned when nothing better exists, and then only the closest ones.
  let pool = byClass[fit];
  if (fit === "under") {
    const best = Math.max(...pool.map((m) => m.xp));
    pool = pool.filter((m) => m.xp === best);
  }

  // Soft preferences: closeness to target and level variety.
  const weight = (m: Multiset): number => {
    const distinct = m.counts.filter((c) => c > 0).length;
    const closeness = 1 / (1 + (remaining - m.xp) / Math.max(1, tier.perCharacter));
    return 0.25 + closeness + 0.5 * distinct;
  };
  const chosen = pickWeighted(rng, pool, weight);

  // Fill slots with concrete creatures.
  const usage = new Map<string, number>(lockedUsage);
  const chosenTraits = new Set<string>(locked.flatMap((l) => l.traits ?? []));
  const generated = new Map<string, GeneratedEntry>();
  const chosenRanges = slotRanges(chosen);
  const spareNow = (c: GeneratorCandidate): number => Math.max(0, duplicateCap - (usage.get(c.uuid) ?? 0));
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    // Distinct stat blocks later levels still need at least / can add at most (they are untouched so far).
    let futureMin = 0;
    let futureMax = 0;
    for (const range of chosenRanges.slice(i + 1)) {
      futureMin += range?.min ?? 0;
      futureMax += range?.max ?? 0;
    }
    for (let k = 0; k < chosen.counts[i]!; k++) {
      const rest = chosen.counts[i]! - k - 1;
      const used = slot.candidates.filter((c) => generated.has(c.uuid));
      const fresh = slot.candidates.filter((c) => !generated.has(c.uuid));
      const reuseCapacity = used.reduce((sum, c) => sum + spareNow(c), 0);
      // Hard distinct-count constraints: only allow a pick that still leaves a way to finish within
      // min/max distinct. Reuse picks all look alike; new picks differ only by their spare capacity.
      const keepsFeasible = (distinct: number, range: { min: number; max: number } | null): boolean =>
        range !== null &&
        distinct + range.min + futureMin <= maxDistinct &&
        distinct + range.max + futureMax >= minDistinct;
      const reuseOk = keepsFeasible(
        generated.size,
        newDistinctRange(rest, reuseCapacity - 1, fresh.map(spareNow)),
      );
      const freshOk = new Map<number, boolean>();
      const freshAllowed = (cap: number): boolean => {
        let ok = freshOk.get(cap);
        if (ok === undefined) {
          const others = fresh.map(spareNow);
          others.splice(others.indexOf(cap), 1);
          ok = keepsFeasible(generated.size + 1, newDistinctRange(rest, reuseCapacity + cap - 1, others));
          freshOk.set(cap, ok);
        }
        return ok;
      };
      const eligible = slot.candidates.filter((c) => {
        const cap = spareNow(c);
        if (cap <= 0) return false;
        return generated.has(c.uuid) ? reuseOk : freshAllowed(cap);
      });
      if (eligible.length === 0) {
        return fail(
          "noFeasibleComposition",
          { stage: "fill", relative: slot.relative, minDistinct, maxDistinct },
          enumerated,
          capped,
        );
      }
      // Soft preference: share traits with what is already chosen, and reuse stat blocks already in use.
      const creature = pickWeighted(rng, shuffle(rng, eligible), (c) => {
        const shared = c.traits.filter((t) => chosenTraits.has(t)).length;
        const reuse = usage.has(c.uuid) ? 1 : 0;
        return 1 + 0.5 * shared + reuse;
      });
      usage.set(creature.uuid, (usage.get(creature.uuid) ?? 0) + 1);
      for (const t of creature.traits) chosenTraits.add(t);
      const existing = generated.get(creature.uuid);
      if (existing) existing.quantity++;
      else {
        generated.set(creature.uuid, {
          uuid: creature.uuid,
          name: creature.name,
          level: creature.level,
          relativeLevel: slot.relative,
          quantity: 1,
          locked: false,
          traits: creature.traits,
          img: creature.img ?? null,
          packLabel: creature.packLabel ?? null,
        });
      }
    }
  }

  const entries: GeneratedEntry[] = [
    ...locked.map((l) => ({
      uuid: l.uuid,
      name: l.name,
      level: l.level,
      relativeLevel: l.level - input.referenceLevel,
      quantity: l.quantity,
      locked: true,
      traits: l.traits ?? [],
      img: l.img ?? null,
      packLabel: l.packLabel ?? null,
    })),
    ...generated.values(),
  ];
  const totalXP = chosen.xp + lockedXP;
  const explanation: string[] = [];
  explanation.push(`fit:${fit}`);
  if (fit !== "exact") explanation.push(`shortfall:${target - totalXP}`);
  if (capped) explanation.push("enumerationCapped");
  explanation.push(`feasible:${fillable.length}`);

  return {
    ok: true,
    entries,
    fit,
    totalXP,
    target,
    difference: totalXP - target,
    tier,
    explanation,
    enumerated,
    capped,
    feasibleMultisets: fillable.length,
  };
}

/* -------------------------------------------- */
/*  Hard-constraint checker (for tests/debug)   */
/* -------------------------------------------- */

export function hardConstraintViolations(input: GeneratorInput, result: GeneratorSuccess): string[] {
  const violations: string[] = [];
  const composition = input.composition ?? "unrestricted";
  const duplicateCap = Math.max(1, Math.floor(input.duplicateCap ?? 4));
  const relMin = Math.max(MIN_RELATIVE_LEVEL, input.relativeMin ?? MIN_RELATIVE_LEVEL);
  const relMax = Math.min(MAX_RELATIVE_LEVEL, input.relativeMax ?? MAX_RELATIVE_LEVEL);
  const minCount = Math.max(1, Math.floor(input.minCount ?? 1));
  const maxCount = Math.max(1, Math.floor(input.maxCount ?? DEFAULT_MAX_COUNT));
  const excluded = new Set(input.excludeUuids ?? []);
  const candidateUuids = new Set(input.candidates.map((c) => c.uuid));

  const total = result.entries.reduce((s, e) => s + e.quantity, 0);
  if (total < minCount || total > maxCount)
    violations.push(`count ${total} outside ${minCount}..${maxCount}`);
  if (result.totalXP > result.target)
    violations.push(`total ${result.totalXP} exceeds target ${result.target}`);
  const relatives: number[] = [];
  for (const e of result.entries) {
    const rel = e.level - input.referenceLevel;
    for (let i = 0; i < e.quantity; i++) relatives.push(rel);
    if (rel < MIN_RELATIVE_LEVEL || rel > MAX_RELATIVE_LEVEL)
      violations.push(`${e.name} relative ${rel} outside table`);
    if (!e.locked) {
      if (rel < relMin || rel > relMax)
        violations.push(`${e.name} relative ${rel} outside bounds ${relMin}..${relMax}`);
      if (excluded.has(e.uuid)) violations.push(`${e.name} is excluded`);
      if (!candidateUuids.has(e.uuid)) violations.push(`${e.name} not in candidate pool`);
    }
  }
  // Duplicate cap: generated copies may only fill up to the cap; locked quantities are preserved as-is.
  const perUuid = new Map<string, { locked: number; generated: number }>();
  for (const e of result.entries) {
    const row = perUuid.get(e.uuid) ?? { locked: 0, generated: 0 };
    if (e.locked) row.locked += e.quantity;
    else row.generated += e.quantity;
    perUuid.set(e.uuid, row);
  }
  for (const [uuid, row] of perUuid) {
    if (row.generated > 0 && row.locked + row.generated > duplicateCap) {
      violations.push(`${uuid} total ${row.locked + row.generated} exceeds duplicate cap ${duplicateCap}`);
    }
  }
  for (const l of input.locked ?? []) {
    const found = result.entries.find((e) => e.uuid === l.uuid && e.locked);
    if (!found || found.quantity !== l.quantity) violations.push(`locked ${l.name} not preserved`);
  }
  if (!compositionSatisfied(relatives, composition))
    violations.push(`composition ${composition} not satisfied`);
  const distinctGenerated = new Set(result.entries.filter((e) => !e.locked).map((e) => e.uuid)).size;
  if (distinctGenerated > 0) {
    if (input.minDistinctCreatures && distinctGenerated < input.minDistinctCreatures)
      violations.push(`distinct ${distinctGenerated} below minimum ${input.minDistinctCreatures}`);
    if (input.maxDistinctCreatures && distinctGenerated > input.maxDistinctCreatures)
      violations.push(`distinct ${distinctGenerated} above maximum ${input.maxDistinctCreatures}`);
  }
  const sum = relatives.reduce((s, r) => s + xpForRelativeLevel(r), 0);
  if (sum !== result.totalXP) violations.push(`reported total ${result.totalXP} != recomputed ${sum}`);
  return violations;
}
