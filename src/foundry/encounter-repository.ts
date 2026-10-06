/**
 * EncounterRepository: saved encounter recipes as JournalEntry documents in a module folder,
 * GM-private by default, with data in a versioned flag.
 */
import { FLAGS, MODULE_ID } from "../constants.js";
import { validateRecipe, type Recipe } from "../core/schemas.js";
import { documentClass, ownershipLevels } from "./compat.js";
import { escapeHtml as escape } from "../core/util.js";
import { t } from "./i18n.js";
import { ensureModuleFolder, localizedDocumentName } from "./module-folders.js";

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
    const folder = await ensureModuleFolder("recipes");
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
}

/** Minimal view of a JournalEntryPage for finding the managed summary page. */
export interface SummaryPageCandidate {
  id: string;
  name: string;
  type: string;
  flags?: Record<string, Record<string, unknown> | undefined>;
}

/** Name of the summary page that versions before the summary flag gave it (always English). */
const LEGACY_SUMMARY_PAGE_NAME = "Summary";

/**
 * The page holding the module-managed summary: the page flagged as such, or, for entries saved before the
 * flag existed, the single text page named "Summary" the module created. Null when neither is found
 * (e.g. the GM deleted or renamed it), so the caller adds a new page instead of overwriting the GM's.
 */
export function findSummaryPageId(pages: readonly SummaryPageCandidate[]): string | null {
  const flagged = pages.find((p) => p.flags?.[MODULE_ID]?.[FLAGS.summary] === true);
  if (flagged) return flagged.id;
  const legacy = pages.filter((p) => p.name === LEGACY_SUMMARY_PAGE_NAME && p.type === "text");
  return legacy.length === 1 ? legacy[0]!.id : null;
}

function summaryPageData(recipe: Recipe): Record<string, unknown> {
  return {
    name: localizedDocumentName("journal.summaryPage", LEGACY_SUMMARY_PAGE_NAME),
    type: "text",
    text: { content: summaryHtml(recipe), format: 1 },
    flags: { [MODULE_ID]: { [FLAGS.summary]: true } },
  };
}

/** Localized text with an English fallback for when no translation is loaded (tests, early hooks). */
function text(key: string, fallback: string, data: Record<string, unknown> = {}): string {
  const out = t(key, data);
  if (out && out !== `${MODULE_ID}.${key}`) return out;
  return fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(data[k] ?? ""));
}

function summaryHtml(recipe: Recipe): string {
  const rows = recipe.entries
    .map(
      (e) =>
        `<li>${text("journal.summaryEntry", "{name} (level {level}) × {quantity}", {
          name: escape(e.name),
          level: e.level,
          quantity: e.quantity,
        })}</li>`,
    )
    .join("");
  const ev = recipe.evaluation;
  const evText = ev
    ? `<p>${text(
        ev.complete ? "journal.summaryEvaluation" : "journal.summaryEvaluationIncomplete",
        ev.complete
          ? "Saved evaluation: {party} ({size} × level {level}), {xp} XP, inferred {threat}."
          : "Saved evaluation: {party} ({size} × level {level}), {xp} XP, inferred {threat} (incomplete).",
        {
          party: escape(ev.partyName),
          size: ev.partySize,
          level: ev.referenceLevel,
          xp: ev.supportedXP,
          threat: escape(ev.inferredLabel),
        },
      )}</p>`
    : "";
  const managed = text(
    "journal.summaryManaged",
    "Managed by PF2e Encounter Builder. Edit it from the Encounter Builder's Saved tab.",
  );
  return `<p><em>${escape(managed)}</em></p><ul>${rows}</ul>${evText}${recipe.notes ? `<p>${escape(recipe.notes)}</p>` : ""}`;
}
