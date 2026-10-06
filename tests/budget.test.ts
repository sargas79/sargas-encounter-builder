import { describe, expect, it } from "vitest";
import {
  budgetsForParty,
  creatureXP,
  evaluateEncounter,
  inferThreat,
  resolveReferenceLevel,
  targetBudget,
  tierBudget,
  validatePartyInputs,
  xpForRelativeLevel,
} from "../src/core/budget.js";
import { THREAT_LEVELS } from "../src/rules/encounter-tables.js";
import { emptyDraft, evaluateDraft, type Draft } from "../src/core/draft.js";

describe("T1: four same-level PCs yield standard budgets", () => {
  it.each([
    ["trivial", 40],
    ["low", 60],
    ["moderate", 80],
    ["severe", 120],
    ["extreme", 160],
  ] as const)("%s = %i XP", (threat, expected) => {
    expect(targetBudget(threat, 4)).toBe(expected);
    expect(tierBudget(threat, 4).available).toBe(true);
  });

  it("marks only trivial as a ceiling", () => {
    const b = budgetsForParty(4);
    expect(b.trivial.isCeiling).toBe(true);
    for (const t of THREAT_LEVELS.filter((x) => x !== "trivial")) expect(b[t].isCeiling).toBe(false);
  });
});

describe("T2: five level-4 PCs", () => {
  it("have a Moderate target of 100 XP", () => {
    expect(targetBudget("moderate", 5)).toBe(100);
  });

  it("two level-4 creatures and one level-2 creature total 100 XP, complete, inferred Moderate", () => {
    const evaluation = evaluateEncounter({
      partySize: 5,
      referenceLevel: 4,
      selectedThreat: "moderate",
      entries: [
        { id: "a", level: 4, quantity: 2 },
        { id: "b", level: 2, quantity: 1 },
      ],
    });
    expect(evaluation.supportedXP).toBe(100);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.difference).toBe(0);
    expect(evaluation.inferred.label).toBe("moderate");
    expect(evaluation.warnings).toEqual([]);
  });

  it("adjusts every tier by its per-character value", () => {
    expect(targetBudget("trivial", 5)).toBe(50);
    expect(targetBudget("low", 5)).toBe(80);
    expect(targetBudget("severe", 5)).toBe(150);
    expect(targetBudget("extreme", 5)).toBe(200);
    expect(targetBudget("severe", 3)).toBe(90);
  });
});

describe("T5: creature XP by relative level", () => {
  it.each([
    [-4, 10],
    [-3, 15],
    [-2, 20],
    [-1, 30],
    [0, 40],
    [1, 60],
    [2, 80],
    [3, 120],
    [4, 160],
  ])("relative %i = %i XP", (relative, xp) => {
    expect(xpForRelativeLevel(relative)).toBe(xp);
    expect(creatureXP(5 + relative, 5)).toEqual({ relativeLevel: relative, xp, status: "supported" });
  });

  it("marks -5 as below range and +5 as above range, never clamping or extrapolating", () => {
    expect(creatureXP(0, 5)).toEqual({ relativeLevel: -5, xp: null, status: "belowRange" });
    expect(creatureXP(10, 5)).toEqual({ relativeLevel: 5, xp: null, status: "aboveRange" });
    expect(() => xpForRelativeLevel(5)).toThrow(RangeError);
  });

  it("produces an incomplete evaluation with out-of-range entries listed, counting only supported XP", () => {
    const evaluation = evaluateEncounter({
      partySize: 4,
      referenceLevel: 5,
      selectedThreat: "moderate",
      entries: [
        { id: "ok", level: 5, quantity: 1 },
        { id: "weak", level: 0, quantity: 3 },
        { id: "boss", level: 10, quantity: 1 },
      ],
    });
    expect(evaluation.complete).toBe(false);
    expect(evaluation.supportedXP).toBe(40);
    expect(evaluation.belowRange.map((e) => e.id)).toEqual(["weak"]);
    expect(evaluation.aboveRange.map((e) => e.id)).toEqual(["boss"]);
    expect(evaluation.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["incompleteBelowRange", "incompleteAboveRange"]),
    );
    expect(evaluation.inferred).toEqual({
      label: "beyondExtreme",
      unquantified: true,
      incompleteNegligible: true,
    });
  });

  it("flags below-range-only evaluations as incompleteNegligible but still infers from supported XP", () => {
    const evaluation = evaluateEncounter({
      partySize: 4,
      referenceLevel: 10,
      entries: [
        { id: "ok", level: 10, quantity: 2 },
        { id: "rat", level: 0, quantity: 10 },
      ],
    });
    expect(evaluation.inferred).toEqual({
      label: "moderate",
      unquantified: false,
      incompleteNegligible: true,
    });
  });
});

