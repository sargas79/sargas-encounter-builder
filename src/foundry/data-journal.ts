/**
 * The single GM-only module data JournalEntry that holds the tag store and the theme store.
 * One creation path for both stores, and change hooks that tell them when their flag changed
 * (another GM, another tab, or a migration wrote it).
 */
import { DOCUMENT_NAMES, FLAGS, MODULE_ID } from "../constants.js";
import { emptyTagStore, emptyThemeStore } from "../core/schemas.js";
import { documentClass, ownershipLevels } from "./compat.js";
import { localizedDocumentName } from "./module-folders.js";

export function isDataJournal(doc: Pick<FoundryDocument, "getFlag"> | null | undefined): boolean {
  try {
    return doc?.getFlag(MODULE_ID, FLAGS.dataJournal) === true;
  } catch {
    return false;
  }
}

export function findDataJournal(): JournalEntryDocument | null {
  return game.journal.find((j) => isDataJournal(j)) ?? null;
}

let creating: Promise<JournalEntryDocument> | null = null;

/**
 * Return the data journal, creating it once. Concurrent first writes (a tag edit and a theme save,
 * say) share one creation instead of each making its own journal.
 */
export async function ensureDataJournal(): Promise<JournalEntryDocument> {
  const existing = findDataJournal();
  if (existing) return existing;
  if (!creating) {
    const levels = ownershipLevels();
    const pending = documentClass("JournalEntry").create({
      name: localizedDocumentName("documents.dataJournal", DOCUMENT_NAMES.dataJournal),
      ownership: { default: levels.NONE },
      flags: {
        [MODULE_ID]: {
          [FLAGS.dataJournal]: true,
          [FLAGS.tags]: emptyTagStore(),
          [FLAGS.themes]: emptyThemeStore(),
        },
      },
    }) as Promise<JournalEntryDocument>;
    creating = pending;
    const clear = () => {
      if (creating === pending) creating = null;
    };
    pending.then(clear, clear);
  }
  return creating;
}

export interface DataJournalChange {
  tags: boolean;
  themes: boolean;
}

/**
 * Which stores a JournalEntry event touches. `changed` is the update diff (absent for create and
 * delete, which affect both stores when the document is the data journal).
 */
export function dataJournalChange(
  doc: Pick<FoundryDocument, "getFlag"> | null | undefined,
  changed?: Record<string, unknown>,
): DataJournalChange {
  const none = { tags: false, themes: false };
  const flags = (changed?.flags as Record<string, unknown> | undefined)?.[MODULE_ID] as
    Record<string, unknown> | undefined;
  if (!changed) return isDataJournal(doc) ? { tags: true, themes: true } : none;
  const keys = flags && typeof flags === "object" ? Object.keys(flags).map((k) => k.replace(/^-=/, "")) : [];
  if (!keys.length) return none;
  // The marker itself was set or removed: the journal became (or stopped being) the data journal.
  if (keys.includes(FLAGS.dataJournal)) return { tags: true, themes: true };
  if (!isDataJournal(doc)) return none;
  return { tags: keys.includes(FLAGS.tags), themes: keys.includes(FLAGS.themes) };
}

let hookIds: number[] = [];
const HOOKS = ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry"] as const;

/** Register the JournalEntry hooks once; `onChange` runs when a store's flag may have changed. */
export function registerDataJournalHooks(onChange: (change: DataJournalChange) => void): () => void {
  if (hookIds.length) return unregisterDataJournalHooks;
  const handler =
    (withDiff: boolean) =>
    (doc: FoundryDocument, changed?: Record<string, unknown>): void => {
      const change = dataJournalChange(doc, withDiff ? changed : undefined);
      if (change.tags || change.themes) onChange(change);
    };
  hookIds = [
    Hooks.on("createJournalEntry", handler(false)),
    Hooks.on("updateJournalEntry", handler(true)),
    Hooks.on("deleteJournalEntry", handler(false)),
  ];
  return unregisterDataJournalHooks;
}

export function unregisterDataJournalHooks(): void {
  hookIds.forEach((id, i) => Hooks.off(HOOKS[i] ?? "updateJournalEntry", id));
  hookIds = [];
}
