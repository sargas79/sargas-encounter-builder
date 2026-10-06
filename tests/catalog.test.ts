import { describe, expect, it } from "vitest";
import {
  catalogEntryFromIndex,
  filterCatalog,
  parseTagText,
  type CatalogEntry,
} from "../src/core/catalog.js";
import { CreatureCatalog, type PackInfo, type PackProvider } from "../src/foundry/creature-catalog.js";
import type { RawIndexEntry } from "../src/core/catalog.js";

function raw(id: string, name: string, level: number, traits: string[] = [], type = "npc"): RawIndexEntry {
  return {
    _id: id,
    name,
    type,
    img: "icons/x.png",
    system: {
      details: { level: { value: level }, publication: { title: "Test Book" } },
      traits: { value: traits, rarity: "common", size: { value: "med" } },
    },
  };
}

class FakeProvider implements PackProvider {
  indexCalls: string[] = [];
  documentCalls: string[] = [];
  constructor(
    public packs: PackInfo[],
    public indexes: Record<string, RawIndexEntry[]>,
  ) {}
  listActorPacks() {
    return this.packs;
  }
  async getIndex(packId: string, fields: readonly string[]) {
    this.indexCalls.push(packId);
    expect(fields).toContain("system.details.level.value");
    const entries = this.indexes[packId];
    if (!entries) throw new Error("boom");
    return entries.map((e) => ({ ...e, uuid: `Compendium.${packId}.Actor.${e._id}` }));
  }
  async getDocument(uuid: string) {
    this.documentCalls.push(uuid);
    return null;
  }
}

function memoryPacks(initial: string[] = []) {
  let ids = initial;
  return { get: () => ids, set: async (v: string[]) => void (ids = v) };
}

describe("T8: search and add use indexes only, never importing or loading documents", () => {
  const packs: PackInfo[] = [
    { id: "world.beasts", label: "Beasts", packageName: "world", accessible: true },
    { id: "world.secret", label: "Secret", packageName: "world", accessible: false },
    { id: "world.broken", label: "Broken", packageName: "world", accessible: true },
  ];
  const provider = () =>
    new FakeProvider(packs, {
      "world.beasts": [
        raw("a", "Ash Hound", 2, ["beast", "fire"]),
        raw("b", "Bog Lurker", 4, ["aberration"]),
        raw("c", "Cave Prince", 6, ["humanoid"]),
        raw("h", "Hero", 5, [], "character"),
        raw("z", "Hazard-ish", 3, [], "hazard"),
      ],
    });

  it("loads indexes with the requested fields and excludes non-NPCs", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(p, undefined, memoryPacks(["world.beasts"]));
    const results = await catalog.search({});
    expect(results.map((e) => e.name)).toEqual(["Ash Hound", "Bog Lurker", "Cave Prince"]);
    expect(p.indexCalls).toEqual(["world.beasts"]);
    expect(p.documentCalls).toEqual([]);
    expect(catalog.documentLoadCount).toBe(0);
    expect(catalog.packState("world.beasts")).toEqual({ state: "loaded", count: 3, skipped: 0 });
  });

  it("filters by name, level, traits and relative level without loading documents", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(p, undefined, memoryPacks(["world.beasts"]));
    expect((await catalog.search({ search: "bog" })).map((e) => e.name)).toEqual(["Bog Lurker"]);
    expect((await catalog.search({ levelMin: 3 })).map((e) => e.name)).toEqual(["Bog Lurker", "Cave Prince"]);
    expect((await catalog.search({ traits: ["fire"] })).map((e) => e.name)).toEqual(["Ash Hound"]);
    expect(
      (await catalog.search({ referenceLevel: 4, relativeMin: -1, relativeMax: 1 })).map((e) => e.name),
    ).toEqual(["Bog Lurker"]);
    expect(p.documentCalls).toEqual([]);
  });

  it("caches indexes and reloads only after invalidation or refresh", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(p, undefined, memoryPacks(["world.beasts"]));
    await catalog.search({});
    await catalog.search({ search: "x" });
    expect(p.indexCalls).toHaveLength(1);
    catalog.invalidate("world.beasts");
    await catalog.search({});
    expect(p.indexCalls).toHaveLength(2);
    await catalog.refresh();
    expect(p.indexCalls).toHaveLength(3);
  });

  it("reports inaccessible, missing and error states instead of guessing", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(
      p,
      undefined,
      memoryPacks(["world.secret", "world.gone", "world.broken", "world.beasts"]),
    );
    expect(catalog.missingSelectedPackIds()).toEqual(["world.gone"]);
    await catalog.ensureLoaded(["world.secret", "world.broken"]);
    expect(catalog.packState("world.secret")).toEqual({ state: "inaccessible" });
    expect(catalog.packState("world.broken")).toEqual({ state: "error", message: "boom" });
    expect(await catalog.search({})).toHaveLength(3);
  });

  it("locates an entry from a non-selected pack by UUID and applies tags", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(
      p,
      { tagsFor: (uuid) => (uuid.endsWith(".a") ? ["environment:volcano"] : []) },
      memoryPacks([]),
    );
    const entry = await catalog.locate("Compendium.world.beasts.Actor.a");
    expect(entry?.name).toBe("Ash Hound");
    expect(entry?.tags).toEqual(["environment:volcano"]);
    expect(await catalog.search({ tags: ["environment:volcano"] }, ["world.beasts"])).toHaveLength(1);
    expect(p.documentCalls).toEqual([]);
  });

  it("bumps its version when entries, tags or the selection change, not on cached searches", async () => {
    const catalog = new CreatureCatalog(provider(), undefined, memoryPacks(["world.beasts"]));
    const v0 = catalog.version;
    await catalog.search({});
    const v1 = catalog.version;
    expect(v1).toBeGreaterThan(v0);
    await catalog.search({ search: "bog" });
    expect(catalog.version).toBe(v1);
    catalog.retag();
    expect(catalog.version).toBeGreaterThan(v1);
    const v2 = catalog.version;
    await catalog.setSelectedPacks(["world.beasts"]);
    expect(catalog.version).toBeGreaterThan(v2);
  });

  it("only loadDocument touches full documents", async () => {
    const p = provider();
    const catalog = new CreatureCatalog(p, undefined, memoryPacks(["world.beasts"]));
    await catalog.loadDocument("Compendium.world.beasts.Actor.a");
    expect(p.documentCalls).toEqual(["Compendium.world.beasts.Actor.a"]);
    expect(catalog.documentLoadCount).toBe(1);
  });
});

