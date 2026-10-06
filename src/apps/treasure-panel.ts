/**
 * Treasure tab: GM Core treasure budget for the current party and encounter, seeded generation from
 * the equipment compendium, per-row lock/replace/remove, and three outputs (Loot actor, an actor the
 * GM points at, GM chat card).
 */
import { THREAT_BUDGETS } from "../rules/encounter-tables.js";
import { rngFromSeed } from "../core/rng.js";
import {
  DEFAULT_TREASURE_OPTIONS,
  coinsToGp,
  formatCoins,
  formatGp as gp,
  generateTreasure,
  removeTreasureEntry,
  replaceTreasureEntry,
  settle,
  shareFromXP,
  toggleTreasureLock,
  treasureBudget,
  type TreasureBudget,
  type TreasureEntry,
  type TreasureOptions,
  type TreasureResult,
} from "../core/treasure.js";
import type { TreasureRecordV1 } from "../core/schemas.js";
import { escapeHtml, randomHexSeed } from "../core/util.js";
import { isGM } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { TreasureService } from "../foundry/treasure-service.js";
import { confirm, promptSelect, promptText } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import { panelActions, type Panel } from "./panel.js";

export type TreasureMode = "encounter" | "level" | "custom";

export interface TreasurePanelOptions extends TreasureOptions {
  mode: TreasureMode;
  /** Custom share in percent (1..400). */
  customPercent: number;
  /** Treasure level override; null follows the party's reference level. */
  levelOverride: number | null;
  seed: string;
  useThemeTraits: boolean;
}

/** Saved form of a treasure result (stored on the recipe). */
export type TreasureRecord = TreasureRecordV1;

export class TreasurePanel implements Panel {
  readonly actions: ReadonlySet<string> = panelActions<TreasurePanel>(
    "setMode",
    "generate",
    "reroll",
    "lock",
    "replace",
    "remove",
    "clear",
    "inspect",
    "createLoot",
    "addToActor",
    "postChat",
  );
  readonly service = new TreasureService();
  options: TreasurePanelOptions = {
    ...DEFAULT_TREASURE_OPTIONS,
    mode: "encounter",
    customPercent: 25,
    levelOverride: null,
    seed: "",
    useThemeTraits: true,
  };
  result: TreasureResult | null = null;
  lastSeed: string | null = null;
  busy = false;
  lastOutput: string | null = null;
  #indexing = false;
  #rolledForOtherDraft = false;

  /** Load the equipment index once, with a visible busy state, outside the render lifecycle. */
  async ensureIndex(): Promise<void> {
    const { items } = services();
    if (items.loaded() || this.#indexing) return;
    this.#indexing = true;
    try {
      await items.ensureLoaded();
    } catch (error) {
      console.error("sargas-encounter-builder | item index failed", error);
    } finally {
      this.#indexing = false;
    }
    if (this.app.rendered) await this.app.render({ parts: ["treasure"] });
  }

  onTabShown(tab: string): void {
    if (tab === "treasure") void this.ensureIndex();
  }

  /** The draft was swapped for an unrelated one: the current hoard no longer belongs to it. */
  onDraftReplaced(): void {
    if (!this.result) return;
    if (this.options.mode === "encounter") {
      this.result = null;
      this.lastOutput = null;
    } else {
      this.#rolledForOtherDraft = true;
    }
  }

  constructor(private readonly app: EncounterBuilderApp) {}

  /* ---------------------------- budget ------------------------------ */

  share(): number {
    switch (this.options.mode) {
      case "level":
        return 1;
      case "custom":
        return Math.max(0.01, Math.min(4, this.options.customPercent / 100));
      default:
        return shareFromXP(this.encounterXP());
    }
  }

  /**
   * The draft's XP expressed for a party of four. Creature XP is budgeted against a party-size-scaled
   * target, and the treasure table scales currency by party size on its own, so the share must not
   * carry the party size twice.
   */
  encounterXP(): number {
    const evaluation = this.app.state.evaluation;
    const roster = this.app.state.resolved?.roster;
    if (!evaluation || !roster) return 0;
    const raw = evaluation.supportedXP;
    if (!(raw > 0)) return 0;
    const tier = evaluation.tier;
    const scale =
      tier && tier.target > 0
        ? THREAT_BUDGETS[tier.threat].base / tier.target
        : 80 / (80 + 20 * (roster.partySize - 4));
    return Math.round(raw * Math.max(0.1, Math.min(10, scale)));
  }

  /** Level the budget is read at: the GM's override, else the party's reference level. */
  level(): number | null {
    const partyLevel = this.app.state.resolved?.roster.reference.level ?? null;
    return this.options.levelOverride ?? partyLevel;
  }

  budget(): TreasureBudget | null {
    const roster = this.app.state.resolved?.roster;
    const level = this.level();
    if (!roster || level === null) return null;
    return treasureBudget({ level, partySize: roster.partySize, share: this.share() });
  }

  #themeTraits(): string[] {
    if (!this.options.useThemeTraits) return [];
    const last = this.app.panels.generator.lastResult;
    const theme = last && "theme" in last ? last.theme : null;
    const traits = new Set<string>();
    if (theme) {
      for (const trait of [theme.primaryTrait, theme.subTrait, ...theme.requiredTraits, ...theme.anyTraits])
        if (trait) traits.add(trait.toLowerCase());
    }
    for (const entry of this.app.state.draft.entries)
      for (const trait of entry.traits) traits.add(trait.toLowerCase());
    return [...traits];
  }

