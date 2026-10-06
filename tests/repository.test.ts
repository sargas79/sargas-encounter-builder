import { beforeEach, describe, expect, it } from "vitest";
import { emptyDraft, evaluateDraft, type Draft } from "../src/core/draft.js";
import { newProfile, type RosterState } from "../src/core/party.js";
import {
  draftFromRecipe,
  duplicateRecipe,
  recalculateRecipe,
  recipeFromDraft,
  snapshotEvaluation,
} from "../src/core/recipe.js";
import { migrateRecipeRecord } from "../src/foundry/migrations.js";
import {
  EncounterRepository,
  JournalRecipeStore,
  findSummaryPageId,
  type RecipeStore,
} from "../src/foundry/encounter-repository.js";
import type { Recipe } from "../src/core/schemas.js";
import { MODULE_ID } from "../src/constants.js";

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.game = { user: { isGM: true } };
});

class MemoryStore implements RecipeStore {
  rows = new Map<string, { name: string; raw: unknown }>();
  next = 1;
  list() {
    return [...this.rows.entries()].map(([id, r]) => ({
      id,
      uuid: `JournalEntry.${id}`,
      raw: structuredClone(r.raw),
    }));
  }
  async create(name: string, recipe: Recipe) {
    const id = `j${this.next++}`;
    this.rows.set(id, { name, raw: structuredClone(recipe) });
    return { id, uuid: `JournalEntry.${id}` };
  }
  async update(id: string, name: string, recipe: Recipe) {
    this.rows.set(id, { name, raw: structuredClone(recipe) });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  /** Simulate a reload: JSON round-trip. */
  reload() {
    for (const [id, r] of this.rows)
      this.rows.set(id, { name: r.name, raw: JSON.parse(JSON.stringify(r.raw)) });
  }
}

function roster(partySize: number, level: number): RosterState {
  const counted = Array.from({ length: partySize }, (_, i) => ({
    uuid: `Actor.${i}`,
    name: `PC ${i}`,
    type: "character",
    level,
    active: true,
    status: "counted" as const,
    reason: "counted",
    countsAsMember: false,
  }));
  return {
    members: counted,
    counted,
    partySize,
    reference: {
      level,
      policy: "uniform",
      requiresChoice: false,
      isEstimate: false,
      distinctLevels: [level],
    },
    errors: [],
    blockers: [],
    missing: [],
  };
}

function draft(): Draft {
  return {
    ...emptyDraft(),
    entries: [
      {
        uuid: "Compendium.p.Actor.a",
        name: "Ash Hound",
        level: 4,
        quantity: 2,
        locked: true,
        img: null,
        packLabel: "P",
        traits: ["fire"],
      },
      {
        uuid: "Compendium.p.Actor.b",
        name: "Bog Lurker",
        level: 2,
        quantity: 1,
        locked: false,
        img: null,
        packLabel: "P",
        traits: [],
      },
    ],
    origin: "generated",
    generation: { seed: "abc", inputs: { threat: "moderate" } },
  };
}

describe("T18: saved recipes survive reload and migrations; recalculation does not overwrite the snapshot", () => {
  it("round-trips a recipe with its evaluation snapshot through the store", async () => {
    const store = new MemoryStore();
    const repo = new EncounterRepository(store);
    const profile = newProfile("p", "Heroes", "standalone");
    const r = roster(5, 4);
    const evaluation = evaluateDraft(draft(), {
      partySize: 5,
      referenceLevel: 4,
      selectedThreat: "moderate",
    });
    const snapshot = snapshotEvaluation(profile, r, evaluation);
    const recipe = recipeFromDraft("Ambush", draft(), snapshot, "In the marsh");
    const saved = await repo.save(recipe);

    store.reload();
    const loaded = repo.get(saved.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.recipe.entries).toEqual(recipe.entries);
    expect(loaded!.recipe.evaluation).toMatchObject({
      partyName: "Heroes",
      partySize: 5,
      referenceLevel: 4,
      supportedXP: 100,
      inferredLabel: "moderate",
      target: 100,
    });
    expect(loaded!.recipe.generation).toEqual({ seed: "abc", inputs: { threat: "moderate" } });
    expect(loaded!.recipe.notes).toBe("In the marsh");
  });

  it("recalculates against a different party and leaves the saved snapshot untouched", async () => {
    const store = new MemoryStore();
    const repo = new EncounterRepository(store);
    const evaluation = evaluateDraft(draft(), {
      partySize: 5,
      referenceLevel: 4,
      selectedThreat: "moderate",
    });
    const recipe = recipeFromDraft(
      "Ambush",
      draft(),
      snapshotEvaluation(newProfile("p", "Heroes", "standalone"), roster(5, 4), evaluation),
    );
    const saved = await repo.save(recipe);

    const fresh = recalculateRecipe(saved.recipe, 4, 2);
    // Ash Hound (+2) 80 × 2 + Bog Lurker (0) 40 = 200
    expect(fresh.supportedXP).toBe(200);
    expect(fresh.inferredLabel).toBe("beyondExtreme");
    expect(repo.get(saved.id)!.recipe.evaluation?.supportedXP).toBe(100);

    // Only an explicit update replaces the snapshot.
    await repo.update(saved.id, { ...saved.recipe, evaluation: fresh });
    expect(repo.get(saved.id)!.recipe.evaluation?.supportedXP).toBe(200);
  });

  it("migrates a pre-versioned stored recipe on load and keeps the data", () => {
    const store = new MemoryStore();
    store.rows.set("old", {
      name: "Old",
      raw: { name: "Old", entries: [{ uuid: "Compendium.p.Actor.a", quantity: 2 }], favorite: true },
    });
    const migrated = migrateRecipeRecord(store.rows.get("old")!.raw as Record<string, unknown>);
    store.rows.set("old", { name: "Old", raw: migrated.record });
    const repo = new EncounterRepository(store);
    const loaded = repo.get("old");
    expect(loaded?.recipe.entries[0]).toMatchObject({
      uuid: "Compendium.p.Actor.a",
      quantity: 2,
      locked: false,
    });
    expect((loaded?.recipe as unknown as { favorite: boolean }).favorite).toBe(true);
  });

  it("rejects invalid recipes and lists only valid ones", async () => {
    const store = new MemoryStore();
    store.rows.set("bad", { name: "Bad", raw: { schemaVersion: 1, name: "Bad" } });
    const repo = new EncounterRepository(store);
    expect(repo.list()).toEqual([]);
    await expect(repo.save({ schemaVersion: 1, name: "x" } as unknown as Recipe)).rejects.toThrow(
      /invalid recipe/,
    );
  });

  it("refuses writes for non-GMs", async () => {
    (g.game as { user: { isGM: boolean } }).user.isGM = false;
    const repo = new EncounterRepository(new MemoryStore());
    await expect(repo.save(recipeFromDraft("x", draft(), null))).rejects.toThrow(/GM only/);
    await expect(repo.delete("j1")).rejects.toThrow(/GM only/);
  });

  it("reopens a recipe as a draft and reports missing sources", () => {
    const recipe = recipeFromDraft("Ambush", draft(), null);
    const { draft: reopened, missing } = draftFromRecipe(recipe, (uuid) =>
      uuid.endsWith(".a") ? { name: "Ash Hound (current)", level: 5 } : null,
    );
    expect(reopened.entries[0]).toMatchObject({ name: "Ash Hound (current)", level: 5, locked: true });
    expect(reopened.entries[1]).toMatchObject({ name: "Bog Lurker", level: 2 });
    expect(missing.map((m) => m.uuid)).toEqual(["Compendium.p.Actor.b"]);
    expect(reopened.generation?.seed).toBe("abc");
  });

  it("duplicates, renames and deletes", async () => {
    const store = new MemoryStore();
    const repo = new EncounterRepository(store);
    const saved = await repo.save(recipeFromDraft("Ambush", draft(), null));
    const copy = await repo.save(duplicateRecipe(saved.recipe, "Ambush (copy)"));
    expect(
      repo
        .list()
        .map((r) => r.recipe.name)
        .sort(),
    ).toEqual(["Ambush", "Ambush (copy)"]);
    await repo.rename(copy.id, "Second ambush");
    expect(repo.get(copy.id)?.recipe.name).toBe("Second ambush");
    await repo.delete(saved.id);
    expect(repo.list()).toHaveLength(1);
  });

  it("records classic policy and table traces on table-origin recipes", () => {
    const d: Draft = {
      ...draft(),
      origin: "table",
      trace: { tableUuid: "RollTable.x", trace: [] },
      generation: undefined,
    };
    const recipe = recipeFromDraft("Rolled", d, null);
    expect(recipe.policy).toBe("classic");
    expect(recipe.trace).toEqual({ tableUuid: "RollTable.x", trace: [] });
  });
});

describe("saved recipe summary page", () => {
  const flagged = { [MODULE_ID]: { summary: true } };

  it("finds the flagged summary page wherever it is", () => {
    expect(
      findSummaryPageId([
        { id: "notes", name: "Notes", type: "text" },
        { id: "sum", name: "Renamed", type: "text", flags: flagged },
      ]),
    ).toBe("sum");
  });

  it("falls back to a single legacy 'Summary' text page, and to nothing when ambiguous or missing", () => {
    expect(
      findSummaryPageId([
        { id: "gm", name: "GM notes", type: "text" },
        { id: "old", name: "Summary", type: "text" },
      ]),
    ).toBe("old");
    expect(findSummaryPageId([{ id: "gm", name: "GM notes", type: "text" }])).toBeNull();
    expect(findSummaryPageId([{ id: "img", name: "Summary", type: "image" }])).toBeNull();
    expect(
      findSummaryPageId([
        { id: "a", name: "Summary", type: "text" },
        { id: "b", name: "Summary", type: "text" },
      ]),
    ).toBeNull();
  });

  function fakeJournal(pages: { id: string; name: string; type: string; flags?: Record<string, unknown> }[]) {
    const calls: { updated: Record<string, unknown>[]; created: Record<string, unknown>[] } = {
      updated: [],
      created: [],
    };
    const journal = {
      id: "j1",
      pages: { contents: pages },
      update: async () => journal,
      updateEmbeddedDocuments: async (_type: string, data: Record<string, unknown>[]) => {
        calls.updated.push(...data);
        return [];
      },
      createEmbeddedDocuments: async (_type: string, data: Record<string, unknown>[]) => {
        calls.created.push(...data);
        return [];
      },
    };
    g.game = { user: { isGM: true }, journal: { get: (id: string) => (id === "j1" ? journal : undefined) } };
    return calls;
  }

  it("updates the flagged page, never a GM page placed first", async () => {
    const calls = fakeJournal([
      { id: "gm", name: "GM notes", type: "text" },
      { id: "sum", name: "Summary", type: "text", flags: flagged },
    ]);
    await new JournalRecipeStore().update("j1", "Ambush", recipeFromDraft("Ambush", draft(), null));
    expect(calls.updated.map((u) => u._id)).toEqual(["sum"]);
    expect(String(calls.updated[0]!["text.content"])).toContain("Ash Hound");
    expect(calls.created).toEqual([]);
  });

  it("migrates a legacy summary page by flagging it", async () => {
    const calls = fakeJournal([{ id: "old", name: "Summary", type: "text" }]);
    await new JournalRecipeStore().update("j1", "Ambush", recipeFromDraft("Ambush", draft(), null));
    expect(calls.updated).toEqual([
      expect.objectContaining({ _id: "old", [`flags.${MODULE_ID}.summary`]: true }),
    ]);
  });

  it("adds a new flagged summary page instead of overwriting when none is found", async () => {
    const calls = fakeJournal([{ id: "gm", name: "GM notes", type: "text" }]);
    await new JournalRecipeStore().update("j1", "Ambush", recipeFromDraft("Ambush", draft(), null));
    expect(calls.updated).toEqual([]);
    expect(calls.created).toEqual([
      expect.objectContaining({ name: "Summary", type: "text", flags: { [MODULE_ID]: { summary: true } } }),
    ]);
  });
});
