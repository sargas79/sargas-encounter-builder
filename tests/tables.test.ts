import { describe, expect, it } from "vitest";
import { evaluateFormula, validateFormula } from "../src/core/dice-grammar.js";
import { emptyResultFlags, emptyTableFlags, type ResultFlags } from "../src/core/schemas.js";
import {
  nativeTextForRow,
  rangesFromWeights,
  resolveTable,
  validateTable,
  type TableLookup,
  type TableModel,
  type TableRow,
} from "../src/core/table-model.js";
import { mulberry32 } from "../src/core/rng.js";
import { evaluateEncounter } from "../src/core/budget.js";
import { diffEntries } from "../src/core/variant.js";
import { generateEncounter } from "../src/core/generator.js";
import { saveTable } from "../src/foundry/table-flags.js";

/* ------------------------------------------------------------------ */

function row(
  id: string,
  range: [number, number],
  flags: Partial<ResultFlags> | null,
  extra: Partial<TableRow> = {},
): TableRow {
  return {
    id,
    text: extra.text ?? id,
    documentUuid: null,
    range,
    weight: 1,
    drawn: false,
    flags: flags ? { ...emptyResultFlags(flags.kind ?? "narrative"), ...flags } : null,
    ...extra,
  };
}

function table(uuid: string, formula: string, rows: TableRow[], extra: Partial<TableModel> = {}): TableModel {
  return {
    uuid,
    name: uuid,
    formula,
    replacement: true,
    mode: "range",
    flags: emptyTableFlags(),
    rows,
    ...extra,
  };
}

class FakeLookup implements TableLookup {
  rolls: { formula: string; purpose: string; total: number }[] = [];
  constructor(
    public tables: Record<string, TableModel>,
    public creatures: Record<string, { name: string; level: number }>,
    /** Scripted totals by purpose; falls back to the seeded evaluator. */
    public scripted: { table?: number[]; quantity?: number[]; check?: number[] } = {},
    public rng = mulberry32(3),
  ) {}
  async getTable(uuid: string) {
    return this.tables[uuid] ?? null;
  }
  async rollFormula(formula: string, purpose: "table" | "quantity" | "check") {
    const queue = this.scripted[purpose];
    const total = queue && queue.length ? queue.shift()! : evaluateFormula(formula, this.rng);
    this.rolls.push({ formula, purpose, total });
    return { total, detail: `${formula}=${total}` };
  }
  async resolveCreature(uuid: string) {
    const c = this.creatures[uuid];
    return c ? { uuid, name: c.name, level: c.level } : null;
  }
}

const limits = { maxDepth: 3, maxQuantityPerEntry: 10, maxTotalCreatures: 20 };

const creatures = {
  "Compendium.p.Actor.wolf": { name: "Grey Wolf", level: 1 },
  "Compendium.p.Actor.scout": { name: "Scout", level: 2 },
  "Compendium.p.Actor.leader": { name: "Leader", level: 4 },
  "Compendium.p.Actor.dragon": { name: "Dragon", level: 15 },
};

/** Illustrative d100 table from the spec (placeholder names, no bundled content). */
function wilderness(): TableModel {
  return table("RollTable.wild", "1d100", [
    row("none", [1, 30], { kind: "none" }),
    row("pack", [31, 50], {
      kind: "creatures",
      creatures: [{ uuid: "Compendium.p.Actor.wolf", quantity: "1d4+1" }],
    }),
    row("patrol", [51, 65], {
      kind: "creatures",
      creatures: [
        { uuid: "Compendium.p.Actor.scout", quantity: "1d3+2" },
        { uuid: "Compendium.p.Actor.leader", quantity: "1" },
      ],
      notes: "They are tracking something.",
    }),
    row("tracks", [66, 80], { kind: "narrative", narrativeKind: "tracks" }, { text: "Fresh tracks" }),
    row("camp", [81, 95], { kind: "narrative", narrativeKind: "discovery" }, { text: "Ruined campsite" }),
    row("danger", [96, 100], { kind: "table", tableUuid: "RollTable.danger" }),
  ]);
}

