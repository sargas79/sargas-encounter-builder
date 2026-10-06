import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { TREASURE_BY_LEVEL } from "../src/rules/treasure-tables.js";
import { coinKey, priceInGp, toCandidate } from "../src/foundry/item-catalog.js";
import { validateRecipe } from "../src/core/schemas.js";
import { TreasureService, treasureCardHtml } from "../src/foundry/treasure-service.js";
import { mulberry32 } from "../src/core/rng.js";
import {
  DEFAULT_TREASURE_OPTIONS,
  coinsToGp,
  formatCoins,
  generateTreasure,
  removeTreasureEntry,
  replaceTreasureEntry,
  shareFromXP,
  toCoins,
  toggleTreasureLock,
  treasureBudget,
  type TreasureCandidate,
  type TreasureOptions,
} from "../src/core/treasure.js";

function candidate(
  uuid: string,
  level: number,
  price: number,
  kind: TreasureCandidate["kind"] = "permanent",
  extra: Partial<TreasureCandidate> = {},
): TreasureCandidate {
  return {
    uuid,
    name: uuid,
    level,
    price,
    rarity: "common",
    kind,
    category: kind === "consumable" ? "consumable" : kind === "valuable" ? "treasure" : "weapon",
    traits: [],
    img: null,
    ...extra,
  };
}

/** Three items of every kind at every level 1..20, priced roughly like the system's items. */
function pool(): TreasureCandidate[] {
  const out: TreasureCandidate[] = [];
  for (let level = 1; level <= 20; level++) {
    const base = TREASURE_BY_LEVEL[level]!.total / 8;
    for (let i = 0; i < 3; i++) {
      out.push(candidate(`perm-${level}-${i}`, level, Math.round(base * (0.6 + i * 0.3))));
      out.push(candidate(`cons-${level}-${i}`, level, Math.round(base / 5) + i, "consumable"));
    }
  }
  for (let i = 1; i <= 10; i++) out.push(candidate(`gem-${i}`, 0, i * 10, "valuable"));
  return out;
}

const options = (over: Partial<TreasureOptions> = {}): TreasureOptions => ({
  ...DEFAULT_TREASURE_OPTIONS,
  ...over,
});

describe("treasure budget (GM Core Table 10-9)", () => {
  it("returns the table row for a party of four over a whole level", () => {
    const b = treasureBudget({ level: 5, partySize: 4, share: 1 });
    expect(b.totalValue).toBe(1350);
    expect(b.currency).toBe(320);
    expect(b.permanent).toEqual([
      { level: 6, expected: 2 },
      { level: 5, expected: 2 },
    ]);
    expect(b.consumables.map((s) => s.level)).toEqual([6, 5, 4]);
  });

  it("adds and removes currency per PC beyond or below four", () => {
    expect(treasureBudget({ level: 5, partySize: 6, share: 1 }).currency).toBe(320 + 2 * 80);
    expect(treasureBudget({ level: 5, partySize: 3, share: 1 }).currency).toBe(320 - 80);
    expect(treasureBudget({ level: 5, partySize: 6, share: 1 }).permanent[0]!.expected).toBe(2);
  });

  it("scales value, currency and slots by the share", () => {
    const b = treasureBudget({ level: 10, partySize: 4, share: 0.08 });
    expect(b.totalValue).toBe(640);
    expect(b.currency).toBe(160);
    expect(b.permanent[0]!.expected).toBe(0.16);
  });

  it("clamps the level into 1..20 and the share into 0..4", () => {
    expect(treasureBudget({ level: 0, partySize: 4, share: 1 }).level).toBe(1);
    expect(treasureBudget({ level: 25, partySize: 4, share: 1 }).level).toBe(20);
    expect(treasureBudget({ level: 3, partySize: 4, share: -1 }).totalValue).toBe(0);
  });

  it("derives the share from encounter XP (a level is 1,000 XP)", () => {
    expect(shareFromXP(80)).toBe(0.08);
    expect(shareFromXP(1200)).toBe(1);
    expect(shareFromXP(0)).toBe(0);
    expect(shareFromXP(Number.NaN)).toBe(0);
  });

  it("has a complete, monotonic table", () => {
    for (let level = 1; level <= 20; level++) {
      const row = TREASURE_BY_LEVEL[level]!;
      expect(row.total).toBeGreaterThan(0);
      expect(row.currency).toBeLessThan(row.total);
      if (level > 1) expect(row.total).toBeGreaterThan(TREASURE_BY_LEVEL[level - 1]!.total);
      for (const s of [...row.permanent, ...row.consumables]) expect(s.level).toBeLessThanOrEqual(20);
    }
  });
});

