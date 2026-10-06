/**
 * GM-authored themes, stored as a versioned flag on the module data JournalEntry (GM-only).
 */
import { FLAGS, MODULE_ID } from "../constants.js";
import {
  emptyThemeStore,
  validateThemeStore,
  type CustomThemeRecord,
  type ThemeStoreV1,
} from "../core/schemas.js";
import { randomID } from "./compat.js";
import { ensureDataJournal, findDataJournal } from "./data-journal.js";

export class ThemeStoreService {
  #cache: ThemeStoreV1 | null = null;

  list(): CustomThemeRecord[] {
    return this.load().themes;
  }

  get(id: string): CustomThemeRecord | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  load(): ThemeStoreV1 {
    if (this.#cache) return this.#cache;
    this.#cache = parseThemeStore(findDataJournal()?.getFlag(MODULE_ID, FLAGS.themes));
    return this.#cache;
  }

  async save(theme: Omit<CustomThemeRecord, "id"> & { id?: string }): Promise<CustomThemeRecord> {
    if (!game.user.isGM) throw new Error("GM only");
    const record: CustomThemeRecord = { ...theme, id: theme.id ?? randomID() };
    await this.#modify((store) => {
      store.themes = [...store.themes.filter((t) => t.id !== record.id), record];
    });
    return record;
  }

  async delete(id: string): Promise<void> {
    if (!game.user.isGM) throw new Error("GM only");
    await this.#modify((store) => {
      store.themes = store.themes.filter((t) => t.id !== id);
    });
  }

  invalidate(): void {
    this.#cache = null;
  }

  /** Read the flag from the document right before writing, so another GM's edits are kept. */
  async #modify(change: (store: ThemeStoreV1) => void): Promise<void> {
    const journal = await ensureDataJournal();
    const store = structuredClone(parseThemeStore(journal.getFlag(MODULE_ID, FLAGS.themes)));
    change(store);
    await journal.update({
      [`flags.${MODULE_ID}.-=${FLAGS.themes}`]: null,
      [`flags.${MODULE_ID}.${FLAGS.themes}`]: store,
    });
    this.#cache = store;
  }
}

function parseThemeStore(raw: unknown): ThemeStoreV1 {
  if (raw) {
    const v = validateThemeStore(raw);
    if (v.ok) return v.value;
    console.warn(`${MODULE_ID} | Theme store invalid, starting empty`, v.errors);
  }
  return emptyThemeStore();
}