/* ------------------------------------------------------------------ */

describe("dice grammar", () => {
  it("accepts pure dice expressions and computes bounds", () => {
    expect(validateFormula("1d4+1")).toEqual({ ok: true, min: 2, max: 5 });
    expect(validateFormula("2d6")).toEqual({ ok: true, min: 2, max: 12 });
    expect(validateFormula("(1d3+2)*2")).toEqual({ ok: true, min: 6, max: 10 });
    expect(validateFormula("4d6kh3")).toEqual({ ok: true, min: 3, max: 18 });
    expect(validateFormula("d20")).toEqual({ ok: true, min: 1, max: 20 });
    expect(validateFormula("3")).toEqual({ ok: true, min: 3, max: 3 });
  });

  it("rejects data references, functions, flavor and garbage", () => {
    expect(validateFormula("1d4 + @abilities.str.mod").ok).toBe(false);
    expect(validateFormula("floor(1d4/2)").ok).toBe(false);
    expect(validateFormula("1d4[fire]").ok).toBe(false);
    expect(validateFormula("1d4 / 2").ok).toBe(false);
    expect(validateFormula("").ok).toBe(false);
    expect(validateFormula("1d").ok).toBe(false);
    expect(validateFormula("(1d4").ok).toBe(false);
    expect(validateFormula("1d0").ok).toBe(false);
    expect(validateFormula("999d6").ok).toBe(false);
  });

  it("evaluates deterministically with a seeded RNG within bounds", () => {
    const rng = () => 0.999;
    expect(evaluateFormula("1d4+1", rng)).toBe(5);
    expect(evaluateFormula("2d6kl1", () => 0)).toBe(1);
    for (let i = 0; i < 50; i++) {
      const v = evaluateFormula("1d3+2", mulberry32(i));
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});

describe("T11: explicit dice ranges and weighted tables resolve with their intended semantics", () => {
  it("matches an explicit range exactly, without normalizing", async () => {
    const lookup = new FakeLookup({ "RollTable.wild": wilderness() }, creatures, {
      table: [31],
      quantity: [3],
    });
    const outcome = await resolveTable("RollTable.wild", lookup, limits);
    expect(outcome.creatures).toEqual([
      expect.objectContaining({ uuid: "Compendium.p.Actor.wolf", quantity: 3 }),
    ]);
    expect(lookup.rolls[0]).toEqual({ formula: "1d100", purpose: "table", total: 31 });
    expect(outcome.trace.map((t) => t.kind)).toEqual(["tableRoll", "match", "quantityRoll", "creature"]);
  });

  it("a range-mode table with a gap reports no match instead of picking a neighbour", async () => {
    const t = table("RollTable.gap", "1d6", [
      row("a", [1, 2], { kind: "none" }),
      row("b", [5, 6], { kind: "none" }),
    ]);
    const lookup = new FakeLookup({ "RollTable.gap": t }, creatures, { table: [3] });
    const outcome = await resolveTable("RollTable.gap", lookup, limits);
    expect(outcome.errors).toEqual(["no row matches 3 on RollTable.gap"]);
    expect(validateTable(t).some((i) => i.code === "rangeGap")).toBe(true);
  });

  it("weight mode derives ranges from weights and rolls 1dTotal", async () => {
    const rows = [
      row("a", [0, 0], { kind: "none" }, { weight: 3 }),
      row("b", [0, 0], { kind: "narrative" }, { weight: 1 }),
      row("z", [0, 0], { kind: "none" }, { weight: 0 }),
    ];
    expect(rangesFromWeights(rows).map((r) => r.range)).toEqual([
      [1, 3],
      [4, 4],
      [0, 0],
    ]);
    const t = table("RollTable.w", "1d20", rows, { mode: "weight" });
    const lookup = new FakeLookup({ "RollTable.w": t }, creatures, { table: [4] });
    const outcome = await resolveTable("RollTable.w", lookup, limits);
    expect(lookup.rolls[0]?.formula).toBe("1d4");
    expect(outcome.narratives[0]?.rowId).toBe("b");
    expect(validateTable(t).some((i) => i.code === "weightZero" && i.rowId === "z")).toBe(true);
  });

  it("validation flags overlaps, out-of-range rows, bad formulas and missing references", () => {
    const t = table("RollTable.v", "1d10", [
      row("a", [1, 5], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.ghost", quantity: "1d4" }],
      }),
      row("b", [5, 8], { kind: "table", tableUuid: null }),
      row("c", [9, 12], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.wolf", quantity: "1d4+@x" }],
      }),
      row("d", [3, 2], { kind: "none" }),
    ]);
    const issues = validateTable(t, { exists: (uuid) => uuid in creatures });
    const codes = issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "rangeOverlap",
        "rangeOutside",
        "creatureMissing",
        "tableMissing",
        "quantityInvalid",
        "rangeInvalid",
      ]),
    );
    expect(validateTable(table("RollTable.f", "1d4+@x", [])).map((i) => i.code)).toContain("formulaInvalid");
  });
});

