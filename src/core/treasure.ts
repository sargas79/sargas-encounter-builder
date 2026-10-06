/**
 * Treasure budget and generation (pure). Budgets come from GM Core Table 10-9 (src/rules), scaled by
 * party size and by the share of a level the encounter represents. Generation fills item slots from a
 * candidate list without exceeding the budget's total value, then turns the remainder into currency.
 */
import { TREASURE_BY_LEVEL, XP_PER_LEVEL, type TreasureSlot } from "../rules/treasure-tables.js";
import { pickWeighted, type Rng } from "./rng.js";

export type TreasureKind = "permanent" | "consumable" | "valuable";

export interface TreasureCandidate {
  uuid: string;
  name: string;
  level: number;
  /** Price in gp (fractions allowed). */
  price: number;
  rarity: string;
  kind: TreasureKind;
  /** Item type as the system reports it (weapon, armor, equipment, consumable, treasure...). */
  category: string;
  traits: string[];
  img: string | null;
}

export interface TreasureBudget {
  level: number;
  partySize: number;
  /** Fraction of a level's treasure (1 = a whole level). */
  share: number;
  /** Total value in gp after scaling. */
  totalValue: number;
  /** Expected (fractional) item slots after scaling. */
  permanent: { level: number; expected: number }[];
  consumables: { level: number; expected: number }[];
  /** Currency in gp after party-size and share scaling. */
  currency: number;
  /** The unscaled row, for display. */
  perLevel: { total: number; currency: number; perExtraPC: number };
}

export interface TreasureOptions {
  allowUncommon: boolean;
  allowRare: boolean;
  includeConsumables: boolean;
  /** Fraction of the currency handed out as gems and art objects instead of coins (0..1). */
  valuablesShare: number;
  /** Traits that make an item more likely (the encounter theme). */
  preferTraits: string[];
  /** Item categories to exclude entirely (e.g. "armor"). */
  excludeCategories: string[];
}

export interface TreasureEntry {
  uuid: string;
  name: string;
  level: number;
  price: number;
  rarity: string;
  kind: TreasureKind;
  category: string;
  img: string | null;
  /** Slot level this entry was chosen for (may differ from the item level when relaxed). */
  slotLevel: number;
  locked: boolean;
}

