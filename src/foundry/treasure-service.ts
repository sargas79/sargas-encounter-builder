/**
 * Treasure outputs: a Loot actor in the module folder, items added to an existing actor, or a
 * GM-only chat card. Every path re-checks `game.user.isGM` and never touches player-owned documents
 * except the actor the GM explicitly targets.
 */
import { DOCUMENT_NAMES, FLAGS, MODULE_ID } from "../constants.js";
import { escapeHtml } from "../core/util.js";
import { formatCoins, formatGp as gp, type Coins, type TreasureResult } from "../core/treasure.js";
import { documentClass, ownershipLevels } from "./compat.js";
import { t } from "./i18n.js";
import type { CoinItems } from "./item-catalog.js";

export interface TreasureOutputOptions {
  name: string;
  coinItems: CoinItems;
}

export class TreasureService {
  /** Create a Loot actor holding every item and the coins. Returns the actor. */
  async createLootActor(result: TreasureResult, options: TreasureOutputOptions): Promise<ActorDocument> {
    this.#assertGM();
    const items = await this.#itemData(result, options.coinItems);
    const folder = await this.#ensureFolder();
    const levels = ownershipLevels();
    const ActorClass = documentClass("Actor");
    const actor: ActorDocument = await ActorClass.create({
      name: options.name,
      type: "loot",
      img: "icons/containers/chest/chest-reinforced-steel-brown.webp",
      folder: folder?.id ?? null,
      ownership: { default: levels.NONE },
      system: { lootSheetType: "Loot" },
      items,
      flags: {
        [MODULE_ID]: {
          [FLAGS.treasure]: { seed: result.seed, totalValue: result.budget.totalValue, at: Date.now() },
        },
      },
    });
    if (!actor) throw new Error("Loot actor creation failed");
    return actor;
  }

  /**
   * Add every item and the coins to an existing actor the GM points at. Coins go through PF2e's
   * `actor.inventory.addCoins` when available, so they merge into the actor's existing coin stacks;
   * otherwise coin items are created like any other item. Returns the number of item stacks added
   * (each coin denomination counts as one).
   */
  async addToActor(result: TreasureResult, actor: ActorDocument, coinItems: CoinItems): Promise<number> {
    this.#assertGM();
    const addCoins = actor.inventory?.addCoins;
    const coins = positiveCoins(result.coins);
    const useAddCoins = typeof addCoins === "function" && Object.keys(coins).length > 0;
    const items = await this.#itemData(result, coinItems, { coins: !useAddCoins });
    let count = 0;
    if (items.length > 0) count += (await actor.createEmbeddedDocuments("Item", items)).length;
    if (useAddCoins) {
      await addCoins.call(actor.inventory, coins);
      count += Object.keys(coins).length;
    }
    return count;
  }

  /** Whisper a summary card to every GM. */
  async postToChat(result: TreasureResult, title: string): Promise<void> {
    this.#assertGM();
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);
    const ChatMessageClass = documentClass("ChatMessage");
    await ChatMessageClass.create({
      content: treasureCardHtml(result, title),
      whisper: gmIds,
      speaker: ChatMessageClass.getSpeaker?.({ alias: t("treasure.card.speaker") }) ?? {
        alias: t("treasure.card.speaker"),
      },
      flags: { [MODULE_ID]: { [FLAGS.treasure]: { seed: result.seed } } },
    });
  }

  async #itemData(
    result: TreasureResult,
    coinItems: CoinItems,
    options: { coins: boolean } = { coins: true },
  ): Promise<Record<string, unknown>[]> {
    const wanted: { uuid: string; quantity: number | null }[] = result.entries.map((e) => ({
      uuid: e.uuid,
      quantity: null,
    }));
    const coinEntries = options.coins ? (Object.entries(result.coins) as [keyof Coins, number][]) : [];
    for (const [key, quantity] of coinEntries) {
      if (quantity <= 0) continue;
      const uuid = coinItems[key];
      if (!uuid) {
        console.warn(
          `${MODULE_ID} | no ${key} coin item in the equipment compendium; ${quantity} ${key} skipped`,
        );
        continue;
      }
      wanted.push({ uuid, quantity });
    }
    const sources = await Promise.all(wanted.map((w) => fromUuid(w.uuid)));
    const out: Record<string, unknown>[] = [];
    sources.forEach((source, i) => {
      const { uuid, quantity } = wanted[i]!;
      if (!source) {
        console.warn(`${MODULE_ID} | treasure item ${uuid} not found; skipped`);
        return;
      }
      const data = source.toObject();
      delete data._id;
      delete data.folder;
      data._stats = { ...(data._stats ?? {}), compendiumSource: uuid };
      if (quantity !== null) data.system = { ...(data.system ?? {}), quantity };
      out.push(data);
    });
    return out;
  }

  async #ensureFolder(): Promise<FolderDocument | null> {
    const existing = game.folders.find((f) => f.type === "Actor" && f.name === DOCUMENT_NAMES.lootFolder);
    if (existing) return existing;
    try {
      return await documentClass("Folder").create({ name: DOCUMENT_NAMES.lootFolder, type: "Actor" });
    } catch (error) {
      console.warn(`${MODULE_ID} | could not create the treasure folder`, error);
      return null;
    }
  }

  #assertGM(): void {
    if (!game.user.isGM) throw new Error("GM only");
  }
}

/** Only the denominations with a positive amount, for `inventory.addCoins`. */
function positiveCoins(coins: Coins): Partial<Coins> {
  const out: Partial<Coins> = {};
  for (const [key, quantity] of Object.entries(coins) as [keyof Coins, number][])
    if (quantity > 0) out[key] = quantity;
  return out;
}

export function treasureCardHtml(result: TreasureResult, title: string): string {
  const rows = result.entries
    .map(
      (e) =>
        `<li>@UUID[${e.uuid}]{${escapeHtml(e.name)}} <span style="opacity:.7">(${escapeHtml(
          t("treasure.card.itemDetail", { level: e.level, price: formatGp(e.price) }),
        )})</span></li>`,
    )
    .join("");
  const b = result.budget;
  const budgetLine = t("treasure.card.budget", {
    level: b.level,
    partySize: b.partySize,
    percent: Math.round(b.share * 100),
    total: formatGp(b.totalValue),
  });
  const totals = t("treasure.card.totals", {
    items: formatGp(result.itemsValue),
    currency: formatGp(result.currencyValue),
  });
  return [
    `<div class="seb-chat-card"><h3>${escapeHtml(title)}</h3>`,
    `<p style="opacity:.8">${escapeHtml(budgetLine)}</p>`,
    rows ? `<ul>${rows}</ul>` : `<p><em>${escapeHtml(t("treasure.card.noItems"))}</em></p>`,
    `<p><strong>${escapeHtml(t("treasure.card.coins"))}</strong> ${escapeHtml(formatCoins(result.coins))}</p>`,
    `<p style="opacity:.7">${escapeHtml(totals)}</p></div>`,
  ].join("");
}

function formatGp(value: number): string {
  return `${gp(value)} gp`;
}
