/**
 * Build tab, browse side: pack selection, catalog search and filters, tags, and the draft list
 * (add, quantity, lock, remove, clear, drop an actor). Search results live in `app.state.results`.
 */
import { MODULE_ID } from "../constants.js";
import { parseTagText } from "../core/catalog.js";
import {
  addEntry,
  emptyDraft,
  entryFromCatalog,
  removeEntry,
  setQuantity,
  toggleLock,
} from "../core/draft.js";
import { splitList } from "../core/util.js";
import { debounce, isGM, renderTemplate } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { promptText } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import type { Panel } from "./panel.js";
import { describePackState, draftSummary, meterContext, signed } from "./view-models.js";

const CATALOG_LIST = `modules/${MODULE_ID}/templates/builder/catalog-list.hbs`;
/** Rows rendered per page of catalog results; "Show more" adds another page. */
const RESULT_PAGE = 200;

export class CatalogPanel implements Panel {
  #muted = 0;
  /** How many results to keep; reset to one page whenever the query changes. */
  #limit = RESULT_PAGE;
  #lastQuery = "";
  #loadingMore = false;
  /** Debounced search-and-render, for typing and catalog change events. */
  readonly search = debounce(() => void this.runSearch(), 250);

  constructor(private readonly app: EncounterBuilderApp) {}

  /* ---------------------------- search ------------------------------ */

  /** Query the catalog into `state.results`. Never renders. */
  async searchResults(): Promise<void> {
    const { catalog } = services();
    const state = this.app.state;
    const ref = state.resolved?.roster.reference.level ?? null;
    const filter = { ...state.filter, referenceLevel: ref };
    const query = JSON.stringify([filter, catalog.selectedPackIds()]);
    if (query !== this.#lastQuery) {
      this.#lastQuery = query;
      this.#limit = RESULT_PAGE;
    }
    try {
      const all = await catalog.search(filter);
      state.resultTotal = all.length;
      state.results = all.slice(0, this.#limit);
    } catch (error) {
      console.error(`${MODULE_ID} | search failed`, error);
      state.results = [];
      state.resultTotal = 0;
    }
  }

  async runSearch(): Promise<void> {
    await this.searchResults();
    if (!this.app.rendered) return;
    // Re-rendering the part while the GM is typing replaces the search box under the caret, which
    // drops keystrokes and breaks dead-key/IME input. Patch the list in place instead.
    if (this.#searchHasFocus()) {
      await this.#patchList();
      await this.app.render({ parts: ["footer"] });
    } else await this.app.render({ parts: ["build", "footer"] });
  }

  /**
   * Catalog changes (pack selection, index reloads, tags) re-run the debounced search, which renders
   * Build once. Actions that search right after changing the catalog mute this.
   */
  onCatalogChanged(): void {
    if (this.#muted === 0) this.search();
  }

  /** Run a catalog mutation without the change event's own search; the caller searches after. */
  async #mute<T>(fn: () => Promise<T> | T): Promise<T> {
    this.#muted++;
    try {
      return await fn();
    } finally {
      this.#muted--;
    }
  }

  #searchHasFocus(): boolean {
    const active = document.activeElement as HTMLInputElement | null;
    return !!active && active.name === "filter.search" && this.app.element.contains(active);
  }