describe("T6: small parties and invalid budgets", () => {
  it("makes Low unavailable for a single character (60 - 3*20 = 0)", () => {
    const b = budgetsForParty(1);
    expect(b.low.target).toBe(0);
    expect(b.low.available).toBe(false);
    expect(b.trivial.target).toBe(10);
    expect(b.trivial.available).toBe(true);
    expect(b.moderate.target).toBe(20);
    expect(b.severe.target).toBe(30);
    expect(b.extreme.target).toBe(40);
  });

  it("reports an unavailable threat instead of a negative difference", () => {
    const evaluation = evaluateEncounter({
      partySize: 1,
      referenceLevel: 3,
      selectedThreat: "low",
      entries: [],
    });
    expect(evaluation.difference).toBeNull();
    expect(evaluation.warnings.map((w) => w.code)).toContain("threatUnavailable");
  });

  it("rejects empty parties and invalid reference levels before evaluation", () => {
    expect(validatePartyInputs(0, 5).map((e) => e.code)).toEqual(["partyEmpty"]);
    expect(validatePartyInputs(-1, 5).map((e) => e.code)).toEqual(["partySizeInvalid"]);
    expect(validatePartyInputs(4, 0).map((e) => e.code)).toEqual(["referenceLevelInvalid"]);
    expect(validatePartyInputs(4, 21).map((e) => e.code)).toEqual(["referenceLevelInvalid"]);
    expect(validatePartyInputs(4, 2.5).map((e) => e.code)).toEqual(["referenceLevelInvalid"]);
    expect(validatePartyInputs(4, null).map((e) => e.code)).toEqual(["referenceLevelInvalid"]);
    expect(validatePartyInputs(4, 5)).toEqual([]);
    expect(() => evaluateEncounter({ partySize: 0, referenceLevel: 5, entries: [] })).toThrow();
    expect(() => evaluateEncounter({ partySize: 4, referenceLevel: 0, entries: [] })).toThrow();
  });

  it("flags large parties", () => {
    expect(tierBudget("moderate", 9).largeParty).toBe(true);
    expect(tierBudget("moderate", 8).largeParty).toBe(false);
  });

  it("emits the largeParty warning with or without a selected threat", () => {
    const codes = (selectedThreat: "moderate" | null, partySize: number) =>
      evaluateEncounter({ partySize, referenceLevel: 3, selectedThreat, entries: [] }).warnings.map(
        (w) => w.code,
      );
    expect(codes(null, 9)).toContain("largeParty");
    expect(codes("moderate", 9).filter((c) => c === "largeParty")).toHaveLength(1);
    expect(codes(null, 8)).not.toContain("largeParty");
  });
});

describe("T7: inferred threat algorithm", () => {
  const party = 4;
  it.each([
    [0, "trivial"],
    [10, "trivial"],
    [40, "trivial"],
    [41, "low"],
    [60, "low"],
    [61, "moderate"],
    [80, "moderate"],
    [81, "severe"],
    [90, "severe"],
    [120, "severe"],
    [121, "extreme"],
    [160, "extreme"],
    [161, "beyondExtreme"],
    [400, "beyondExtreme"],
  ])("%i XP for four PCs -> %s", (xp, label) => {
    const inferred = inferThreat(xp, party);
    expect(inferred.label).toBe(label);
    expect(inferred.unquantified).toBe(false);
  });

  it("is beyondExtreme and unquantified when a creature above +4 is present, regardless of XP", () => {
    expect(inferThreat(10, 4, { hasAboveRange: true })).toEqual({
      label: "beyondExtreme",
      unquantified: true,
      incompleteNegligible: false,
    });
  });

  it("skips unavailable tiers for small parties", () => {
    // Party of 1: trivial 10, low unavailable, moderate 20, severe 30, extreme 40.
    expect(inferThreat(15, 1).label).toBe("moderate");
    expect(inferThreat(10, 1).label).toBe("trivial");
    expect(inferThreat(41, 1).label).toBe("beyondExtreme");
  });

  it("distinguishes inferred from selected threat in evaluation output", () => {
    const evaluation = evaluateEncounter({
      partySize: 4,
      referenceLevel: 3,
      selectedThreat: "low",
      entries: [{ id: "x", level: 3, quantity: 3 }],
    });
    expect(evaluation.selectedThreat).toBe("low");
    expect(evaluation.inferred.label).toBe("severe");
    expect(evaluation.difference).toBe(60);
    expect(evaluation.warnings.map((w) => w.code)).toContain("overBudget");
  });
});