describe("catalog model", () => {
  it("skips index entries without a level and non-NPC types", () => {
    const pack = { id: "p", label: "P" };
    expect(catalogEntryFromIndex({ _id: "1", name: "X", type: "npc", system: {} }, pack)).toBeNull();
    expect(catalogEntryFromIndex(raw("1", "X", 1, [], "character"), pack)).toBeNull();
    expect(catalogEntryFromIndex(raw("1", "X", 1), pack)?.uuid).toBe("Compendium.p.Actor.1");
  });

  it("sorts by level then name and supports exclusions", () => {
    const entries: CatalogEntry[] = [
      { ...catalogEntryFromIndex(raw("1", "Zed", 2), { id: "p", label: "P" })! },
      { ...catalogEntryFromIndex(raw("2", "Amy", 2), { id: "p", label: "P" })! },
      { ...catalogEntryFromIndex(raw("3", "Bob", 1), { id: "p", label: "P" })! },
    ];
    expect(filterCatalog(entries, {}).map((e) => e.name)).toEqual(["Bob", "Amy", "Zed"]);
    expect(filterCatalog(entries, { excludeUuids: ["Compendium.p.Actor.3"] }).map((e) => e.name)).toEqual([
      "Amy",
      "Zed",
    ]);
  });

  it("parses tag text", () => {
    expect(parseTagText("Family:Goblinoid, environment:forest; bad; env:swamp\nfamily:goblinoid")).toEqual([
      "family:goblinoid",
      "environment:forest",
      "env:swamp",
    ]);
  });
});

describe("tag store schema", () => {
  it("uses array entries so UUIDs (which contain dots) are never object keys", async () => {
    const { validateTagStore, emptyTagStore } = await import("../src/core/schemas.js");
    expect(emptyTagStore()).toEqual({ schemaVersion: 1, entries: [] });
    expect(
      validateTagStore({ schemaVersion: 1, entries: [{ uuid: "Compendium.a.b.Actor.c", tags: ["x:y"] }] }).ok,
    ).toBe(true);
    const legacy = validateTagStore({
      schemaVersion: 1,
      tags: { "Compendium.a.b.Actor.c": ["family:goblinoid"] },
    });
    expect(legacy).toEqual({
      ok: true,
      value: { schemaVersion: 1, entries: [{ uuid: "Compendium.a.b.Actor.c", tags: ["family:goblinoid"] }] },
    });
    expect(validateTagStore({ schemaVersion: 1 }).ok).toBe(false);
  });
});
