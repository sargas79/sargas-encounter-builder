/**
 * CreatureCatalog: compendium discovery, index-only loading with a per-session cache,
 * invalidation on compendium changes, custom tags, and filtering.
 *
 * Browsing never loads full documents. `inspect` and import paths call `getDocument` explicitly.
 */
import { MODULE_ID, SETTINGS } from "../constants.js";
import {
  catalogEntryFromIndex,
  filterCatalog,
  NPC_INDEX_FIELDS,
  type CatalogEntry,
  type CatalogFilter,
  type RawIndexEntry,
} from "../core/catalog.js";

export interface PackInfo {
  id: string;
  label: string;
  packageName: string;
  /** False when the current user cannot see the pack. */
  accessible: boolean;
}

/** Port for compendium access so the catalog can be tested without Foundry. */
export interface PackProvider {
  listActorPacks(): PackInfo[];
  getIndex(packId: string, fields: readonly string[]): Promise<RawIndexEntry[]>;
  /** Full document load — only for inspect/import, never during browsing. */
  getDocument(uuid: string): Promise<FoundryDocument | null>;
}

export interface TagProvider {
  tagsFor(uuid: string): string[];
}

export type PackLoadState =
  | { state: "loaded"; count: number; skipped: number }
  | { state: "inaccessible" }
  | { state: "missing" }
  | { state: "error"; message: string };

export class FoundryPackProvider implements PackProvider {
  listActorPacks(): PackInfo[] {
    return game.packs
      .filter((p) => p.documentName === "Actor" || p.metadata.type === "Actor")
      .map((p) => ({
        id: p.collection,
        label: p.metadata.label,
        packageName: p.metadata.packageName,
        accessible: p.visible !== false,
      }));
  }

  async getIndex(packId: string, fields: readonly string[]): Promise<RawIndexEntry[]> {
    const pack = game.packs.get(packId);
    if (!pack) throw new Error(`Pack ${packId} not found`);
    const index = await pack.getIndex({ fields: [...fields] });
    return index.contents.map((e) => ({
      ...e,
      uuid: e.uuid ?? `Compendium.${packId}.Actor.${e._id}`,
    })) as RawIndexEntry[];
  }

  async getDocument(uuid: string): Promise<FoundryDocument | null> {
    return fromUuid(uuid);
  }
}

export class CreatureCatalog {
  #cache = new Map<string, CatalogEntry[]>();
  #states = new Map<string, PackLoadState>();
  #loading = new Map<string, Promise<void>>();
  #hookIds: number[] = [];
  #listeners = new Set<() => void>();
  #documentLoads = 0;
  #version = 0;

  constructor(
    private readonly provider: PackProvider,
    private readonly tags: TagProvider = { tagsFor: () => [] },
    private readonly selectedPacksStore: SelectedPacksStore = settingsSelectedPacks(),
  ) {}

  /* ---------------------------- packs ------------------------------- */

  availablePacks(): PackInfo[] {
    return this.provider.listActorPacks();
  }

  selectedPackIds(): string[] {
    const available = new Set(this.availablePacks().map((p) => p.id));
    return this.selectedPacksStore.get().filter((id) => available.has(id));
  }

  /** Selected pack IDs that no longer exist (missing-source state). */
  missingSelectedPackIds(): string[] {
    const available = new Set(this.availablePacks().map((p) => p.id));
    return this.selectedPacksStore.get().filter((id) => !available.has(id));
  }

  /**
   * First run: select every accessible Actor pack shipped by the PF2e system (bestiaries), or all
   * accessible Actor packs when none come from the system. Does nothing once a selection exists.
   */
  async ensureDefaultSelection(): Promise<boolean> {
    if (this.selectedPacksStore.get().length > 0 || this.selectedPacksStore.initialized?.()) return false;
    const accessible = this.availablePacks().filter((p) => p.accessible);
    const system = accessible.filter((p) => p.packageName === "pf2e");
    const chosen = (system.length ? system : accessible).map((p) => p.id);
    if (chosen.length === 0) return false;
    await this.selectedPacksStore.set(chosen);
    this.#emit();
    return true;
  }

  async setSelectedPacks(ids: string[]): Promise<void> {
    await this.selectedPacksStore.set([...new Set(ids)]);
    await this.selectedPacksStore.markInitialized?.();
    this.#emit();
  }

  packState(packId: string): PackLoadState | undefined {
    return this.#states.get(packId);
  }

  /* ---------------------------- loading ----------------------------- */

