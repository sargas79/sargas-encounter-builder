import { describe, expect, it } from "vitest";
import {
  addEntry,
  adjustedLevel,
  emptyDraft,
  entryKey,
  evaluateDraft,
  mergeGenerated,
  removeCreature,
  removeEntry,
  setAdjustment,
  setQuantity,
  toggleLock,
  type Draft,
  type DraftEntry,
} from "../src/core/draft.js";
import { draftFromRecipe, recalculateRecipe, recipeFromDraft } from "../src/core/recipe.js";
import { validateRecipe } from "../src/core/schemas.js";

const GOBLIN = "Compendium.p.Actor.goblin";

function entry(level: number, quantity = 1, adjustment?: DraftEntry["adjustment"]): DraftEntry {
  return {
    uuid: GOBLIN,
    name: "Goblin",
    level,
    ...(adjustment !== undefined ? { adjustment } : {}),
    quantity,
    locked: false,
    img: null,
    packLabel: null,
    traits: [],
  };
}

function draftOf(...entries: DraftEntry[]): Draft {
  return { ...emptyDraft(), entries };
}

describe("elite/weak level adjustment", () => {
  it("follows the GM Core level shifts", () => {
    expect(adjustedLevel(3, "elite")).toBe(4);
    expect(adjustedLevel(0, "elite")).toBe(2);
    expect(adjustedLevel(-1, "elite")).toBe(1);
    expect(adjustedLevel(3, "weak")).toBe(2);
    expect(adjustedLevel(1, "weak")).toBe(-1);
    expect(adjustedLevel(0, "weak")).toBe(-1);
    expect(adjustedLevel(3, null)).toBe(3);
    expect(adjustedLevel(3, undefined)).toBe(3);
  });

  it("prices adjusted creatures at their adjusted level", () => {
    // Party of 4 at level 3: a level-3 creature is 40 XP, +1 is 60, -1 is 30.
    const evaluation = evaluateDraft(draftOf(entry(3, 1), entry(3, 1, "elite"), entry(3, 2, "weak")), {
      partySize: 4,
      referenceLevel: 3,
      selectedThreat: "moderate",
    });
    expect(evaluation.entries.map((e) => [e.id, e.level, e.subtotal])).toEqual([
      [GOBLIN, 3, 40],
      [`${GOBLIN}#elite`, 4, 60],
      [`${GOBLIN}#weak`, 2, 60],
    ]);
    expect(evaluation.supportedXP).toBe(160);
  });
});

describe("draft rows are keyed by creature and adjustment", () => {
  it("keeps elite and normal copies of one creature apart", () => {
    let draft = addEntry(emptyDraft(), entry(3, 2));
    draft = addEntry(draft, entry(3, 1, "elite"));
    draft = addEntry(draft, entry(3, 1, "elite"));
    expect(draft.entries.map((e) => [entryKey(e), e.quantity])).toEqual([
      [GOBLIN, 2],
      [`${GOBLIN}#elite`, 2],
    ]);
    draft = setQuantity(draft, `${GOBLIN}#elite`, 5);
    draft = toggleLock(draft, `${GOBLIN}#elite`);
    expect(draft.entries[0]).toMatchObject({ quantity: 2, locked: false });
    expect(draft.entries[1]).toMatchObject({ quantity: 5, locked: true });
    expect(removeEntry(draft, GOBLIN).entries.map(entryKey)).toEqual([`${GOBLIN}#elite`]);
    expect(removeCreature(draft, GOBLIN).entries).toEqual([]);
  });

  it("changes an adjustment in place, merging into a matching row", () => {
    const draft = draftOf(entry(3, 2), { ...entry(3, 1, "elite"), locked: true });
    const changed = setAdjustment(draft, GOBLIN, "weak");
    expect(changed.entries.map((e) => [entryKey(e), e.quantity])).toEqual([
      [`${GOBLIN}#weak`, 2],
      [`${GOBLIN}#elite`, 1],
    ]);
    const merged = setAdjustment(draft, GOBLIN, "elite");
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({ adjustment: "elite", quantity: 3, locked: true });
    expect(setAdjustment(draft, GOBLIN, null)).toBe(draft);
  });
});

describe("rerolls keep adjusted rows", () => {
  const generated = (level: number, quantity: number, locked: boolean, uuid = GOBLIN) => ({
    uuid,
    name: "Goblin",
    level,
    quantity,
    locked,
    img: null,
    packLabel: null,
    traits: [],
  });

  it("keeps kept rows as they were, skips their echoes and merges generated normal copies", () => {
    const kept = [{ ...entry(3, 1, "elite"), locked: true }, entry(3, 2)];
    const merged = mergeGenerated(kept, [
      generated(4, 1, true), // echo of the elite row at its adjusted level
      generated(3, 2, true), // echo of the normal row
      generated(3, 1, false), // a new normal goblin joins the normal row
      generated(5, 1, false, "Compendium.p.Actor.boss"),
    ]);
    expect(merged.map((e) => [entryKey(e), e.level, e.quantity, e.locked])).toEqual([
      [`${GOBLIN}#elite`, 3, 1, true],
      [GOBLIN, 3, 3, false],
      ["Compendium.p.Actor.boss", 5, 1, false],
    ]);
  });
});

describe("saved recipes keep the adjustment", () => {
  it("round-trips through save, validation and load, and recalculates at the adjusted level", () => {
    const recipe = recipeFromDraft("Ambush", draftOf(entry(3, 2), entry(3, 1, "elite")), null);
    expect(recipe.entries.map((e) => e.adjustment)).toEqual([undefined, "elite"]);
    expect("adjustment" in recipe.entries[0]!).toBe(false);
    const validated = validateRecipe(structuredClone(recipe));
    expect(validated.ok).toBe(true);
    const { draft } = draftFromRecipe(recipe, () => ({ level: 3 }));
    expect(draft.entries.map(entryKey)).toEqual([GOBLIN, `${GOBLIN}#elite`]);
    expect(recalculateRecipe(recipe, 4, 3).supportedXP).toBe(140);
  });

  it("rejects an unknown adjustment", () => {
    const recipe = recipeFromDraft("Bad", draftOf(entry(3)), null);
    const raw = { ...recipe, entries: [{ ...recipe.entries[0], adjustment: "legendary" }] };
    expect(validateRecipe(raw).ok).toBe(false);
  });
});