describe("treasure generation", () => {
  it("never exceeds the total value and is deterministic for a seed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 8 }),
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.integer({ min: 1, max: 100000 }),
        (level, partySize, share, seed) => {
          const budget = treasureBudget({ level, partySize, share });
          const run = () =>
            generateTreasure({ budget, candidates: pool(), options: options(), rng: mulberry32(seed) });
          const a = run();
          const b = run();
          expect(a.entries.map((e) => e.uuid)).toEqual(b.entries.map((e) => e.uuid));
          expect(a.itemsValue + a.currencyValue).toBeLessThanOrEqual(budget.totalValue + 0.01);
          expect(a.coins.gp + a.coins.pp + a.coins.sp + a.coins.cp).toBeGreaterThanOrEqual(0);
          for (const e of a.entries) expect(e.level).toBeLessThanOrEqual(Math.max(e.slotLevel, 1));
        },
      ),
      { numRuns: 150 },
    );
  });

  it("fills every slot over a whole level when the pool allows and spends the rest as coins", () => {
    const budget = treasureBudget({ level: 5, partySize: 4, share: 1 });
    const r = generateTreasure({ budget, candidates: pool(), options: options(), rng: mulberry32(7) });
    expect(r.entries.filter((e) => e.kind === "permanent")).toHaveLength(4);
    expect(r.entries.filter((e) => e.kind === "consumable")).toHaveLength(6);
    expect(r.itemsValue + coinsToGp(r.coins)).toBeCloseTo(budget.totalValue, 1);
    expect(r.trace.length).toBeGreaterThan(5);
  });

  it("relaxes a slot by up to two levels and records it in the trace", () => {
    const budget = treasureBudget({ level: 5, partySize: 4, share: 1 });
    const only = pool().filter((c) => c.kind !== "permanent" || c.level === 4);
    const r = generateTreasure({ budget, candidates: only, options: options(), rng: mulberry32(1) });
    expect(r.entries.filter((e) => e.kind === "permanent").every((e) => e.level === 4)).toBe(true);
    expect(r.trace.some((line) => line.includes("relaxed to level 4"))).toBe(true);
  });

  it("relaxes low-level slots down to level-0 items", () => {
    const budget = treasureBudget({ level: 1, partySize: 4, share: 1 });
    expect(budget.level).toBe(1);
    const zero = [
      ...Array.from({ length: 6 }, (_, i) => candidate(`perm0-${i}`, 0, 1)),
      ...Array.from({ length: 6 }, (_, i) => candidate(`cons0-${i}`, 0, 1, "consumable")),
    ];
    const r = generateTreasure({ budget, candidates: zero, options: options(), rng: mulberry32(3) });
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.every((e) => e.level === 0)).toBe(true);
    expect(r.trace.some((line) => line.includes("relaxed to level 0"))).toBe(true);
    // The budget row lookup itself still starts at level 1.
    expect(treasureBudget({ level: 0, partySize: 4, share: 1 }).level).toBe(1);
  });

  it("respects rarity options and excluded categories", () => {
    const budget = treasureBudget({ level: 3, partySize: 4, share: 1 });
    const rare = pool().map((c) => ({ ...c, rarity: "rare" }));
    const none = generateTreasure({ budget, candidates: rare, options: options(), rng: mulberry32(1) });
    expect(none.entries).toHaveLength(0);
    expect(coinsToGp(none.coins)).toBe(budget.totalValue);
    const some = generateTreasure({
      budget,
      candidates: rare,
      options: options({ allowRare: true }),
      rng: mulberry32(1),
    });
    expect(some.entries.length).toBeGreaterThan(0);
    const noWeapons = generateTreasure({
      budget,
      candidates: pool(),
      options: options({ excludeCategories: ["weapon"] }),
      rng: mulberry32(1),
    });
    expect(noWeapons.entries.every((e) => e.category !== "weapon")).toBe(true);
  });

  it("prefers theme traits strongly", () => {
    const budget = treasureBudget({ level: 2, partySize: 4, share: 1 });
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) => candidate(`plain-${i}`, 3, 30)),
      candidate("themed", 3, 30, "permanent", { traits: ["necromancy"] }),
    ];
    let hits = 0;
    for (let seed = 0; seed < 100; seed++) {
      const r = generateTreasure({
        budget,
        candidates,
        options: options({ includeConsumables: false, preferTraits: ["Necromancy"] }),
        rng: mulberry32(seed),
      });
      if (r.entries.some((e) => e.uuid === "themed")) hits++;
    }
    expect(hits).toBeGreaterThan(60);
  });

  it("hands out part of the currency as valuables when asked", () => {
    const budget = treasureBudget({ level: 4, partySize: 4, share: 1 });
    const r = generateTreasure({
      budget,
      candidates: pool(),
      options: options({ valuablesShare: 0.5 }),
      rng: mulberry32(3),
    });
    const valuables = r.entries.filter((e) => e.kind === "valuable");
    expect(valuables.length).toBeGreaterThan(0);
    expect(r.itemsValue + r.currencyValue).toBeLessThanOrEqual(budget.totalValue + 0.01);
  });

  it("keeps locked entries, replaces single rows within budget, and removes rows back into coins", () => {
    const budget = treasureBudget({ level: 6, partySize: 4, share: 1 });
    const first = generateTreasure({ budget, candidates: pool(), options: options(), rng: mulberry32(11) });
    const lockedUuid = first.entries[0]!.uuid;
    const locked = toggleTreasureLock(first, lockedUuid).entries.filter((e) => e.locked);
    const second = generateTreasure({
      budget,
      candidates: pool(),
      options: options(),
      rng: mulberry32(12),
      locked,
    });
    expect(second.entries[0]!.uuid).toBe(lockedUuid);
    expect(second.entries[0]!.locked).toBe(true);

    const target = second.entries[1]!;
    const replaced = replaceTreasureEntry(second, target.uuid, pool(), options(), mulberry32(5));
    expect(replaced).not.toBeNull();
    expect(replaced!.entries[1]!.uuid).not.toBe(target.uuid);
    expect(replaced!.entries[1]!.kind).toBe(target.kind);
    expect(replaced!.itemsValue + replaced!.currencyValue).toBeLessThanOrEqual(budget.totalValue + 0.01);

    const removed = removeTreasureEntry(replaced!, replaced!.entries[1]!.uuid);
    expect(removed.entries).toHaveLength(replaced!.entries.length - 1);
    expect(coinsToGp(removed.coins)).toBeGreaterThan(coinsToGp(replaced!.coins));
  });
});

