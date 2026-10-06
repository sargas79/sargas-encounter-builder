import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compositionSatisfied,
  generateEncounter,
  hardConstraintViolations,
  type GeneratorCandidate,
  type GeneratorInput,
} from "../src/core/generator.js";
import { mulberry32, rngFromSeed } from "../src/core/rng.js";

function candidate(uuid: string, level: number, traits: string[] = []): GeneratorCandidate {
  return { uuid, name: uuid, level, traits };
}

/** One creature at every level 1..9 (relative -4..+4 for reference level 5). */
function fullPool(): GeneratorCandidate[] {
  return Array.from({ length: 9 }, (_, i) => candidate(`c${i + 1}`, i + 1, i % 2 ? ["beast"] : ["humanoid"]));
}

const base = (): GeneratorInput => ({
  threat: "moderate",
  partySize: 4,
  referenceLevel: 5,
  candidates: fullPool(),
  rng: mulberry32(1),
});

describe("T9: generation outcomes terminate correctly", () => {
  it("finds an exact fit when one exists", () => {
    const result = generateEncounter(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fit).toBe("exact");
    expect(result.totalXP).toBe(80);
    expect(result.difference).toBe(0);
    expect(hardConstraintViolations(base(), result)).toEqual([]);
  });

  it("returns a near fit with its difference when no exact fit exists", () => {
    // Only level-7 creatures (+2 = 80 XP each) with a 100 XP target (5 PCs): 80 is within the 20 XP tolerance.
    const input: GeneratorInput = { ...base(), partySize: 5, candidates: [candidate("a", 7)] };
    const result = generateEncounter(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fit).toBe("near");
    expect(result.totalXP).toBe(80);
    expect(result.difference).toBe(-20);
    expect(result.explanation).toContain("shortfall:20");
  });

  it("returns an under-budget result, labeled, when nothing closer exists", () => {
    // Only -4 creatures (10 XP) capped at 1 copy and max 3 creatures: best is 30 XP vs 80 target.
    const input: GeneratorInput = {
      ...base(),
      candidates: [candidate("w1", 1), candidate("w2", 1), candidate("w3", 1)],
      duplicateCap: 1,
      maxCount: 3,
    };
    const result = generateEncounter(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fit).toBe("under");
    expect(result.totalXP).toBe(30);
    expect(result.difference).toBe(-50);
  });

  it("reports impossible constraints explicitly instead of loosening them", () => {
    // Solo composition but every candidate is too cheap to be alone at 80 XP? Solo allows under-budget, so use
    // a composition that cannot be satisfied: "group" needs 3+ creatures at <= +1 but the pool is only +3.
    const input: GeneratorInput = { ...base(), candidates: [candidate("big", 8)], composition: "group" };
    const result = generateEncounter(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("noFeasibleComposition");
    expect(result.detail.composition).toBe("group");
  });

  it("fails when locked entries exceed the budget, reporting the overage", () => {
    const input: GeneratorInput = {
      ...base(),
      locked: [{ uuid: "boss", name: "Boss", level: 9, quantity: 1 }],
    };
    const result = generateEncounter(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("lockedOverBudget");
    expect(result.detail).toMatchObject({ lockedXP: 160, target: 80, overage: 80 });
  });

  it("fails when a locked entry is outside the XP table", () => {
    const input: GeneratorInput = {
      ...base(),
      locked: [{ uuid: "god", name: "God", level: 15, quantity: 1 }],
    };
    const result = generateEncounter(input);
    expect(result).toMatchObject({ ok: false, reason: "lockedOutOfRange" });
  });

  it("preserves locked entries and fills the remaining budget around them", () => {
    const input: GeneratorInput = { ...base(), locked: [{ uuid: "c5", name: "c5", level: 5, quantity: 1 }] };
    const result = generateEncounter(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.find((e) => e.uuid === "c5" && e.locked)?.quantity).toBe(1);
    expect(result.totalXP).toBe(80);
    expect(hardConstraintViolations(input, result)).toEqual([]);
  });

  it("fails on an empty catalog", () => {
    expect(generateEncounter({ ...base(), candidates: [] })).toMatchObject({
      ok: false,
      reason: "emptyCatalog",
    });
  });

  it("fails when no candidate is inside the level bounds", () => {
    const result = generateEncounter({
      ...base(),
      relativeMin: 3,
      relativeMax: 4,
      candidates: [candidate("x", 5)],
    });
    expect(result).toMatchObject({ ok: false, reason: "noCandidatesInLevelBounds" });
  });

  it("refuses unavailable threats and invalid count ranges", () => {
    expect(generateEncounter({ ...base(), partySize: 1, threat: "low" })).toMatchObject({
      ok: false,
      reason: "threatUnavailable",
    });
    expect(generateEncounter({ ...base(), minCount: 5, maxCount: 2 })).toMatchObject({
      ok: false,
      reason: "countRangeInvalid",
    });
  });

  it("stops at the enumeration cap and reports it", () => {
    const pool = Array.from({ length: 40 }, (_, i) => candidate(`p${i}`, 1 + (i % 9)));
    const result = generateEncounter({ ...base(), candidates: pool, maxCount: 12, maxEnumerated: 25 });
    expect(result.capped).toBe(true);
    expect(result.enumerated).toBeLessThanOrEqual(26);
    if (result.ok) expect(result.explanation).toContain("enumerationCapped");
    else expect(result.reason).toBe("enumerationCapped");
  });

  it("treats trivial as a ceiling and still prefers results close to it", () => {
    const result = generateEncounter({ ...base(), threat: "trivial" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalXP).toBeLessThanOrEqual(40);
    expect(result.fit).toBe("exact");
  });

  it("supports every composition preference", () => {
    for (const composition of ["solo", "pair", "group", "bossWithSupport", "unrestricted"] as const) {
      const input: GeneratorInput = { ...base(), composition, threat: "severe", rng: mulberry32(7) };
      const result = generateEncounter(input);
      expect(result.ok, composition).toBe(true);
      if (result.ok) expect(hardConstraintViolations(input, result), composition).toEqual([]);
    }
  });

  it("composition rules", () => {
    expect(compositionSatisfied([0], "solo")).toBe(true);
    expect(compositionSatisfied([0, 0], "solo")).toBe(false);
    expect(compositionSatisfied([1, -1], "pair")).toBe(true);
    expect(compositionSatisfied([1, 1, 1], "group")).toBe(true);
    expect(compositionSatisfied([2, 1, 1], "group")).toBe(false);
    expect(compositionSatisfied([2, 0, 0], "bossWithSupport")).toBe(true);
    expect(compositionSatisfied([2, 1], "bossWithSupport")).toBe(false);
    expect(compositionSatisfied([2, 2, 0], "bossWithSupport")).toBe(false);
    expect(compositionSatisfied([2], "bossWithSupport")).toBe(false);
  });
});

describe("T10: seeded generation is reproducible and all hard constraints hold", () => {
  it("produces identical results for the same seed and inputs", () => {
    const a = generateEncounter({ ...base(), rng: rngFromSeed("alpha") });
    const b = generateEncounter({ ...base(), rng: rngFromSeed("alpha") });
    const c = generateEncounter({ ...base(), rng: rngFromSeed("beta") });
    expect(a).toEqual(b);
    expect(a.ok && c.ok).toBe(true);
    // Different seeds usually differ; at minimum they must both be valid.
    if (a.ok && c.ok) expect(hardConstraintViolations(base(), c)).toEqual([]);
  });

  it("varies between runs with an unseeded RNG while staying valid", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const input = { ...base(), rng: mulberry32(100 + i) };
      const result = generateEncounter(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(hardConstraintViolations(input, result)).toEqual([]);
        seen.add(
          result.entries
            .map((e) => `${e.uuid}x${e.quantity}`)
            .sort()
            .join(","),
        );
      }
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("holds every hard constraint across random inputs (property test)", () => {
    const candidateArb = fc
      .array(
        fc.record({
          level: fc.integer({ min: 1, max: 12 }),
          trait: fc.constantFrom("beast", "undead", "humanoid", "fey"),
        }),
        { minLength: 0, maxLength: 20 },
      )
      .map((rows) => rows.map((r, i) => candidate(`cand${i}`, r.level, [r.trait])));
    const lockedArb = fc
      .array(fc.record({ level: fc.integer({ min: 2, max: 9 }), quantity: fc.integer({ min: 1, max: 2 }) }), {
        maxLength: 2,
      })
      .map((rows) =>
        rows.map((r, i) => ({ uuid: `lock${i}`, name: `lock${i}`, level: r.level, quantity: r.quantity })),
      );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom("trivial", "low", "moderate", "severe", "extreme"),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 3, max: 8 }),
        candidateArb,
        lockedArb,
        fc.constantFrom("unrestricted", "solo", "pair", "group", "bossWithSupport"),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: -4, max: 4 }),
        fc.integer({ min: -4, max: 4 }),
        (
          seed,
          threat,
          partySize,
          referenceLevel,
          candidates,
          locked,
          composition,
          duplicateCap,
          minCount,
          extraCount,
          relA,
          relB,
        ) => {
          const input: GeneratorInput = {
            threat,
            partySize,
            referenceLevel,
            candidates,
            locked,
            composition,
            duplicateCap,
            minCount,
            maxCount: minCount + extraCount,
            relativeMin: Math.min(relA, relB),
            relativeMax: Math.max(relA, relB),
            excludeUuids: candidates.length > 3 ? [candidates[0]!.uuid] : [],
            rng: mulberry32(seed),
            maxEnumerated: 5_000,
          };
          const result = generateEncounter(input);
          if (result.ok) {
            expect(hardConstraintViolations(input, result)).toEqual([]);
            // Reproducible.
            expect(generateEncounter({ ...input, rng: mulberry32(seed) })).toEqual(result);
          } else {
            expect(typeof result.reason).toBe("string");
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("distinct-creature limits are respected when choosing a level mix", () => {
  it("never fails with maxDistinct 1 when a single-creature mix exists (seed sweep)", () => {
    // 0, -1, -2, -2 relative to level 5. A mixed-level multiset (e.g. 0 + -1 + -2) cannot be filled with one
    // stat block; the solver must pick a single-level mix such as 2x level 5 instead of failing.
    const candidates = [candidate("l5", 5), candidate("l4", 4), candidate("l3a", 3), candidate("l3b", 3)];
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const input: GeneratorInput = {
          ...base(),
          candidates,
          maxDistinctCreatures: 1,
          rng: mulberry32(seed),
        };
        const result = generateEncounter(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(hardConstraintViolations(input, result)).toEqual([]);
          expect(result.entries).toHaveLength(1);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("never fails with minDistinct 2 when only one creature exists at some level (seed sweep)", () => {
    // A single stat block at -2 cannot supply two distinct creatures on its own; mixes that need that are skipped.
    const candidates = [candidate("solo-2", 3), candidate("p1", 4), candidate("p2", 5)];
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const input: GeneratorInput = {
          ...base(),
          candidates,
          composition: "mixedPatrol",
          minDistinctCreatures: 2,
          rng: mulberry32(seed),
        };
        const result = generateEncounter(input);
        expect(result.ok).toBe(true);
        if (result.ok) expect(hardConstraintViolations(input, result)).toEqual([]);
        return true;
      }),
      { numRuns: 300 },
    );
    // Only one stat block in the pool at all: the minimum is unreachable and reported, not loosened.
    const impossible = generateEncounter({
      ...base(),
      candidates: [candidate("solo-2", 3)],
      composition: "mixedPatrol",
      minDistinctCreatures: 2,
    });
    expect(impossible.ok).toBe(false);
    if (!impossible.ok) expect(impossible.reason).toBe("noFeasibleComposition");
  });

  it("keeps a feasible way to finish when filling several levels under maxDistinct 2", () => {
    const candidates = [candidate("a1", 5), candidate("a2", 5), candidate("b1", 3), candidate("b2", 3)];
    for (let seed = 1; seed <= 200; seed++) {
      const input: GeneratorInput = {
        ...base(),
        candidates,
        minCount: 3,
        maxDistinctCreatures: 2,
        duplicateCap: 2,
        rng: mulberry32(seed),
      };
      const result = generateEncounter(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(hardConstraintViolations(input, result)).toEqual([]);
    }
  });
});
