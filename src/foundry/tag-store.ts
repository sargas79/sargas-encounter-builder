/**
 * Custom creature tags, stored as a versioned flag on the single module data JournalEntry.
 * GM-only ownership; players never see it.
 */
import { FLAGS, MODULE_ID } from "../constants.js";
import { emptyTagStore, validateTagStore, type TagStore } from "../core/schemas.js";
import { ensureDataJournal, findDataJournal } from "./data-journal.js";

export class TagStoreService {
  #cache: TagStore | null = null;
  #byUuid = new Map<string, string[]>();

  tagsFor(uuid: string): string[] {
    this.load();
    return this.#byUuid.get(uuid) ?? [];
  }

  allTags(): string[] {
    const set = new Set<string>();
    for (const entry of this.load().entries) for (const t of entry.tags) set.add(t);
    return [...set].sort();
  }

  load(): TagStore {
    if (this.#cache) return this.#cache;
    const store = parseTagStore(findDataJournal()?.getFlag(MODULE_ID, FLAGS.tags));
    this.#setCache(store);
    return store;
  }

  async setTags(uuid: string, tags: string[]): Promise<void> {
    if (!game.user.isGM) throw new Error("GM only");
    const journal = await ensureDataJournal();
    // Start from the document, not the cache: another GM or tab may have written since we loaded.
    const store = structuredClone(parseTagStore(journal.getFlag(MODULE_ID, FLAGS.tags)));
    // Arrays are replaced wholesale by setFlag, so removals persist (object keys would be merged).
    store.entries = store.entries.filter((e) => e.uuid !== uuid);
    if (tags.length) store.entries.push({ uuid, tags: [...new Set(tags)].sort() });
    // Atomic wholesale replacement (also drops any legacy keys left in the flag).
    await journal.update({
      [`flags.${MODULE_ID}.-=${FLAGS.tags}`]: null,
      [`flags.${MODULE_ID}.${FLAGS.tags}`]: store,
    });
    this.#setCache(store);
  }

  invalidate(): void {
    this.#cache = null;
    this.#byUuid.clear();
  }

  #setCache(store: TagStore): void {
    this.#cache = store;
    this.#byUuid = new Map(store.entries.map((e) => [e.uuid, e.tags]));
  }
}

function parseTagStore(raw: unknown): TagStore {
  if (raw) {
    const v = validateTagStore(raw);
    if (v.ok) return v.value;
    console.warn(`${MODULE_ID} | Tag store invalid, starting empty`, v.errors);
  }
  return emptyTagStore();
}