describe("review regressions", () => {
  it("counts locked valuables toward the gems share and reports the full hoard value", () => {
    const budget = treasureBudget({ level: 3, partySize: 4, share: 1 });
    const gem = { ...candidate("gem-5", 0, 50, "valuable"), slotLevel: 0, locked: true };
    const r = generateTreasure({
      budget,
      candidates: pool().filter((c) => c.kind === "valuable"),
      options: options({ valuablesShare: 0.1, includeConsumables: false }),
      rng: mulberry32(2),
      locked: [{ ...gem, locked: true }],
    });
    // 10% of 500 gp is 50 gp of valuables: the locked gem already covers it, so nothing else is added.
    expect(r.entries.filter((e) => e.kind === "valuable")).toHaveLength(1);
    expect(r.itemsValue + r.currencyValue).toBeCloseTo(budget.totalValue, 2);
    expect(r.currencyValue).toBeCloseTo(budget.totalValue, 2);
    expect(coinsToGp(r.coins)).toBeCloseTo(budget.totalValue - 50, 2);
  });
});

describe("0.3.2 review regressions", () => {
  it("recognises coin items by price so translated names still work", () => {
    const coin = (name: string, value: Record<string, number>) => ({
      _id: "x",
      name,
      type: "treasure",
      system: { stackGroup: "coins", price: { value } },
    });
    expect(coinKey(coin("Monete d'oro", { gp: 1 }))).toBe("gp");
    expect(coinKey(coin("Platinmünzen", { pp: 1 }))).toBe("pp");
    expect(coinKey(coin("Silver Pieces", { sp: 1 }))).toBe("sp");
    expect(coinKey(coin("Copper Pieces", { cp: 1 }))).toBe("cp");
    expect(
      coinKey({ _id: "y", name: "Gold Pieces", type: "treasure", system: { stackGroup: null } }),
    ).toBeNull();
  });

  it("budgets stack-priced items at the stack value and rounds odd levels", () => {
    expect(priceInGp({ value: { gp: 5 }, per: 10 })).toBe(5);
    const c = toCandidate(
      {
        _id: "a",
        name: "Arrows",
        type: "weapon",
        system: { level: { value: 1.5 }, price: { value: { sp: 1 }, per: 10 } },
      },
      "pack",
    );
    expect(c?.level).toBe(2);
    expect(c?.price).toBe(0.1);
  });

  it("drops a damaged treasure record without rejecting the saved encounter", () => {
    const recipe = {
      schemaVersion: 1,
      name: "Camp",
      notes: "",
      entries: [],
      origin: "manual",
      evaluation: null,
      createdAt: 1,
      updatedAt: 1,
      treasure: { seed: null, share: 1, options: { excludeCategories: "armor" }, entries: [], coins: {} },
    };
    const v = validateRecipe(recipe);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.treasure).toBeUndefined();
  });

  it("keeps a replaced gem inside the gems-and-art share", () => {
    const budget = treasureBudget({ level: 5, partySize: 4, share: 1 });
    const gems = [10, 20, 50, 200, 500, 900].map((p) => candidate(`gem-${p}`, 0, p, "valuable"));
    const first = generateTreasure({
      budget,
      candidates: [...pool().filter((c) => c.kind !== "valuable"), ...gems],
      options: options({ valuablesShare: 0.1 }),
      rng: mulberry32(4),
    });
    const gem = first.entries.find((e) => e.kind === "valuable");
    expect(gem).toBeDefined();
    const currency = budget.totalValue - first.itemsValue;
    for (let seed = 0; seed < 30; seed++) {
      const r = replaceTreasureEntry(
        first,
        gem!.uuid,
        gems,
        options({ valuablesShare: 0.1 }),
        mulberry32(seed),
      );
      if (!r) continue;
      const valuables = r.entries.filter((e) => e.kind === "valuable").reduce((n, e) => n + e.price, 0);
      expect(valuables).toBeLessThanOrEqual(Math.max(gem!.price, currency * 0.1) + 0.01);
    }
  });
});