  /* ---------------------------- context ----------------------------- */

  async prepareContext(): Promise<Record<string, unknown>> {
    const ready = this.app.ready;
    const budget = ready ? this.budget() : null;
    const { items } = services();
    const packCount = items.availablePackIds().length;
    // The index loads in the background the first time the tab is shown; never inside a render.
    if (ready && this.app.activeTab === "treasure" && !items.loaded()) void this.ensureIndex();
    const result = this.result;
    const xp = this.encounterXP();
    const categories = items.categories();
    const partyLevel = this.app.state.resolved?.roster.reference.level ?? null;
    return {
      options: this.options,
      levels: Array.from({ length: 20 }, (_, i) => ({
        value: i + 1,
        selected: this.options.levelOverride === i + 1,
      })),
      partyLevel,
      levelIsParty: this.options.levelOverride === null,
      levelDiffers: this.options.levelOverride !== null && this.options.levelOverride !== partyLevel,
      modes: (["encounter", "level", "custom"] as TreasureMode[]).map((value) => ({
        value,
        label: t(`treasure.mode.${value}`),
        hint: t(`treasure.modeHint.${value}`),
        active: this.options.mode === value,
      })),
      isCustom: this.options.mode === "custom",
      valuablesPercent: Math.round(this.options.valuablesShare * 100),
      isEncounter: this.options.mode === "encounter",
      encounterXP: xp,
      budget: budget ? describeBudget(budget) : null,
      categories: categories.map((c) => ({
        value: c,
        label: t(`treasure.category.${c}`),
        excluded: this.options.excludeCategories.includes(c),
      })),
      themeTraits: this.#themeTraits().slice(0, 8).join(", "),
      canGenerate:
        ready && !!budget && budget.totalValue > 0 && !this.busy && packCount > 0 && items.loaded(),
      indexing: this.#indexing,
      staleDraft: !!result && this.#rolledForOtherDraft,
      hasResult: !!result,
      busy: this.busy,
      catalogCount: items.candidates().length,
      noItems: packCount === 0,
      result: result ? describeResult(result) : null,
      lastSeed: this.lastSeed,
      lastOutput: this.lastOutput,
      canOutput: !!result && isGM() && !this.busy,
    };
  }

  /* ---------------------------- inputs ------------------------------ */