describe("T12: multi-creature results and quantity dice resolve correctly", () => {
  it("resolves a patrol with two creature types, dice and fixed quantities, and notes", async () => {
    const lookup = new FakeLookup({ "RollTable.wild": wilderness() }, creatures, {
      table: [60],
      quantity: [4],
    });
    const outcome = await resolveTable("RollTable.wild", lookup, limits);
    expect(outcome.creatures.map((c) => [c.name, c.quantity])).toEqual([
      ["Scout", 4],
      ["Leader", 1],
    ]);
    expect(outcome.notes).toEqual(["They are tracking something."]);
    expect(lookup.rolls.filter((r) => r.purpose === "quantity")).toHaveLength(1);
  });

  it("merges the same creature appearing twice", async () => {
    const t = table("RollTable.m", "1d1", [
      row("a", [1, 1], {
        kind: "creatures",
        creatures: [
          { uuid: "Compendium.p.Actor.wolf", quantity: "2" },
          { uuid: "Compendium.p.Actor.wolf", quantity: "3" },
        ],
      }),
    ]);
    const outcome = await resolveTable(
      "RollTable.m",
      new FakeLookup({ "RollTable.m": t }, creatures),
      limits,
    );
    expect(outcome.creatures).toEqual([expect.objectContaining({ name: "Grey Wolf", quantity: 5 })]);
  });
});

describe("T13: classic outcomes remain unchanged even when too dangerous", () => {
  it("keeps a level-15 dragon against a level-1 party and evaluation reports beyond Extreme", async () => {
    const t = table("RollTable.d", "1d1", [
      row("a", [1, 1], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.dragon", quantity: "1" }],
      }),
    ]);
    const outcome = await resolveTable(
      "RollTable.d",
      new FakeLookup({ "RollTable.d": t }, creatures),
      limits,
    );
    expect(outcome.creatures).toEqual([expect.objectContaining({ name: "Dragon", level: 15, quantity: 1 })]);
    const evaluation = evaluateEncounter({
      partySize: 4,
      referenceLevel: 1,
      entries: outcome.creatures.map((c) => ({ id: c.uuid, level: c.level ?? 0, quantity: c.quantity })),
    });
    expect(evaluation.inferred).toEqual({
      label: "beyondExtreme",
      unquantified: true,
      incompleteNegligible: false,
    });
    expect(evaluation.complete).toBe(false);
  });
});