describe("coins", () => {
  it("splits gold into denominations and back", () => {
    expect(toCoins(12.34)).toEqual({ pp: 0, gp: 12, sp: 3, cp: 4 });
    expect(coinsToGp(toCoins(12.34))).toBe(12.34);
    expect(toCoins(140000)).toEqual({ pp: 14000, gp: 0, sp: 0, cp: 0 });
    expect(formatCoins(toCoins(0))).toBe("0 gp");
    expect(formatCoins({ pp: 1, gp: 2, sp: 0, cp: 5 })).toBe("1 pp, 2 gp, 5 cp");
  });
});

describe("treasure service: adding to an actor", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.game;
    delete g.fromUuid;
  });

  function setup() {
    g.game = { user: { isGM: true } };
    g.fromUuid = async (uuid: string) => ({ toObject: () => ({ _id: "x", name: uuid, system: {} }) });
    const budget = treasureBudget({ level: 3, partySize: 4, share: 1 });
    const result = {
      ...generateTreasure({ budget, candidates: [], options: options(), rng: mulberry32(1) }),
      entries: [
        {
          ...generateTreasure({ budget, candidates: pool(), options: options(), rng: mulberry32(2) })
            .entries[0]!,
        },
      ],
      coins: { pp: 0, gp: 12, sp: 3, cp: 0 },
    };
    const created: Record<string, unknown>[] = [];
    const actor = {
      createEmbeddedDocuments: async (_name: string, data: Record<string, unknown>[]) => {
        created.push(...data);
        return data;
      },
    } as unknown as ActorDocument & { inventory?: unknown };
    const coinItems = { pp: "C.pp", gp: "C.gp", sp: "C.sp", cp: "C.cp" };
    return { result, actor, created, coinItems };
  }

  it("adds coins through PF2e inventory.addCoins when available, merging with existing coins", async () => {
    const { result, actor, created, coinItems } = setup();
    const added: unknown[] = [];
    actor.inventory = { addCoins: async (coins: unknown) => void added.push(coins) };
    const count = await new TreasureService().addToActor(result, actor, coinItems);
    expect(added).toEqual([{ gp: 12, sp: 3 }]);
    expect(created.map((d) => d.name)).toEqual([result.entries[0]!.uuid]);
    expect(count).toBe(3);
  });

  it("falls back to creating coin items without inventory.addCoins", async () => {
    const { result, actor, created, coinItems } = setup();
    const count = await new TreasureService().addToActor(result, actor, coinItems);
    expect(created.map((d) => d.name)).toEqual([result.entries[0]!.uuid, "C.gp", "C.sp"]);
    expect(created.slice(1).map((d) => (d.system as { quantity: number }).quantity)).toEqual([12, 3]);
    expect(count).toBe(3);
  });

  it("localizes the GM chat card", () => {
    g.game = {
      i18n: {
        localize: (key: string) => `L:${key.split(".").pop()}`,
        format: (key: string) => `F:${key.split(".").pop()}`,
      },
    };
    const budget = treasureBudget({ level: 3, partySize: 4, share: 1 });
    const result = generateTreasure({ budget, candidates: [], options: options(), rng: mulberry32(1) });
    const html = treasureCardHtml(result, "Hoard");
    expect(html).toContain("F:budget");
    expect(html).toContain("L:noItems");
    expect(html).toContain("L:coins");
    expect(html).toContain("F:totals");
    expect(html).not.toMatch(/party of|No items|Coins:/);
  });
});