  async onChange(name: string, value: string, target: HTMLElement): Promise<boolean> {
    if (!name.startsWith("treasure.")) return false;
    const key = name.slice("treasure.".length);
    const checked = (target as HTMLInputElement).checked;
    switch (key) {
      case "customPercent":
        this.options.customPercent = clampInt(value, 1, 400, 25);
        break;
      case "level":
        this.options.levelOverride = value === "" ? null : clampInt(value, 1, 20, 1);
        break;
      case "seed":
        this.options.seed = value.trim();
        break;
      case "allowUncommon":
        this.options.allowUncommon = checked;
        break;
      case "allowRare":
        this.options.allowRare = checked;
        break;
      case "includeConsumables":
        this.options.includeConsumables = checked;
        break;
      case "useThemeTraits":
        this.options.useThemeTraits = checked;
        break;
      case "valuablesShare":
        this.options.valuablesShare = clampInt(value, 0, 100, 0) / 100;
        break;
      case "category": {
        const category = target.dataset.category ?? "";
        const set = new Set(this.options.excludeCategories);
        if (checked) set.delete(category);
        else set.add(category);
        this.options.excludeCategories = [...set];
        break;
      }
      default:
        return false;
    }
    await this.app.render({ parts: ["treasure"] });
    return true;
  }

  async setMode(_uuid: string | undefined, target?: HTMLElement): Promise<void> {
    const mode = target?.dataset.value as TreasureMode | undefined;
    if (!mode || !["encounter", "level", "custom"].includes(mode)) return;
    this.options.mode = mode;
    await this.app.render({ parts: ["treasure"] });
  }

  /* ---------------------------- generation -------------------------- */

  async generate(): Promise<void> {
    await this.#run(this.options.seed || randomHexSeed(), []);
  }

  async reroll(): Promise<void> {
    const locked = this.result?.entries.filter((e) => e.locked) ?? [];
    await this.#run(randomHexSeed(), locked);
  }

  async #run(seed: string, locked: TreasureEntry[]): Promise<void> {
    const budget = this.budget();
    if (!budget || !isGM()) return;
    const { items } = services();
    this.busy = true;
    await this.app.render({ parts: ["treasure"] });
    try {
      await items.ensureLoaded();
      this.result = generateTreasure({
        budget,
        candidates: items.candidates(),
        options: { ...this.options, preferTraits: this.#themeTraits() },
        rng: rngFromSeed(seed),
        seed,
        locked,
      });
      this.lastSeed = seed;
      this.lastOutput = null;
      this.#rolledForOtherDraft = false;
    } catch (error) {
      console.error("sargas-encounter-builder | treasure generation failed", error);
      this.app.reportError(error);
    } finally {
      this.busy = false;
    }
    await this.app.render({ parts: ["header", "treasure"] });
  }

  async lock(uuid?: string): Promise<void> {
    if (!uuid || !this.result) return;
    this.result = toggleTreasureLock(this.result, uuid);
    await this.app.render({ parts: ["treasure"] });
  }

  async replace(uuid?: string): Promise<void> {
    if (!uuid || !this.result) return;
    const { items } = services();
    await items.ensureLoaded();
    const next = replaceTreasureEntry(
      this.result,
      uuid,
      items.candidates(),
      { ...this.options, preferTraits: this.#themeTraits() },
      rngFromSeed(randomHexSeed()),
    );
    if (!next) this.app.pushMessage("warn", t("treasure.noReplacement"));
    else this.result = next;
    await this.app.render({ parts: ["header", "treasure"] });
  }

  async remove(uuid?: string): Promise<void> {
    if (!uuid || !this.result) return;
    this.result = removeTreasureEntry(this.result, uuid);
    await this.app.render({ parts: ["treasure"] });
  }

  async clear(): Promise<void> {
    this.result = null;
    this.lastOutput = null;
    await this.app.render({ parts: ["treasure"] });
  }

  async inspect(uuid?: string): Promise<void> {
    if (!uuid) return;
    const doc = await fromUuid(uuid);
    doc?.sheet?.render(true);
  }

  /* ---------------------------- outputs ----------------------------- */

  #defaultName(): string {
    const theme = this.app.panels.generator.lastResult;
    const themeName = theme && "theme" in theme && theme.theme ? theme.theme.name : null;
    return themeName ? t("treasure.lootNameThemed", { theme: themeName }) : t("treasure.lootName");
  }

