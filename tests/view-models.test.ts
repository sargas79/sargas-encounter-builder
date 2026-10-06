import { describe, expect, it } from "vitest";
import type { ThreatLevel } from "../src/core/budget.js";
import { evaluateDraft, type DraftEntry, type DraftEvaluation } from "../src/core/draft.js";
import { inferredThreatLabel, meterContext } from "../src/apps/view-models.js";

// Outside Foundry `t()` returns the full key, so labels are asserted as keys.
const K = "sargas-encounter-builder";

function creature(level: number, quantity = 1): DraftEntry {
  return {
    uuid: `Actor.l${level}`,
    name: `Level ${level}`,
    level,
    quantity,
    locked: false,
    img: null,
    packLabel: null,
    traits: [],
  };
}

/** Party of four at level 1: trivial 40, low 60, moderate 80, severe 120, extreme 160 XP. */
function evaluate(entries: DraftEntry[], selectedThreat: ThreatLevel = "moderate"): DraftEvaluation {
  return evaluateDraft(
    { entries, origin: "manual" },
    { partySize: 4, referenceLevel: 1, selectedThreat, pwol: false },
  );
}

type Tier = { threat: string; label: string; target: number; left: number; selected: boolean; row: number };

describe("meterContext", () => {
  it("places five tiers on a scale reaching 15% past extreme", () => {
    const meter = meterContext(evaluate([creature(1)]));
    const tiers = meter.tiers as Tier[];
    expect(tiers.map((tier) => tier.threat)).toEqual(["trivial", "low", "moderate", "severe", "extreme"]);
    expect(tiers.map((tier) => tier.target)).toEqual([40, 60, 80, 120, 160]);
    expect(tiers[2]!.label).toBe(`${K}.threat.moderate`);
    expect(tiers.filter((tier) => tier.selected).map((tier) => tier.threat)).toEqual(["moderate"]);
    expect(tiers[4]!.left).toBeCloseTo(100 / 1.15, 5);
    expect(meter.fill).toBeCloseTo((40 / 184) * 100, 5);
    expect(meter.target).toBe(80);
    expect(meter.targetLeft).toBeCloseTo((80 / 184) * 100, 5);
  });

  it("drops a label that would collide with its neighbour onto the second row", () => {
    const meter = meterContext(evaluate([creature(1)]));
    // trivial (21.7%) and low (32.6%) sit closer than the 16% gap.
    expect((meter.tiers as Tier[]).map((tier) => tier.row)).toEqual([0, 1, 0, 0, 0]);
    expect(meter.staggered).toBe(true);
  });

  it("marks an exact hit", () => {
    const meter = meterContext(evaluate([creature(1, 2)]));
    expect(meter.supportedXP).toBe(80);
    expect(meter.difference).toBe(0);
    expect(meter.differenceLabel).toBe("0");
    expect(meter.over).toBe(false);
    expect(meter.stateClass).toBe("is-exact");
    expect(meter.inferredLabel).toBe(`${K}.threat.moderate`);
    expect(meter.selectedLabel).toBe(`${K}.threat.moderate`);
  });

  it("marks an over-budget draft and signs the difference", () => {
    const meter = meterContext(evaluate([creature(1, 3)]));
    expect(meter.difference).toBe(40);
    expect(meter.differenceLabel).toBe("+40");
    expect(meter.over).toBe(true);
    expect(meter.stateClass).toBe("is-over");
    expect((meter.warnings as { level: string; text: string }[]).map((w) => w.level)).toContain("warn");
  });

  it("hides the under-budget warning and leaves an under-budget draft unmarked", () => {
    const meter = meterContext(evaluate([creature(1)]));
    expect(meter.differenceLabel).toBe("-40");
    expect(meter.stateClass).toBe("");
    const texts = (meter.warnings as { text: string }[]).map((w) => w.text);
    expect(texts.some((text) => text.includes("underBudget"))).toBe(false);
  });

  it("stretches the scale past extreme and clamps the fill", () => {
    const meter = meterContext(evaluate([creature(1, 8)]));
    expect(meter.supportedXP).toBe(320);
    expect(meter.fill).toBeCloseTo(100 / 1.05, 5);
    expect(meter.inferredLabel).toBe(`${K}.evaluation.beyondExtreme`);
  });

  it("flags a creature beyond +4 as unquantified", () => {
    const meter = meterContext(evaluate([creature(6)]));
    expect(meter.complete).toBe(false);
    expect(meter.stateClass).toBe("is-unquantified");
    expect(meter.inferredLabel).toBe(`${K}.evaluation.beyondExtreme ${K}.evaluation.unquantified`);
  });

  it("reports no target when no threat is selected", () => {
    const evaluation = { ...evaluate([creature(1)]), selectedThreat: null, tier: null, difference: null };
    const meter = meterContext(evaluation);
    expect(meter.target).toBeNull();
    expect(meter.targetLeft).toBeNull();
    expect(meter.differenceLabel).toBe("");
    expect(meter.selectedLabel).toBe("—");
    expect((meter.tiers as Tier[]).some((tier) => tier.selected)).toBe(false);
  });
});

describe("inferredThreatLabel", () => {
  it("localizes threat levels and beyond-extreme", () => {
    expect(inferredThreatLabel("low")).toBe(`${K}.threat.low`);
    expect(inferredThreatLabel("beyondExtreme")).toBe(`${K}.evaluation.beyondExtreme`);
    expect(inferredThreatLabel("beyondExtreme", true)).toBe(
      `${K}.evaluation.beyondExtreme ${K}.evaluation.unquantified`,
    );
  });

  it("keeps the literal suffix saved snapshots store", () => {
    expect(inferredThreatLabel("beyondExtreme (unquantified)")).toBe(
      `${K}.evaluation.beyondExtreme (unquantified)`,
    );
  });
});