  /** Swap only the catalog rows and count, leaving the filter inputs (and their focus) untouched. */
  async #patchList(): Promise<void> {
    const root: HTMLElement = this.app.element;
    const list = root.querySelector<HTMLElement>(".seb-catalog-list");
    if (!list) return;
    const { catalog } = services();
    const build = {
      noPacks: catalog.selectedPackIds().length === 0,
      results: this.#resultsContext(),
      ...this.#countContext(),
    };
    list.innerHTML = await renderTemplate(CATALOG_LIST, { busy: this.app.state.busy, build });
    const count = root.querySelector<HTMLElement>(".seb-catalog-count");
    if (count) count.textContent = build.resultCount;
  }

  /** Header count ("200 / 1234" when truncated) and the "Show more" footer for the result list. */
  #countContext(): { resultCount: string; hiddenCount: number; moreHint: string } {
    const { results, resultTotal } = this.app.state;
    const hiddenCount = Math.max(0, resultTotal - results.length);
    return {
      resultCount: hiddenCount > 0 ? `${results.length} / ${resultTotal}` : String(results.length),
      hiddenCount,
      moreHint: hiddenCount > 0 ? t("build.moreResults", { shown: results.length, total: resultTotal }) : "",
    };
  }

  /* ---------------------------- context ----------------------------- */

  #resultsContext(): Record<string, unknown>[] {
    const ref = this.app.state.resolved?.roster.reference.level ?? null;
    return this.app.state.results.map((entry) => ({
      ...entry,
      relative: ref != null ? signed(entry.level - ref) : "",
      traitsShort: entry.traits.slice(0, 4),
      moreTraits: Math.max(0, entry.traits.length - 4),
      rarityClass: entry.rarity !== "common" ? `is-${entry.rarity}` : "",
    }));
  }

  async prepareContext(): Promise<Record<string, unknown>> {
    const { catalog, tags } = services();
    const state = this.app.state;
    const evaluation = state.evaluation;
    const selectedPacks = new Set(catalog.selectedPackIds());
    const packs = catalog.availablePacks().map((p) => ({
      ...p,
      selected: selectedPacks.has(p.id),
      stateLabel: describePackState(catalog.packState(p.id)),
    }));
    return {
      mode: state.buildMode,
      isBrowse: state.buildMode === "browse",
      isGenerate: state.buildMode === "generate",
      filter: state.filter,
      results: this.#resultsContext(),
      ...this.#countContext(),
      draft: state.draft.entries.map((entry) => {
        const ev = evaluation?.entries.find((e) => e.id === entry.uuid);
        return {
          ...entry,
          xpEach: ev?.xpEach ?? null,
          subtotal: ev?.subtotal ?? null,
          status: ev?.status ?? "supported",
          relative: ev ? signed(ev.relativeLevel) : "",
          statusLabel: ev && ev.status !== "supported" ? t(`evaluation.status.${ev.status}`) : "",
        };
      }),
      ...draftSummary(state.draft),
      meter: evaluation ? meterContext(evaluation) : null,
      packs,
      packCount: selectedPacks.size,
      missingPacks: catalog.missingSelectedPackIds(),
      noPacks: selectedPacks.size === 0,
      traits: state.filter.traits?.join(", ") ?? "",
      tags: state.filter.tags?.join(", ") ?? "",
      rarity: state.filter.rarities?.[0] ?? "",
      rarities: ["", "common", "uncommon", "rare", "unique"].map((value) => ({
        value,
        label: value ? t(`rarity.${value}`) : t("build.anyRarity"),
        active: (state.filter.rarities?.[0] ?? "") === value,
      })),
      allTags: tags.allTags(),
    };
  }

  /* ---------------------------- inputs ------------------------------ */

  onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target?.name === "filter.search") {
      this.app.state.filter.search = target.value;
      this.search();
    }
  }

  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLInputElement;
    if (event.key === "Enter" && target?.name === "filter.search") {
      event.preventDefault();
      // The debounced search may not have run yet: query now and add the first fresh match.
      this.app.state.filter.search = target.value;
      void this.runSearch().then(() => {
        const first = this.app.state.results[0];
        if (!first) return;
        this.app.setDraft(addEntry(this.app.state.draft, entryFromCatalog(first)));
        return this.app.render({ parts: ["build", "deploy", "footer"] });
      });
    }
  }

  async onChange(name: string, value: string, target: HTMLElement): Promise<boolean> {
    const filter = this.app.state.filter;
    switch (name) {
      case "quantity": {
        const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
        if (uuid) {
          this.app.setDraft(setQuantity(this.app.state.draft, uuid, Number.parseInt(value, 10)));
          await this.app.render({ parts: ["build", "deploy", "footer"] });
        }
        return true;
      }
      case "filter.relativeMin":
      case "filter.relativeMax": {
        const key = name.slice("filter.".length) as "relativeMin" | "relativeMax";
        filter[key] = value === "" ? null : Number.parseInt(value, 10);
        this.search();
        return true;
      }
      case "filter.traits":
        filter.traits = splitList(value);
        this.search();
        return true;
      case "filter.tags":
        filter.tags = splitList(value);
        this.search();
        return true;
      case "pack": {
        const id = target.dataset.packId;
        if (!id) return true;
        const { catalog } = services();
        const selected = new Set(catalog.selectedPackIds());
        if ((target as HTMLInputElement).checked) selected.add(id);
        else selected.delete(id);
        // The catalog change event runs the (debounced) search and renders Build once.
        await catalog.setSelectedPacks([...selected]);
        return true;
      }
      default:
        return false;
    }
  }

  async onDrop(purpose: string | undefined, data: Record<string, unknown>): Promise<boolean> {
    if (purpose !== "draft") return false;
    if (data?.type !== "Actor" || typeof data.uuid !== "string") {
      this.app.pushMessage("warn", t("messages.dropNotActor"));
      await this.app.render({ parts: ["header"] });
      return true;
    }
    await this.#addFromUuid(data.uuid);
    return true;
  }

  /** A dropped actor: a catalog entry when its pack is known, else a world NPC read directly. */
  async #addFromUuid(uuid: string): Promise<void> {
    const entry = await services().catalog.locate(uuid);
    if (entry) this.app.setDraft(addEntry(this.app.state.draft, entryFromCatalog(entry)));
    else {
      const doc = (await fromUuid(uuid)) as ActorDocument | null;
      if (!doc || doc.type !== "npc" || typeof doc.level !== "number") {
        this.app.pushMessage("warn", t("messages.dropNotNpc"));
        await this.app.render({ parts: ["header"] });
        return;
      }
      const traits = doc.system?.traits?.value;
      this.app.setDraft(
        addEntry(
          this.app.state.draft,
          entryFromCatalog({
            uuid,
            name: doc.name,
            level: doc.level,
            img: doc.img ?? null,
            packLabel: doc.pack ?? t("build.worldActor"),
            traits: Array.isArray(traits) ? traits : [],
          }),
        ),
      );
    }
    await this.app.render({ parts: ["build", "deploy", "footer"] });
  }

  /* ---------------------------- actions ----------------------------- */

  async addCreature(target: HTMLElement): Promise<void> {
    const uuid = uuidOf(target);
    if (!uuid) return;
    const entry = this.app.state.results.find((e) => e.uuid === uuid) ?? services().catalog.get(uuid);
    if (!entry) return;
    this.app.setDraft(addEntry(this.app.state.draft, entryFromCatalog(entry)));
    await this.app.render({ parts: ["build", "deploy", "footer"] });
  }

  async inspectCreature(target: HTMLElement): Promise<void> {
    const uuid = uuidOf(target);
    if (!uuid) return;
    const doc = await services().catalog.loadDocument(uuid);
    if (!doc) {
      this.app.pushMessage("warn", t("messages.sourceMissing", { uuid }));
      await this.app.render({ parts: ["header"] });
      return;
    }
    doc.sheet?.render(true);
  }

  async removeCreature(target: HTMLElement): Promise<void> {
    const uuid = uuidOf(target);
    if (!uuid) return;
    this.app.setDraft(removeEntry(this.app.state.draft, uuid));
    await this.app.render({ parts: ["build", "deploy", "footer"] });
  }

  async lockCreature(target: HTMLElement): Promise<void> {
    const uuid = uuidOf(target);
    if (!uuid) return;
    this.app.setDraft(toggleLock(this.app.state.draft, uuid));
    await this.app.render({ parts: ["build"] });
  }

  async clearDraft(): Promise<void> {
    this.app.setDraft(emptyDraft());
    await this.app.render({ parts: ["build", "deploy", "footer"] });
  }

  async refreshCatalog(): Promise<void> {
    const state = this.app.state;
    state.busy = true;
    await this.app.render({ parts: ["build"] });
    try {
      services().tags.invalidate();
      services().themes.invalidate();
      await this.#mute(async () => {
        await services().catalog.refresh();
        services().catalog.retag();
      });
    } finally {
      state.busy = false;
    }
    await this.runSearch();
  }

  /** Keep another page of results for the same query. */
  async showMoreResults(): Promise<void> {
    if (this.#loadingMore) return;
    this.#loadingMore = true;
    const shown = this.app.state.results.length;
    try {
      this.#limit += RESULT_PAGE;
      await this.runSearch();
    } finally {
      this.#loadingMore = false;
    }
    // The render replaced the button; keep keyboard focus at the first newly shown row.
    const root: HTMLElement | null = this.app.element ?? null;
    const row = root?.querySelectorAll<HTMLElement>(".seb-catalog-list [data-uuid]")[shown];
    row?.querySelector<HTMLElement>('[data-action="addCreature"]')?.focus();
  }

  async setRarity(target: HTMLElement): Promise<void> {
    const value = target.dataset.value ?? "";
    this.app.state.filter.rarities = value ? [value] : [];
    this.search();
  }

  async editTags(target: HTMLElement): Promise<void> {
    const uuid = uuidOf(target);
    if (!uuid || !isGM()) return;
    const { tags, catalog } = services();
    const current = tags.tagsFor(uuid).join(", ");
    const text = await promptText(t("build.tagsTitle"), t("build.tagsLabel"), current);
    if (text === null) return;
    // Writing the tag store also fires the data-journal hook, which retags and emits.
    await this.#mute(async () => {
      await tags.setTags(uuid, parseTagText(text));
      catalog.retag();
    });
    await this.runSearch();
  }
}

function uuidOf(target: HTMLElement): string | undefined {
  return target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
}