  async createLoot(): Promise<void> {
    if (!this.result || !isGM()) return;
    const name = await promptText(
      t("treasure.createLootTitle"),
      t("treasure.lootNameLabel"),
      this.#defaultName(),
    );
    if (name === null) return;
    await this.#output(async () => {
      const actor = await this.service.createLootActor(this.result!, {
        name: name.trim() || this.#defaultName(),
        coinItems: services().items.coinItems(),
      });
      actor.sheet?.render(true);
      return t("treasure.lootCreated", { name: actor.name });
    });
  }

  async addToActor(): Promise<void> {
    if (!this.result || !isGM()) return;
    const controlled: { actor?: ActorDocument | null }[] = canvas?.tokens?.controlled ?? [];
    const fromTokens = controlled.map((tk) => tk.actor).filter((a): a is ActorDocument => !!a);
    const order: Record<string, number> = { loot: 0, character: 1, npc: 2 };
    const fallback = game.actors
      .filter((a) => a.type in order)
      .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name));
    const choices = (fromTokens.length ? fromTokens : fallback).map((a) => ({
      uuid: a.uuid,
      name: `${a.name} (${t(`actorType.${a.type}`)})`,
    }));
    if (choices.length === 0) {
      this.app.pushMessage("warn", t("treasure.noActors"));
      await this.app.render({ parts: ["header"] });
      return;
    }
    const uuid = await promptSelect(t("treasure.addToActorTitle"), t("treasure.addToActorLabel"), choices);
    if (!uuid) return;
    const actor = (await fromUuid(uuid)) as ActorDocument | null;
    if (!actor) return;
    const ok = await confirm(
      t("treasure.addToActorTitle"),
      escapeHtml(t("treasure.addToActorConfirm", { name: actor.name, count: this.result.entries.length })),
      "fa-solid fa-sack-dollar",
    );
    if (!ok) return;
    await this.#output(async () => {
      const count = await this.service.addToActor(this.result!, actor, services().items.coinItems());
      return t("treasure.addedToActor", { count, name: actor.name });
    });
  }

  async postChat(): Promise<void> {
    if (!this.result || !isGM()) return;
    await this.#output(async () => {
      await this.service.postToChat(this.result!, this.#defaultName());
      return t("treasure.posted");
    });
  }

  async #output(fn: () => Promise<string>): Promise<void> {
    this.busy = true;
    await this.app.render({ parts: ["treasure"] });
    try {
      this.lastOutput = await fn();
      this.app.pushMessage("ok", this.lastOutput);
    } catch (error) {
      console.error("sargas-encounter-builder | treasure output failed", error);
      this.app.reportError(error);
    } finally {
      this.busy = false;
    }
    await this.app.render({ parts: ["header", "treasure"] });
  }

  /* ---------------------------- persistence ------------------------- */

  toRecord(): TreasureRecord | null {
    const r = this.result;
    if (!r) return null;
    return {
      seed: r.seed,
      share: r.budget.share,
      level: this.options.levelOverride,
      mode: this.options.mode,
      options: {
        allowUncommon: this.options.allowUncommon,
        allowRare: this.options.allowRare,
        includeConsumables: this.options.includeConsumables,
        valuablesShare: this.options.valuablesShare,
        preferTraits: [],
        excludeCategories: [...this.options.excludeCategories],
      },
      entries: r.entries.map((e) => ({
        uuid: e.uuid,
        name: e.name,
        level: e.level,
        price: e.price,
        kind: e.kind,
        slotLevel: e.slotLevel,
        locked: e.locked,
      })),
      coins: { ...r.coins },
    };
  }

  /** Restore a saved treasure against the current budget; missing items are dropped with a note. */
  async fromRecord(record: TreasureRecord | undefined | null): Promise<void> {
    if (!record) {
      this.result = null;
      return;
    }
    this.result = null;
    this.lastOutput = null;
    const roster = this.app.state.resolved?.roster;
    if (!roster || roster.reference.level === null) return;
    const { items } = services();
    await items.ensureLoaded();
    const levelOverride = typeof record.level === "number" ? record.level : null;
    const budget = treasureBudget({
      level: levelOverride ?? roster.reference.level,
      partySize: roster.partySize,
      share: record.share,
    });
    this.options = {
      ...this.options,
      ...record.options,
      mode: record.mode ?? "custom",
      customPercent: Math.max(1, Math.round(record.share * 100)),
      levelOverride,
    };
    this.#rolledForOtherDraft = false;
    const entries: TreasureEntry[] = [];
    let missing = 0;
    for (const saved of record.entries) {
      const found = items.get(saved.uuid);
      if (!found) {
        missing++;
        continue;
      }
      entries.push({ ...found, slotLevel: saved.slotLevel, locked: saved.locked });
    }
    // Settle the restored rows against the current party's budget: a bigger party sees more coins.
    this.result = settle({
      budget,
      entries,
      itemsValue: 0,
      currencyValue: 0,
      coins: { pp: 0, gp: 0, sp: 0, cp: 0 },
      trace: [t("treasure.restoredTrace")],
      seed: record.seed,
    });
    this.lastSeed = record.seed;
    if (missing) this.app.pushMessage("warn", t("treasure.restoredMissing", { count: missing }));
  }
}

