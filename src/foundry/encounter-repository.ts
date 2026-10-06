/**
 * EncounterRepository: saved encounter recipes as JournalEntry documents in a module folder,
 * GM-private by default, with data in a versioned flag.
 */
import { DOCUMENT_NAMES, FLAGS, MODULE_ID } from "../constants.js";
import { validateRecipe, type Recipe } from "../core/schemas.js";
import { documentClass, ownershipLevels } from "./compat.js";
import { escapeHtml as escape } from "../core/util.js";

export interface RecipeRecord {
  id: string;
  uuid: string;
  recipe: Recipe;
}

/** Port so the repository logic can be exercised without Foundry. */
export interface RecipeStore {
  list(): { id: string; uuid: string; raw: unknown }[];
  create(name: string, recipe: Recipe): Promise<{ id: string; uuid: string }>;
  update(id: string, name: string, recipe: Recipe): Promise<void>;
  delete(id: string): Promise<void>;
}

export class EncounterRepository {
  constructor(private readonly store: RecipeStore) {}

  list(): RecipeRecord[] {
    const out: RecipeRecord[] = [];
    for (const { id, uuid, raw } of this.store.list()) {
      const v = validateRecipe(raw);
      if (v.ok) out.push({ id, uuid, recipe: v.value });
      else console.warn(`${MODULE_ID} | ignoring invalid recipe ${id}`, v.errors);
    }
    return out.sort((a, b) => b.recipe.updatedAt - a.recipe.updatedAt);
  }

  get(id: string): RecipeRecord | null {
    return this.list().find((r) => r.id === id) ?? null;
  }

  async save(recipe: Recipe): Promise<RecipeRecord> {
    this.#assertGM();
    const v = validateRecipe(recipe);
    if (!v.ok) throw new Error(`invalid recipe: ${v.errors.join(", ")}`);
    const { id, uuid } = await this.store.create(recipe.name, recipe);
    return { id, uuid, recipe };
  }

  async update(id: string, recipe: Recipe): Promise<void> {
    this.#assertGM();
    const v = validateRecipe(recipe);
    if (!v.ok) throw new Error(`invalid recipe: ${v.errors.join(", ")}`);
    await this.store.update(id, recipe.name, { ...recipe, updatedAt: Date.now() });
  }

  async rename(id: string, name: string): Promise<void> {
    const record = this.get(id);
    if (record) await this.update(id, { ...record.recipe, name: name.trim() || record.recipe.name });
  }

  async delete(id: string): Promise<void> {
    this.#assertGM();
    await this.store.delete(id);
  }

  #assertGM(): void {
    if (typeof game !== "undefined" && !game.user.isGM) throw new Error("GM only");
  }
}

/* -------------------------------------------- */
/*  Foundry store                               */
/* -------------------------------------------- */

export class JournalRecipeStore implements RecipeStore {
  list(): { id: string; uuid: string; raw: unknown }[] {
    return game.journal
      .filter((j) => !!j.getFlag(MODULE_ID, FLAGS.recipe))
      .map((j) => ({ id: j.id, uuid: j.uuid, raw: j.getFlag(MODULE_ID, FLAGS.recipe) }));
  }

  async create(name: string, recipe: Recipe): Promise<{ id: string; uuid: string }> {
    const folder = await this.#ensureFolder();
    const levels = ownershipLevels();
    const journal: JournalEntryDocument = await documentClass("JournalEntry").create({
      name,
      folder: folder?.id ?? null,
      ownership: { default: levels.NONE },
      flags: { [MODULE_ID]: { [FLAGS.recipe]: recipe } },
      pages: [summaryPageData(recipe)],
    });
    return { id: journal.id, uuid: journal.uuid };
  }

  async update(id: string, name: string, recipe: Recipe): Promise<void> {
    const journal = game.journal.get(id);
    if (!journal) throw new Error(`recipe ${id} not found`);
    // Replace the flag wholesale: a merge would keep keys (trace, variantOf, generation) the new recipe omits.
    await journal.update({
      name,
      [`flags.${MODULE_ID}.-=${FLAGS.recipe}`]: null,
      [`flags.${MODULE_ID}.${FLAGS.recipe}`]: recipe,
    });
    const pageId = findSummaryPageId(journal.pages.contents);
    if (pageId)
      await journal.updateEmbeddedDocuments("JournalEntryPage", [
        { _id: pageId, "text.content": summaryHtml(recipe), [`flags.${MODULE_ID}.${FLAGS.summary}`]: true },
      ]);
    // Never overwrite a page the GM wrote: add a fresh managed summary page instead.
    else await journal.createEmbeddedDocuments("JournalEntryPage", [summaryPageData(recipe)]);
  }

  async delete(id: string): Promise<void> {
    const journal = game.journal.get(id);
    if (journal) await journal.delete();
  }

  async #ensureFolder(): Promise<FolderDocument | null> {
    const existing = game.folders.find(
      (f) => f.type === "JournalEntry" && f.name === DOCUMENT_NAMES.recipeFolder,
    );
    if (existing) return existing;
    try {
      return await documentClass("Folder").create({
        name: DOCUMENT_NAMES.recipeFolder,
        type: "JournalEntry",
      });
    } catch {
      return null;
    }
  }
}

/** Minimal view of a JournalEntryPage for finding the managed summary page. */
export interface SummaryPageCandidate {
  id: string;
  name: string;
  type: string;
  flags?: Record<string, Record<string, unknown> | undefined>;
}

/**
 * The page holding the module-managed summary: the page flagged as such, or, for entries saved before the
 * flag existed, the single text page named "Summary" the module created. Null when neither is found
 * (e.g. the GM deleted or renamed it), so the caller adds a new page instead of overwriting the GM's.
 */
export function findSummaryPageId(pages: readonly SummaryPageCandidate[]): string | null {
  const flagged = pages.find((p) => p.flags?.[MODULE_ID]?.[FLAGS.summary] === true);
  if (flagged) return flagged.id;
  const legacy = pages.filter((p) => p.name === "Summary" && p.type === "text");
  return legacy.length === 1 ? legacy[0]!.id : null;
}

function summaryPageData(recipe: Recipe): Record<string, unknown> {
  return {
    name: "Summary",
    type: "text",
    text: { content: summaryHtml(recipe), format: 1 },
    flags: { [MODULE_ID]: { [FLAGS.summary]: true } },
  };
}

function summaryHtml(recipe: Recipe): string {
  const rows = recipe.entries
    .map((e) => `<li>${escape(e.name)} (level ${e.level}) × ${e.quantity}</li>`)
    .join("");
  const ev = recipe.evaluation;
  const evText = ev
    ? `<p>Saved evaluation: ${escape(ev.partyName)} (${ev.partySize} × level ${ev.referenceLevel}), ${ev.supportedXP} XP, inferred ${escape(ev.inferredLabel)}${ev.complete ? "" : " (incomplete)"}.</p>`
    : "";
  return `<p><em>Managed by PF2e Encounter Builder. Edit it from the Encounter Builder's Saved tab.</em></p><ul>${rows}</ul>${evText}${recipe.notes ? `<p>${escape(recipe.notes)}</p>` : ""}`;
}
