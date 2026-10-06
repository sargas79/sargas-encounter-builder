import { describe, expect, it } from "vitest";
import {
  emptyResultFlags,
  emptyTableFlags,
  validateRecipe,
  validateResultFlags,
  validateTableFlags,
  validateThemeStore,
} from "../src/core/schemas.js";
import { validateTable, type TableModel } from "../src/core/table-model.js";

function recipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "R",
    notes: "",
    entries: [{ uuid: "Compendium.p.Actor.a", name: "A", level: 1, quantity: 1, locked: false }],
    origin: "manual",
    evaluation: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function treasure(price: unknown): Record<string, unknown> {
  return {
    seed: null,
    share: 1,
    options: {
      allowUncommon: false,
      allowRare: false,
      includeConsumables: true,
      valuablesShare: 0,
      preferTraits: [],
      excludeCategories: [],
    },
    entries: [{ uuid: "i", name: "Item", level: 1, price, kind: "permanent", slotLevel: 1, locked: false }],
    coins: { pp: 0, gp: 0, sp: 0, cp: 0 },
  };
}

describe("boundary validators coerce every field the module reads", () => {
  it("a template row without traits is coerced and no longer crashes table validation", () => {
    const raw = {
      ...emptyResultFlags("template"),
      template: { candidates: ["Actor.a", 7], composition: "unrestricted", levelMin: "2", threat: "deadly" },
    };
    const v = validateResultFlags(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.template).toEqual({
      candidates: ["Actor.a"],
      traits: [],
      levelMin: null,
      levelMax: null,
      composition: "unrestricted",
      threat: null,
    });
    const model: TableModel = {
      uuid: "RollTable.t",
      name: "T",
      formula: "1d2",
      replacement: true,
      mode: "range",
      flags: emptyTableFlags(),
      rows: [
        { id: "r", text: "", documentUuid: null, range: [1, 2], weight: 1, drawn: false, flags: v.value },
      ],
    };
    expect(() => validateTable(model)).not.toThrow();
    // The input object is not mutated (it may be a document's source data).
    expect((raw.template as Record<string, unknown>).traits).toBeUndefined();
  });

  it("keeps a valid template threat and numeric level bounds", () => {
    const v = validateResultFlags({
      ...emptyResultFlags("template"),
      template: {
        candidates: [],
        traits: ["undead", 3],
        levelMin: -1,
        levelMax: 2,
        composition: "pair",
        threat: "severe",
      },
    });
    expect(v.ok && v.value.template).toMatchObject({
      traits: ["undead"],
      levelMin: -1,
      levelMax: 2,
      threat: "severe",
    });
  });

  it("coerces narrativeKind and journalUuid", () => {
    const narrative = validateResultFlags({
      ...emptyResultFlags("narrative"),
      narrativeKind: "bogus",
      journalUuid: 5,
    });
    expect(narrative.ok && narrative.value).toMatchObject({ narrativeKind: "other", journalUuid: null });
    const creatures = validateResultFlags({ ...emptyResultFlags("creatures"), narrativeKind: "bogus" });
    expect(creatures.ok && creatures.value.narrativeKind).toBeNull();
    const missing = { ...emptyResultFlags("creatures") } as Record<string, unknown>;
    delete missing.journalUuid;
    const v = validateResultFlags(missing);
    expect(v.ok && v.value.journalUuid).toBeNull();
    const kept = validateResultFlags({
      ...emptyResultFlags("narrative"),
      narrativeKind: "tracks",
    });
    expect(kept.ok && kept.value.narrativeKind).toBe("tracks");
  });

  it("coerces encounter-check trigger values to numbers and drops the rest", () => {
    const v = validateTableFlags({
      ...emptyTableFlags(),
      encounterCheck: { formula: "1d6", occursOn: [1, "2", " ", "x", 3.5, null, 6] },
    });
    expect(v.ok && v.value.encounterCheck?.occursOn).toEqual([1, 2, 6]);
  });

  it("coerces table tag lists to arrays of strings", () => {
    const v = validateTableFlags({ ...emptyTableFlags(), tags: { region: ["north", 4], terrain: "forest" } });
    expect(v.ok && v.value.tags).toEqual({ region: ["north"], terrain: [], season: [], timeOfDay: [] });
  });

  it("falls back to the uuid when a recipe entry has no name", () => {
    const v = validateRecipe(
      recipe({ entries: [{ uuid: "Compendium.p.Actor.a", level: 1, quantity: 1, locked: false }] }),
    );
    expect(v.ok && v.value.entries[0]!.name).toBe("Compendium.p.Actor.a");
    const named = validateRecipe(recipe());
    expect(named.ok && named.value.entries[0]!.name).toBe("A");
  });

  it("drops a treasure record whose prices are not finite and non-negative", () => {
    for (const price of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const v = validateRecipe(recipe({ treasure: treasure(price) }));
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.value.treasure).toBeUndefined();
    }
    const good = validateRecipe(recipe({ treasure: treasure(0) }));
    expect(good.ok && good.value.treasure).toBeTruthy();
  });

  it("drops non-string elements from custom theme lists instead of rejecting the store", () => {
    const v = validateThemeStore({
      schemaVersion: 1,
      themes: [
        {
          id: "t",
          name: "T",
          requiredTraits: ["undead", 1],
          anyTraits: [null, "ghoul"],
          candidateUuids: [{}, "Actor.a"],
          environment: null,
          notes: "",
        },
      ],
    });
    expect(v.ok && v.value.themes[0]).toMatchObject({
      requiredTraits: ["undead"],
      anyTraits: ["ghoul"],
      candidateUuids: ["Actor.a"],
    });
  });
});