describe("T14: balanced variants retain the original outcome and show changes", () => {
  it("diffs added, removed and changed quantities", () => {
    const original = [
      { uuid: "a", name: "A", level: 1, quantity: 3, locked: false },
      { uuid: "b", name: "B", level: 2, quantity: 1, locked: false },
    ];
    const variant = [
      { uuid: "a", name: "A", level: 1, quantity: 2, locked: false },
      { uuid: "c", name: "C", level: 1, quantity: 1, locked: false },
    ];
    expect(diffEntries(original, variant)).toEqual([
      { uuid: "a", name: "A", change: "quantityChanged", from: 3, to: 2 },
      { uuid: "b", name: "B", change: "removed", from: 1, to: 0 },
      { uuid: "c", name: "C", change: "added", from: 0, to: 1 },
    ]);
  });

  it("generates a variant from the classic creature pool while leaving the original untouched", () => {
    const original = [
      { uuid: "Compendium.p.Actor.dragon", name: "Dragon", level: 15, quantity: 1, locked: false },
    ];
    const pool = [{ uuid: "Compendium.p.Actor.wolf", name: "Grey Wolf", level: 1, traits: ["animal"] }];
    const result = generateEncounter({
      threat: "moderate",
      partySize: 4,
      referenceLevel: 1,
      candidates: pool,
      rng: mulberry32(1),
      maxCount: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const variant = result.entries.map((e) => ({
      uuid: e.uuid,
      name: e.name,
      level: e.level,
      quantity: e.quantity,
      locked: false,
    }));
    const diff = diffEntries(original, variant);
    expect(diff.find((d) => d.uuid === "Compendium.p.Actor.dragon")?.change).toBe("removed");
    expect(diff.find((d) => d.uuid === "Compendium.p.Actor.wolf")?.change).toBe("added");
    expect(original[0]?.quantity).toBe(1);
  });
});

describe("T15: nested tables, cycles, missing UUIDs, invalid formulas and excessive quantities fail safely", () => {
  it("resolves a nested subtable with a trace", async () => {
    const danger = table("RollTable.danger", "1d2", [
      row("x", [1, 2], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.leader", quantity: "2" }],
      }),
    ]);
    const lookup = new FakeLookup({ "RollTable.wild": wilderness(), "RollTable.danger": danger }, creatures, {
      table: [97, 1],
    });
    const outcome = await resolveTable("RollTable.wild", lookup, limits);
    expect(outcome.creatures).toEqual([
      expect.objectContaining({ name: "Leader", quantity: 2, tableUuid: "RollTable.danger" }),
    ]);
    expect(outcome.trace.map((t) => t.kind)).toEqual([
      "tableRoll",
      "match",
      "nested",
      "tableRoll",
      "match",
      "creature",
    ]);
    expect(outcome.trace[2]?.depth).toBe(0);
    expect(outcome.trace[3]?.depth).toBe(1);
  });

  it("detects cycles and stops", async () => {
    const a = table("RollTable.a", "1d1", [row("r", [1, 1], { kind: "table", tableUuid: "RollTable.b" })]);
    const b = table("RollTable.b", "1d1", [row("r", [1, 1], { kind: "table", tableUuid: "RollTable.a" })]);
    const lookup = new FakeLookup({ "RollTable.a": a, "RollTable.b": b }, creatures);
    const outcome = await resolveTable("RollTable.a", lookup, limits);
    expect(outcome.stoppedByLimit).toBe(true);
    expect(outcome.errors[0]).toMatch(/cycle/);
    expect(lookup.rolls.length).toBeLessThanOrEqual(2);
    expect(
      validateTable(a, { getTable: (u) => ({ "RollTable.a": a, "RollTable.b": b })[u] ?? null }).map(
        (i) => i.code,
      ),
    ).toContain("cycle");
    expect(
      validateTable(
        table("RollTable.s", "1d1", [row("r", [1, 1], { kind: "table", tableUuid: "RollTable.s" })]),
      ).map((i) => i.code),
    ).toContain("selfReference");
  });

  it("enforces the nesting depth limit", async () => {
    const tables: Record<string, TableModel> = {};
    for (let i = 0; i < 10; i++)
      tables[`RollTable.t${i}`] = table(`RollTable.t${i}`, "1d1", [
        row("r", [1, 1], { kind: "table", tableUuid: `RollTable.t${i + 1}` }),
      ]);
    const outcome = await resolveTable("RollTable.t0", new FakeLookup(tables, creatures), limits);
    expect(outcome.stoppedByLimit).toBe(true);
    expect(outcome.errors.some((e) => /depth/.test(e))).toBe(true);
  });

  it("reports missing nested tables and missing creatures without dropping them silently", async () => {
    const lookup = new FakeLookup(
      { "RollTable.wild": wilderness() },
      { "Compendium.p.Actor.scout": creatures["Compendium.p.Actor.scout"] },
      { table: [97] },
    );
    const outcome = await resolveTable("RollTable.wild", lookup, limits);
    expect(outcome.errors[0]).toMatch(/not found/);

    const patrol = new FakeLookup(
      { "RollTable.wild": wilderness() },
      { "Compendium.p.Actor.scout": creatures["Compendium.p.Actor.scout"] },
      { table: [55], quantity: [3] },
    );
    const outcome2 = await resolveTable("RollTable.wild", patrol, limits);
    expect(outcome2.creatures.map((c) => c.name)).toEqual(["Scout"]);
    expect(outcome2.unavailable).toEqual([
      expect.objectContaining({ uuid: "Compendium.p.Actor.leader", quantity: "1" }),
    ]);
  });

  it("rejects invalid quantity formulas at resolution time", async () => {
    const t = table("RollTable.q", "1d1", [
      row("r", [1, 1], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.wolf", quantity: "1d4+@str" }],
      }),
    ]);
    const outcome = await resolveTable(
      "RollTable.q",
      new FakeLookup({ "RollTable.q": t }, creatures),
      limits,
    );
    expect(outcome.creatures).toEqual([]);
    expect(outcome.unavailable).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(/invalid quantity/);
  });

  it("stops on excessive per-entry and total quantities", async () => {
    const t = table("RollTable.big", "1d1", [
      row("r", [1, 1], {
        kind: "creatures",
        creatures: [{ uuid: "Compendium.p.Actor.wolf", quantity: "50" }],
      }),
    ]);
    const outcome = await resolveTable(
      "RollTable.big",
      new FakeLookup({ "RollTable.big": t }, creatures),
      limits,
    );
    expect(outcome.stoppedByLimit).toBe(true);
    expect(outcome.errors[0]).toMatch(/per-entry limit/);

    const many = table("RollTable.many", "1d1", [
      row("r", [1, 1], {
        kind: "creatures",
        creatures: Array.from({ length: 5 }, () => ({ uuid: "Compendium.p.Actor.wolf", quantity: "8" })),
      }),
    ]);
    const outcome2 = await resolveTable(
      "RollTable.many",
      new FakeLookup({ "RollTable.many": many }, creatures),
      limits,
    );
    expect(outcome2.stoppedByLimit).toBe(true);
    expect(outcome2.errors[0]).toMatch(/total creatures/);
    expect(outcome2.creatures[0]?.quantity).toBe(16);
  });

  it("fails safely on a missing root table", async () => {
    const outcome = await resolveTable("RollTable.nope", new FakeLookup({}, creatures), limits);
    expect(outcome.errors).toEqual(["table RollTable.nope not found"]);
  });
});

