import { afterEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/constants.js";
import { emptyTagStore, emptyThemeStore } from "../src/core/schemas.js";
import { dataJournalChange, ensureDataJournal } from "../src/foundry/data-journal.js";
import { TagStoreService } from "../src/foundry/tag-store.js";
import { ThemeStoreService } from "../src/foundry/theme-store.js";

/** Minimal JournalEntry: module flags plus a flat-key `update` understanding `-=` deletions. */
class FakeJournal {
  flags: Record<string, Record<string, unknown>>;
  constructor(flags: Record<string, unknown> = {}) {
    this.flags = { [MODULE_ID]: structuredClone(flags) };
  }
  getFlag(scope: string, key: string): unknown {
    return this.flags[scope]?.[key];
  }
  async update(diff: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(diff)) {
      const [, scope, key] = path.split(".") as [string, string, string];
      const bucket = (this.flags[scope] ??= {});
      if (key.startsWith("-=")) delete bucket[key.slice(2)];
      else bucket[key] = structuredClone(value);
    }
  }
}

function stubWorld(journals: FakeJournal[], createDelay = 0) {
  const create = vi.fn(async (data: { flags: Record<string, Record<string, unknown>> }) => {
    await new Promise((r) => setTimeout(r, createDelay));
    const doc = new FakeJournal(data.flags[MODULE_ID]);
    journals.push(doc);
    return doc;
  });
  vi.stubGlobal("game", {
    user: { isGM: true },
    journal: { find: (fn: (j: FakeJournal) => boolean) => journals.find(fn) },
  });
  vi.stubGlobal("CONFIG", { JournalEntry: { documentClass: { create } } });
  return create;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared module data journal", () => {
  it("creates a single journal when both stores write for the first time together", async () => {
    const journals: FakeJournal[] = [];
    const create = stubWorld(journals, 5);
    const [a, b] = await Promise.all([ensureDataJournal(), ensureDataJournal()]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.getFlag(MODULE_ID, FLAGS.dataJournal)).toBe(true);
    // Once it exists, it is found instead of created.
    expect(await ensureDataJournal()).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a tag written by another GM after this client loaded its cache", async () => {
    const journal = new FakeJournal({
      [FLAGS.dataJournal]: true,
      [FLAGS.tags]: emptyTagStore(),
      [FLAGS.themes]: emptyThemeStore(),
    });
    stubWorld([journal]);
    const store = new TagStoreService();
    expect(store.allTags()).toEqual([]);
    // Another GM writes directly to the document.
    const other = structuredClone(journal.getFlag(MODULE_ID, FLAGS.tags)) as ReturnType<typeof emptyTagStore>;
    other.entries.push({ uuid: "Actor.b", tags: ["swamp"] });
    await journal.update({ [`flags.${MODULE_ID}.${FLAGS.tags}`]: other });

    await store.setTags("Actor.a", ["forest"]);
    const saved = journal.getFlag(MODULE_ID, FLAGS.tags) as ReturnType<typeof emptyTagStore>;
    expect(saved.entries.map((e) => e.uuid).sort()).toEqual(["Actor.a", "Actor.b"]);
    expect(store.tagsFor("Actor.b")).toEqual(["swamp"]);
  });

  it("keeps a theme saved by another GM", async () => {
    const journal = new FakeJournal({ [FLAGS.dataJournal]: true, [FLAGS.themes]: emptyThemeStore() });
    stubWorld([journal]);
    const themes = new ThemeStoreService();
    expect(themes.list()).toEqual([]);
    const theme = {
      name: "Bog",
      requiredTraits: [],
      anyTraits: ["amphibious"],
      environment: null,
      candidateUuids: [],
      notes: "",
    };
    const other = new ThemeStoreService();
    other.invalidate();
    await other.save({ ...theme, id: "t1" });
    await themes.save({ ...theme, id: "t2", name: "Fen" });
    expect(themes.list().map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("data journal change detection", () => {
  const dataDoc = { getFlag: (_s: string, k: string) => (k === FLAGS.dataJournal ? true : undefined) };
  const otherDoc = { getFlag: () => undefined };

  it("reports which store flag changed on the data journal", () => {
    expect(dataJournalChange(dataDoc, { flags: { [MODULE_ID]: { [FLAGS.tags]: {} } } })).toEqual({
      tags: true,
      themes: false,
    });
    expect(dataJournalChange(dataDoc, { flags: { [MODULE_ID]: { [`-=${FLAGS.themes}`]: null } } })).toEqual({
      tags: false,
      themes: true,
    });
    expect(dataJournalChange(dataDoc, { name: "Renamed" })).toEqual({ tags: false, themes: false });
  });

  it("ignores other journals, and treats create/delete of the data journal as a full change", () => {
    expect(dataJournalChange(otherDoc, { flags: { [MODULE_ID]: { [FLAGS.tags]: {} } } })).toEqual({
      tags: false,
      themes: false,
    });
    expect(dataJournalChange(otherDoc)).toEqual({ tags: false, themes: false });
    expect(dataJournalChange(dataDoc)).toEqual({ tags: true, themes: true });
    expect(
      dataJournalChange(otherDoc, { flags: { [MODULE_ID]: { [`-=${FLAGS.dataJournal}`]: null } } }),
    ).toEqual({ tags: true, themes: true });
  });
});