  async ensureLoaded(packIds: string[] = this.selectedPackIds()): Promise<void> {
    await Promise.all(packIds.map((id) => this.#loadPack(id)));
  }

  async #loadPack(packId: string): Promise<void> {
    if (this.#cache.has(packId)) return;
    const inflight = this.#loading.get(packId);
    if (inflight) return inflight;
    const promise = (async () => {
      const info = this.availablePacks().find((p) => p.id === packId);
      if (!info) {
        this.#states.set(packId, { state: "missing" });
        return;
      }
      if (!info.accessible) {
        this.#states.set(packId, { state: "inaccessible" });
        return;
      }
      try {
        const raw = await this.provider.getIndex(packId, NPC_INDEX_FIELDS);
        const entries: CatalogEntry[] = [];
        let skipped = 0;
        for (const r of raw) {
          if (r.type !== "npc") continue;
          const entry = catalogEntryFromIndex(
            r,
            { id: info.id, label: info.label },
            this.tags.tagsFor(r.uuid ?? ""),
          );
          if (entry) entries.push(entry);
          else skipped++;
        }
        this.#cache.set(packId, entries);
        this.#states.set(packId, { state: "loaded", count: entries.length, skipped });
      } catch (error) {
        this.#states.set(packId, {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.#version++;
    })();
    this.#loading.set(packId, promise);
    try {
      await promise;
    } finally {
      this.#loading.delete(packId);
    }
  }

  /** Drop cached indexes (one pack or all) so the next browse reloads them. */
  invalidate(packId?: string): void {
    if (packId) {
      this.#cache.delete(packId);
      this.#states.delete(packId);
    } else {
      this.#cache.clear();
      this.#states.clear();
    }
    this.#emit();
  }

  async refresh(): Promise<void> {
    this.invalidate();
    await this.ensureLoaded();
  }

  /** Re-apply tags without reloading indexes (tags are stored separately). */
  retag(): void {
    for (const [packId, entries] of this.#cache) {
      this.#cache.set(
        packId,
        entries.map((e) => ({ ...e, tags: this.tags.tagsFor(e.uuid) })),
      );
    }
    this.#emit();
  }

  /* ---------------------------- queries ----------------------------- */

  entries(packIds: string[] = this.selectedPackIds()): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const id of packIds) {
      const entries = this.#cache.get(id);
      if (entries) out.push(...entries);
    }
    return out;
  }

  async search(filter: CatalogFilter, packIds: string[] = this.selectedPackIds()): Promise<CatalogEntry[]> {
    await this.ensureLoaded(packIds);
    return filterCatalog(this.entries(packIds), {
      ...filter,
      packIds: filter.packIds?.length ? filter.packIds : undefined,
    });
  }

  get(uuid: string): CatalogEntry | null {
    for (const entries of this.#cache.values()) {
      const found = entries.find((e) => e.uuid === uuid);
      if (found) return found;
    }
    return null;
  }

  /** Locate an entry even when its pack is not selected (loads that pack's index). */
  async locate(uuid: string): Promise<CatalogEntry | null> {
    const cached = this.get(uuid);
    if (cached) return cached;
    const match = /^Compendium\.(.+)\.Actor\.[^.]+$/.exec(uuid);
    if (!match) return null;
    await this.ensureLoaded([match[1]!]);
    return this.get(uuid);
  }

  /** Explicit full-document load (inspect / import). Counted so tests can prove browsing never calls it. */
  async loadDocument(uuid: string): Promise<FoundryDocument | null> {
    this.#documentLoads++;
    return this.provider.getDocument(uuid);
  }

  get documentLoadCount(): number {
    return this.#documentLoads;
  }

  /**
   * Monotonic stamp bumped whenever the loaded entries, their tags or the pack selection change
   * through this catalog. Lets callers key derived caches without re-running a search.
   */
  get version(): number {
    return this.#version;
  }

  /* ---------------------------- events ------------------------------ */

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    this.#version++;
    for (const l of this.#listeners) l();
  }

  /** Invalidate the owning pack's cache when a compendium Actor changes. Registered once. */
  registerHooks(): () => void {
    if (this.#hookIds.length) return () => this.unregisterHooks();
    const handler = (doc: FoundryDocument) => {
      if (doc.pack) this.invalidate(doc.pack);
    };
    for (const hook of ["createActor", "updateActor", "deleteActor"])
      this.#hookIds.push(Hooks.on(hook, handler));
    return () => this.unregisterHooks();
  }

  unregisterHooks(): void {
    const names = ["createActor", "updateActor", "deleteActor"];
    this.#hookIds.forEach((id, i) => Hooks.off(names[i] ?? "updateActor", id));
    this.#hookIds = [];
  }
}

export interface SelectedPacksStore {
  get(): string[];
  set(ids: string[]): Promise<void>;
  /** True once the GM has changed the selection by hand (an emptied list is then respected). */
  initialized?(): boolean;
  markInitialized?(): Promise<void>;
}

function settingsSelectedPacks(): SelectedPacksStore {
  return {
    initialized: () => {
      try {
        return !!game.settings.get(MODULE_ID, SETTINGS.packsInitialized);
      } catch {
        return false;
      }
    },
    markInitialized: async () => {
      await game.settings.set(MODULE_ID, SETTINGS.packsInitialized, true);
    },
    get: () => {
      try {
        return (game.settings.get(MODULE_ID, SETTINGS.selectedPacks) as string[]) ?? [];
      } catch {
        return [];
      }
    },
    set: async (ids) => {
      await game.settings.set(MODULE_ID, SETTINGS.selectedPacks, ids);
    },
  };
}
