/**
 * Folders the module creates for its own documents (saved encounters, treasure loot actors).
 * New folders carry a role flag and a localized name; lookup prefers the flag and falls back to the
 * localized or the legacy English name, so worlds created by earlier versions (or in another
 * language) reuse their folder instead of getting a duplicate.
 */
import { DOCUMENT_NAMES, FLAGS, MODULE_ID } from "../constants.js";
import { documentClass } from "./compat.js";
import { t } from "./i18n.js";

export type ModuleFolderRole = "recipes" | "loot";

const ROLES: Record<ModuleFolderRole, { type: string; key: string; legacyName: string }> = {
  recipes: { type: "JournalEntry", key: "documents.recipeFolder", legacyName: DOCUMENT_NAMES.recipeFolder },
  loot: { type: "Actor", key: "documents.lootFolder", legacyName: DOCUMENT_NAMES.lootFolder },
};

/** Localized document name, or `fallback` when the key is missing (e.g. outside Foundry). */
export function localizedDocumentName(key: string, fallback: string): string {
  const name = t(key);
  return name && name !== `${MODULE_ID}.${key}` ? name : fallback;
}

type FolderLike = Pick<FolderDocument, "type" | "name"> & { flags?: FolderDocument["flags"] };

/** The module folder for `role` among `folders`: the flagged one first, else one with a known name. */
export function findModuleFolder<F extends FolderLike>(
  folders: Iterable<F>,
  role: ModuleFolderRole,
): F | null {
  const { type, key, legacyName } = ROLES[role];
  const candidates = [...folders].filter((f) => f.type === type);
  const flagged = candidates.find((f) => f.flags?.[MODULE_ID]?.[FLAGS.folder] === role);
  if (flagged) return flagged;
  const names = new Set([legacyName, localizedDocumentName(key, legacyName)]);
  return candidates.find((f) => names.has(f.name)) ?? null;
}

/** The module folder for `role`, created (flagged, localized name) when missing. Null if creation fails. */
export async function ensureModuleFolder(role: ModuleFolderRole): Promise<FolderDocument | null> {
  const existing = findModuleFolder(game.folders.contents, role);
  if (existing) return existing;
  const { type, key, legacyName } = ROLES[role];
  try {
    return await documentClass("Folder").create({
      name: localizedDocumentName(key, legacyName),
      type,
      flags: { [MODULE_ID]: { [FLAGS.folder]: role } },
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | could not create the ${role} folder`, error);
    return null;
  }
}
