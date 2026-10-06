import { afterEach, describe, expect, it, vi } from "vitest";
import {
  legacyModuleIsForeign,
  migratePartyProfileRecord,
  migrateRecipeRecord,
  pickLegacyJournalFlags,
  runMigrations,
  shouldRunMigrations,
} from "../src/foundry/migrations.js";
import { validatePartyProfile, validateRecipe } from "../src/core/schemas.js";

describe("T18 (pure part): migrations stamp versions and preserve data", () => {
  it("migrates a pre-versioned party profile without losing unknown fields", () => {
    const { record, changed } = migratePartyProfileRecord({
      id: "p1",
      name: "Old",
      members: ["Actor.a", "Actor.b"],
      customNote: "keep me",
    });
    expect(changed).toBe(true);
    expect(record.schemaVersion).toBe(1);
    expect(record.customNote).toBe("keep me");
    expect(record.members).toEqual([
      { uuid: "Actor.a", active: true },
      { uuid: "Actor.b", active: true },
    ]);
    expect(validatePartyProfile(record).ok).toBe(true);
  });

  it("is idempotent", () => {
    const first = migratePartyProfileRecord({ id: "p1", name: "Old", members: [] }).record;
    const second = migratePartyProfileRecord(first);
    expect(second.changed).toBe(false);
    expect(second.record).toEqual(first);
  });

  it("migrates a pre-versioned recipe and keeps the entries", () => {
    const { record, changed } = migrateRecipeRecord({
      name: "Ambush",
      entries: [{ uuid: "Compendium.x.y.Actor.z", quantity: 3 }],
      extra: { nested: true },
    });
    expect(changed).toBe(true);
    expect(record.extra).toEqual({ nested: true });
    const validation = validateRecipe(record);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.entries[0]).toMatchObject({
        uuid: "Compendium.x.y.Actor.z",
        quantity: 3,
        locked: false,
      });
      expect(validation.value.evaluation).toBeNull();
    }
  });
});

describe("0.2.1: legacy namespace copy ignores the unrelated pf2e-encounter-builder module", () => {
  it("recognises our own 0.1.0 manifest and foreign ones", () => {
    expect(legacyModuleIsForeign(undefined)).toBe(false);
    expect(legacyModuleIsForeign({ title: "PF2e Encounter Builder", authors: [{ name: "sargas79" }] })).toBe(
      false,
    );
    expect(legacyModuleIsForeign({ title: "Whatever", authors: [{ github: "sargas79" }] })).toBe(false);
    expect(legacyModuleIsForeign({ title: "Other Builder", authors: [{ name: "someone" }] })).toBe(true);
    expect(legacyModuleIsForeign({ title: "Something Else", authors: [] })).toBe(true);
    expect(legacyModuleIsForeign({ title: "PF2e Encounter Builder" })).toBe(false);
  });

  it("copies only valid, missing flags and migrates recipes on the way", () => {
    const legacy = {
      dataJournal: true,
      tags: { schemaVersion: 1, entries: [{ uuid: "Compendium.x.y", tags: ["family:goblin"] }] },
      themes: { not: "a theme store" },
      recipe: { name: "Old", entries: [{ uuid: "Compendium.x.y", quantity: 2 }] },
    };
    const update = pickLegacyJournalFlags(legacy, undefined);
    expect(Object.keys(update).sort()).toEqual([
      "flags.sargas-encounter-builder.dataJournal",
      "flags.sargas-encounter-builder.recipe",
      "flags.sargas-encounter-builder.tags",
    ]);
    const recipe = update["flags.sargas-encounter-builder.recipe"] as {
      schemaVersion: number;
      origin: string;
    };
    expect(recipe.schemaVersion).toBe(1);
    expect(recipe.origin).toBe("manual");
  });

  it("never overwrites flags already present and drops a bare data-journal marker", () => {
    expect(
      pickLegacyJournalFlags(
        { tags: { schemaVersion: 1, entries: [] } },
        { tags: { schemaVersion: 1, entries: [] } },
      ),
    ).toEqual({});
    expect(pickLegacyJournalFlags({ dataJournal: true, tags: "garbage" }, undefined)).toEqual({});
    expect(pickLegacyJournalFlags({ foreign: { anything: 1 } }, undefined)).toEqual({});
  });
});

describe("migrations run on the active GM only", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects the active GM, not every GM", () => {
    expect(shouldRunMigrations({ user: { id: "a", isGM: false } })).toBe(false);
    expect(
      shouldRunMigrations({ user: { id: "a", isGM: true }, users: { activeGM: { id: "a", isSelf: true } } }),
    ).toBe(true);
    expect(
      shouldRunMigrations({ user: { id: "b", isGM: true }, users: { activeGM: { id: "a", isSelf: false } } }),
    ).toBe(false);
    // isSelf missing: compare ids.
    expect(shouldRunMigrations({ user: { id: "a", isGM: true }, users: { activeGM: { id: "a" } } })).toBe(
      true,
    );
    expect(shouldRunMigrations({ user: { id: "b", isGM: true }, users: { activeGM: { id: "a" } } })).toBe(
      false,
    );
  });

  it("falls back to any GM when the core has no activeGM", () => {
    expect(shouldRunMigrations({ user: { id: "a", isGM: true }, users: {} })).toBe(true);
    expect(shouldRunMigrations({ user: { id: "a", isGM: true } })).toBe(true);
  });

  it("returns before touching settings on a secondary GM", async () => {
    const get = vi.fn(() => 0);
    vi.stubGlobal("game", {
      user: { id: "b", isGM: true },
      users: { activeGM: { id: "a", isSelf: false } },
      settings: { get, set: vi.fn() },
    });
    await runMigrations();
    expect(get).not.toHaveBeenCalled();
  });
});