export interface Coins {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

export interface TreasureResult {
  budget: TreasureBudget;
  entries: TreasureEntry[];
  /** Value of items (gp). */
  itemsValue: number;
  /** Currency actually awarded (gp), coins plus valuables. */
  currencyValue: number;
  coins: Coins;
  trace: string[];
  seed: string | null;
}

export const DEFAULT_TREASURE_OPTIONS: TreasureOptions = {
  allowUncommon: true,
  allowRare: false,
  includeConsumables: true,
  valuablesShare: 0,
  preferTraits: [],
  excludeCategories: [],
};

export const MIN_TREASURE_LEVEL = 1;
/** Lowest item level a slot may relax to. Table rows start at 1, but level-0 items exist. */
export const MIN_ITEM_LEVEL = 0;
export const MAX_TREASURE_LEVEL = 20;

/* -------------------------------------------- */
/*  Budget                                      */
/* -------------------------------------------- */

export function clampTreasureLevel(level: number): number {
  return Math.min(MAX_TREASURE_LEVEL, Math.max(MIN_TREASURE_LEVEL, Math.round(level)));
}

/** Share of a level's treasure an encounter of `xp` represents (a level is ~1,000 XP). */
export function shareFromXP(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0;
  return Math.min(1, xp / XP_PER_LEVEL);
}

export function treasureBudget(input: { level: number; partySize: number; share: number }): TreasureBudget {
  const level = clampTreasureLevel(input.level);
  const row = TREASURE_BY_LEVEL[level]!;
  const partySize = Math.max(1, Math.round(input.partySize));
  const share = Math.max(0, Math.min(4, input.share));
  const extra = partySize - 4;
  // Currency scales with party size (per-extra-PC column); item slots do not.
  const currencyForParty = Math.max(0, row.currency + extra * row.perExtraPC);
  const totalForParty = Math.max(0, row.total + extra * row.perExtraPC);
  const scaleSlots = (slots: TreasureSlot[]) =>
    slots.map((s) => ({ level: s.level, expected: round2(s.count * share) }));
  return {
    level,
    partySize,
    share,
    totalValue: round2(totalForParty * share),
    permanent: scaleSlots(row.permanent),
    consumables: scaleSlots(row.consumables),
    currency: round2(currencyForParty * share),
    perLevel: { total: row.total, currency: row.currency, perExtraPC: row.perExtraPC },
  };
}

/* -------------------------------------------- */
/*  Generation                                  */
/* -------------------------------------------- */

export interface TreasureInput {
  budget: TreasureBudget;
  candidates: TreasureCandidate[];
  options: TreasureOptions;
  rng: Rng;
  seed?: string | null;
  /** Entries kept from a previous result; their value is spent first. */
  locked?: TreasureEntry[];
}

export function generateTreasure(input: TreasureInput): TreasureResult {
  const { budget, options, rng } = input;
  const trace: string[] = [];
  const locked = (input.locked ?? []).map((e) => ({ ...e, locked: true }));
  const entries: TreasureEntry[] = [...locked];
  const chosen = new Set(entries.map((e) => e.uuid));
  let remaining = budget.totalValue - locked.reduce((n, e) => n + e.price, 0);
  trace.push(
    `Budget: level ${budget.level}, party ${budget.partySize}, share ${pct(budget.share)} → ${fmt(budget.totalValue)} gp total, ${fmt(budget.currency)} gp currency.`,
  );
  if (locked.length)
    trace.push(`Kept ${locked.length} locked item(s) worth ${fmt(budget.totalValue - remaining)} gp.`);

  const eligible = input.candidates.filter((c) => isEligible(c, options));
  const fillKind = (kind: "permanent" | "consumable", slots: { level: number; expected: number }[]) => {
    for (const slot of slots) {
      const count = stochasticRound(slot.expected, rng);
      const lockedHere = locked.filter((e) => e.kind === kind && e.slotLevel === slot.level).length;
      for (let i = lockedHere; i < count; i++) {
        const pickResult = pickForSlot(eligible, kind, slot.level, remaining, chosen, options, rng);
        if (!pickResult) {
          trace.push(`${kindLabel(kind)} slot (level ${slot.level}): nothing fits in ${fmt(remaining)} gp.`);
          continue;
        }
        const { candidate, relaxedTo } = pickResult;
        entries.push(entryFromCandidate(candidate, slot.level));
        chosen.add(candidate.uuid);
        remaining = round2(remaining - candidate.price);
        trace.push(
          `${kindLabel(kind)} slot (level ${slot.level}): ${candidate.name} (level ${candidate.level}, ${fmt(candidate.price)} gp${
            relaxedTo !== null ? `, relaxed to level ${relaxedTo}` : ""
          }).`,
        );
      }
    }
  };

  fillKind("permanent", budget.permanent);
  if (options.includeConsumables) fillKind("consumable", budget.consumables);
  else trace.push("Consumables skipped by option.");

  // Whatever the items did not use becomes currency, never less than zero. Locked valuables already
  // count toward the gems-and-art share.
  const lockedValuables = round2(
    locked.filter((e) => e.kind === "valuable").reduce((n, e) => n + e.price, 0),
  );
  const currency = Math.max(0, remaining + lockedValuables);
  const valuablesTarget = round2(currency * Math.max(0, Math.min(1, options.valuablesShare)));
  let valuablesValue = lockedValuables;
  let guard = 0;
  while (valuablesValue < valuablesTarget && guard++ < 20) {
    const room = valuablesTarget - valuablesValue;
    const pool = eligible.filter((c) => c.kind === "valuable" && c.price <= room && !chosen.has(c.uuid));
    if (pool.length === 0) break;
    const candidate = pickWeighted(rng, pool, (c) => 1 + c.price / Math.max(1, room));
    entries.push(entryFromCandidate(candidate, candidate.level));
    chosen.add(candidate.uuid);
    valuablesValue = round2(valuablesValue + candidate.price);
    trace.push(`Valuable: ${candidate.name} (${fmt(candidate.price)} gp).`);
  }
  const settled = settle({
    budget,
    entries,
    itemsValue: 0,
    currencyValue: 0,
    coins: { pp: 0, gp: 0, sp: 0, cp: 0 },
    trace,
    seed: input.seed ?? null,
  });
  trace.push(
    `Currency: ${fmt(coinsToGp(settled.coins))} gp in coins${valuablesValue ? ` + ${fmt(valuablesValue)} gp in valuables` : ""}.`,
  );
  return settled;
}

/** Pick a replacement for one entry: same kind and slot level, not already present, within `room`. */
export function replaceTreasureEntry(
  result: TreasureResult,
  uuid: string,
  candidates: TreasureCandidate[],
  options: TreasureOptions,
  rng: Rng,
): TreasureResult | null {
  const index = result.entries.findIndex((e) => e.uuid === uuid);
  if (index < 0) return null;
  const old = result.entries[index]!;
  const chosen = new Set(result.entries.map((e) => e.uuid));
  const others = result.entries.filter((e) => e.uuid !== uuid);
  const othersValue = others.reduce((n, e) => n + e.price, 0);
  const room = round2(result.budget.totalValue - othersValue);
  const eligible = candidates.filter((c) => isEligible(c, options));
  let pickResult: { candidate: TreasureCandidate } | null;
  if (old.kind === "valuable") {
    // A replacement gem stays inside the gems-and-art share, never the whole purse.
    const itemsValue = others.filter((e) => e.kind !== "valuable").reduce((n, e) => n + e.price, 0);
    const otherValuables = others.filter((e) => e.kind === "valuable").reduce((n, e) => n + e.price, 0);
    const currency = Math.max(0, result.budget.totalValue - itemsValue);
    const target = currency * Math.max(0, Math.min(1, options.valuablesShare));
    const valuableRoom = Math.min(room, Math.max(old.price, round2(target - otherValuables)));
    pickResult = pickValuable(eligible, valuableRoom, chosen, rng);
  } else {
    pickResult = pickForSlot(eligible, old.kind, old.slotLevel, room, chosen, options, rng);
  }
  if (!pickResult) return null;
  const { candidate } = pickResult;
  const entries = [...result.entries];
  entries[index] = entryFromCandidate(candidate, old.slotLevel);
  return settle({
    ...result,
    entries,
    trace: [...result.trace, `Replaced ${old.name} with ${candidate.name}.`],
  });
}

/** Drop an entry; its value returns to the currency. */
export function removeTreasureEntry(result: TreasureResult, uuid: string): TreasureResult {
  return settle({ ...result, entries: result.entries.filter((e) => e.uuid !== uuid) });
}

export function toggleTreasureLock(result: TreasureResult, uuid: string): TreasureResult {
  return {
    ...result,
    entries: result.entries.map((e) => (e.uuid === uuid ? { ...e, locked: !e.locked } : e)),
  };
}

/** Recompute values and coins after the entry list changed. */
export function settle(result: TreasureResult): TreasureResult {
  const itemsValue = round2(
    result.entries.filter((e) => e.kind !== "valuable").reduce((n, e) => n + e.price, 0),
  );
  const valuablesValue = round2(
    result.entries.filter((e) => e.kind === "valuable").reduce((n, e) => n + e.price, 0),
  );
  const coinsValue = Math.max(0, round2(result.budget.totalValue - itemsValue - valuablesValue));
  return {
    ...result,
    itemsValue,
    currencyValue: round2(coinsValue + valuablesValue),
    coins: toCoins(coinsValue),
  };
}

/** Split a gp amount into coins: platinum for large sums, gold, then silver and copper for fractions. */
export function toCoins(gp: number): Coins {
  let rest = Math.max(0, Math.round(gp * 100));
  // Platinum only for large hoards, so a 30 gp purse stays gold.
  const pp = rest >= 100_000 ? Math.floor(rest / 1000) : 0;
  rest -= pp * 1000;
  const gold = Math.floor(rest / 100);
  rest -= gold * 100;
  const sp = Math.floor(rest / 10);
  const cp = rest - sp * 10;
  return { pp, gp: gold, sp, cp };
}

export function coinsToGp(coins: Coins): number {
  return round2(coins.pp * 10 + coins.gp + coins.sp / 10 + coins.cp / 100);
}

export function formatCoins(coins: Coins): string {
  const parts: string[] = [];
  if (coins.pp) parts.push(`${coins.pp} pp`);
  if (coins.gp) parts.push(`${coins.gp} gp`);
  if (coins.sp) parts.push(`${coins.sp} sp`);
  if (coins.cp) parts.push(`${coins.cp} cp`);
  return parts.length ? parts.join(", ") : "0 gp";
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

export function entryFromCandidate(candidate: TreasureCandidate, slotLevel: number): TreasureEntry {
  return {
    uuid: candidate.uuid,
    name: candidate.name,
    level: candidate.level,
    price: candidate.price,
    rarity: candidate.rarity,
    kind: candidate.kind,
    category: candidate.category,
    img: candidate.img,
    slotLevel,
    locked: false,
  };
}

/** "12" or "12.34": the one number formatter for traces, cards and the panel. */
export function formatGp(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function isEligible(c: TreasureCandidate, options: TreasureOptions): boolean {
  if (!(c.price > 0)) return false;
  if (options.excludeCategories.includes(c.category)) return false;
  switch (c.rarity) {
    case "uncommon":
      return options.allowUncommon;
    case "rare":
    case "unique":
      return options.allowRare;
    default:
      return true;
  }
}

function pickForSlot(
  eligible: TreasureCandidate[],
  kind: "permanent" | "consumable",
  slotLevel: number,
  room: number,
  chosen: Set<string>,
  options: TreasureOptions,
  rng: Rng,
): { candidate: TreasureCandidate; relaxedTo: number | null } | null {
  for (let level = slotLevel; level >= Math.max(MIN_ITEM_LEVEL, slotLevel - 2); level--) {
    const pool = eligible.filter(
      (c) => c.kind === kind && c.level === level && c.price <= room && !chosen.has(c.uuid),
    );
    if (pool.length === 0) continue;
    const prefer = new Set(options.preferTraits.map((t) => t.toLowerCase()));
    const candidate = pickWeighted(rng, pool, (c) =>
      prefer.size && c.traits.some((t) => prefer.has(t.toLowerCase())) ? 3 : 1,
    );
    return { candidate, relaxedTo: level === slotLevel ? null : level };
  }
  return null;
}

function pickValuable(
  eligible: TreasureCandidate[],
  room: number,
  chosen: Set<string>,
  rng: Rng,
): { candidate: TreasureCandidate; relaxedTo: null } | null {
  const pool = eligible.filter((c) => c.kind === "valuable" && c.price <= room && !chosen.has(c.uuid));
  if (pool.length === 0) return null;
  return { candidate: pickWeighted(rng, pool, () => 1), relaxedTo: null };
}

/** Round `x` to an integer whose expectation is `x` (0.3 → 0 or 1, 1 in 0.3 of rolls). */
export function stochasticRound(x: number, rng: Rng): number {
  const base = Math.floor(x);
  return base + (rng() < x - base ? 1 : 0);
}

function kindLabel(kind: TreasureKind): string {
  return kind === "permanent" ? "Permanent" : kind === "consumable" ? "Consumable" : "Valuable";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const fmt = formatGp;

function pct(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}