describe("T16: narrative results do not create creatures", () => {
  it("produces narratives and no creatures for tracks/camp/none rows", async () => {
    for (const total of [10, 70, 90]) {
      const lookup = new FakeLookup({ "RollTable.wild": wilderness() }, creatures, { table: [total] });
      const outcome = await resolveTable("RollTable.wild", lookup, limits);
      expect(outcome.creatures).toEqual([]);
      expect(outcome.narratives).toHaveLength(1);
      expect(outcome.encounterOccurred).toBe(true);
    }
  });

  it("encounter check: no encounter on a miss, no table roll", async () => {
    const t = wilderness();
    t.flags.encounterCheck = { formula: "1d6", occursOn: [1] };
    const lookup = new FakeLookup({ "RollTable.wild": t }, creatures, { check: [4] });
    const outcome = await resolveTable("RollTable.wild", lookup, limits);
    expect(outcome.encounterOccurred).toBe(false);
    expect(lookup.rolls).toHaveLength(1);
    expect(outcome.trace[0]?.kind).toBe("encounterCheck");

    const hit = new FakeLookup({ "RollTable.wild": t }, creatures, { check: [1], table: [70] });
    const outcome2 = await resolveTable("RollTable.wild", hit, limits);
    expect(outcome2.encounterOccurred).toBe(true);
    expect(outcome2.narratives[0]?.kind).toBe("tracks");
  });

  it("native rows without module flags are treated as narrative text", async () => {
    const t = table("RollTable.n", "1d1", [row("r", [1, 1], null, { text: "You find an old shrine." })]);
    const outcome = await resolveTable(
      "RollTable.n",
      new FakeLookup({ "RollTable.n": t }, creatures),
      limits,
    );
    expect(outcome.narratives).toEqual([
      expect.objectContaining({ kind: "native", text: "You find an old shrine." }),
    ]);
    expect(outcome.creatures).toEqual([]);
  });

  it("writes a readable native summary for module rows", () => {
    const names = (uuid: string) => creatures[uuid as keyof typeof creatures]?.name ?? null;
    expect(
      nativeTextForRow(
        {
          ...emptyResultFlags("creatures"),
          creatures: [{ uuid: "Compendium.p.Actor.wolf", quantity: "1d4+1" }],
          notes: "hungry",
        },
        names,
      ),
    ).toBe("1d4+1 × Grey Wolf — hungry");
    expect(nativeTextForRow({ ...emptyResultFlags("none") }, names)).toBe("No encounter");
  });
});