/* -------------------------------------------- */
/*  Context helpers                             */
/* -------------------------------------------- */

function describeBudget(b: TreasureBudget): Record<string, unknown> {
  return {
    level: b.level,
    partySize: b.partySize,
    sharePercent: Math.round(b.share * 1000) / 10,
    totalValue: gp(b.totalValue),
    currency: gp(b.currency),
    perLevelTotal: gp(b.perLevel.total),
    perLevelCurrency: gp(b.perLevel.currency),
    perExtraPC: gp(b.perLevel.perExtraPC),
    permanent: b.permanent.map((s) => ({ level: s.level, expected: s.expected.toFixed(2) })),
    consumables: b.consumables.map((s) => ({ level: s.level, expected: s.expected.toFixed(2) })),
    extraPCs: b.partySize - 4,
    partySizeLabel:
      b.partySize > 4
        ? t("treasure.extraPCs", { count: b.partySize - 4, per: gp(b.perLevel.perExtraPC) })
        : b.partySize < 4
          ? t("treasure.fewerPCs", { count: 4 - b.partySize, per: gp(b.perLevel.perExtraPC) })
          : t("treasure.partyOfFour"),
  };
}

function describeResult(r: TreasureResult): Record<string, unknown> {
  const total = r.budget.totalValue || 1;
  const itemsPct = Math.min(100, (r.itemsValue / total) * 100);
  const valuables = r.entries.filter((e) => e.kind === "valuable").reduce((n, e) => n + e.price, 0);
  const coinsGp = coinsToGp(r.coins);
  return {
    entries: r.entries.map((e) => ({
      ...e,
      price: gp(e.price),
      kindLabel: t(`treasure.kind.${e.kind}`),
      rarityClass: e.rarity && e.rarity !== "common" ? `is-${e.rarity}` : "",
      relaxed: e.kind !== "valuable" && e.level < e.slotLevel,
    })),
    count: r.entries.length,
    itemsValue: gp(r.itemsValue),
    currencyValue: gp(r.currencyValue),
    coins: formatCoins(r.coins),
    coinsGp: gp(coinsGp),
    valuablesValue: gp(valuables),
    totalValue: gp(r.itemsValue + r.currencyValue),
    budgetValue: gp(r.budget.totalValue),
    itemsPct: itemsPct.toFixed(1),
    valuablesPct: Math.min(100 - itemsPct, (valuables / total) * 100).toFixed(1),
    coinsPct: Math.max(0, Math.min(100, (coinsGp / total) * 100)).toFixed(1),
    trace: r.trace,
    seed: r.seed,
  };
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