describe("reference level policies", () => {
  it("uses the shared level automatically when all levels match", () => {
    expect(resolveReferenceLevel([5, 5, 5], null)).toMatchObject({
      level: 5,
      policy: "uniform",
      requiresChoice: false,
    });
  });

  it("requires a choice for mixed levels", () => {
    expect(resolveReferenceLevel([4, 5, 6], null)).toMatchObject({ level: null, requiresChoice: true });
    expect(resolveReferenceLevel([4, 5, 6], "uniform")).toMatchObject({ level: null, requiresChoice: true });
  });

  it("applies each policy", () => {
    expect(resolveReferenceLevel([4, 5, 7], "averageFloor")).toMatchObject({ level: 5, isEstimate: true });
    expect(resolveReferenceLevel([4, 5, 7], "highest")).toMatchObject({ level: 7 });
    expect(resolveReferenceLevel([4, 5, 7], "lowest")).toMatchObject({ level: 4 });
    expect(resolveReferenceLevel([4, 5, 7], "manual", 6)).toMatchObject({ level: 6, isEstimate: true });
    expect(resolveReferenceLevel([4, 5, 7], "manual", 25)).toMatchObject({ level: null });
    expect(resolveReferenceLevel([4, 5, 7], "manual", null)).toMatchObject({ level: null });
  });

  it("returns null with no levels", () => {
    expect(resolveReferenceLevel([], "highest")).toMatchObject({ level: null, requiresChoice: false });
  });
});

describe("evaluateDraft under Proficiency Without Level", () => {
  const draft = (levels: number[]): Draft => ({
    ...emptyDraft(),
    entries: levels.map((level, i) => ({
      uuid: `Compendium.p.Actor.c${i}`,
      name: `C${i}`,
      level,
      quantity: 1,
      locked: false,
      img: null,
      packLabel: null,
      traits: [],
    })),
  });
  // A system helper that prices relative levels -6..+6 and refuses anything else.
  const helper = (ref: number, lvl: number) => (Math.abs(lvl - ref) <= 6 ? 40 + (lvl - ref) * 10 : null);

  it("delegates per-creature XP to the system and stays complete when everything is priced", () => {
    const ev = evaluateDraft(draft([5, 10]), {
      partySize: 4,
      referenceLevel: 5,
      selectedThreat: "moderate",
      pwol: true,
      pwolCreatureXP: helper,
    });
    expect(ev.systemCalculation).toBe(true);
    expect(ev.complete).toBe(true);
    expect(ev.supportedXP).toBe(40 + 90);
  });

  it("marks creatures the system cannot price as unsupported instead of counting 0 XP", () => {
    const ev = evaluateDraft(draft([12, 20, 0]), {
      partySize: 4,
      referenceLevel: 12,
      selectedThreat: "moderate",
      pwol: true,
      pwolCreatureXP: helper,
    });
    expect(ev.complete).toBe(false);
    expect(ev.supportedXP).toBe(40);
    expect(ev.aboveRange.map((e) => e.level)).toEqual([20]);
    expect(ev.belowRange.map((e) => e.level)).toEqual([0]);
    expect(ev.entries.find((e) => e.level === 20)).toMatchObject({ xpEach: null, subtotal: null });
    expect(ev.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["incompleteAboveRange", "incompleteBelowRange"]),
    );
    expect(ev.inferred.unquantified).toBe(true);
  });
});