describe("review fixes", () => {
  it("weight mode: a zero-weight row is a warning, not a range error", () => {
    const rows = [
      row("a", [1, 3], { kind: "none" }, { weight: 3 }),
      row("z", [0, 0], { kind: "none" }, { weight: 0 }),
    ];
    const issues = validateTable(table("RollTable.w0", "1d3", rows, { mode: "weight" }));
    expect(issues.some((i) => i.code === "rangeInvalid")).toBe(false);
    expect(issues.some((i) => i.code === "weightZero" && i.level === "warning")).toBe(true);
  });
});

describe("saving a table writes derived ranges to native rows", () => {
  it("updates only range/weight of native rows whose range changed", async () => {
    (globalThis as Record<string, unknown>).game = { user: { isGM: true } };
    const native = (id: string, range: [number, number], weight = 1) => ({
      id,
      range,
      weight,
      description: id,
      getFlag: () => undefined,
    });
    const results = new Map([
      ["a", native("a", [1, 1])],
      ["b", native("b", [2, 2])],
    ]);
    const updates: Record<string, unknown>[] = [];
    const table = {
      formula: "1d2",
      results: { get: (id: string) => results.get(id) },
      getFlag: () => emptyTableFlags(),
      update: async () => table,
      updateEmbeddedDocuments: async (_type: string, data: Record<string, unknown>[]) => {
        updates.push(...data);
        return [];
      },
      createEmbeddedDocuments: async () => [],
      deleteEmbeddedDocuments: async () => [],
    };
    await saveTable(
      table as unknown as RollTableDocument,
      {
        formula: "1d2",
        flags: emptyTableFlags(),
        rows: [],
        deleteIds: [],
        nativeRanges: [
          { id: "a", range: [1, 1], weight: 1 },
          { id: "b", range: [2, 3], weight: 2 },
          { id: "gone", range: [4, 4], weight: 1 },
        ],
      },
      () => null,
    );
    // Unchanged and missing rows are skipped; no module flags or text are written to the native row.
    expect(updates).toEqual([{ _id: "b", range: [2, 3], weight: 2 }]);
  });
});
