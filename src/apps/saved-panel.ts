/**
 * Saved tab: list, open, recalculate, update-evaluation, duplicate, rename, delete saved encounters,
 * plus "save current encounter" from the Build tab.
 */
import {
  draftFromRecipe,
  duplicateRecipe,
  recalculateRecipe,
  recipeFromDraft,
  snapshotEvaluation,
} from "../core/recipe.js";
import type { EvaluationSnapshot, Recipe, RecipeEntry } from "../core/schemas.js";
import { isGM } from "../foundry/compat.js";
import { escapeHtml } from "../core/util.js";
import {
  EncounterRepository,
  JournalRecipeStore,
  type RecipeRecord,
} from "../foundry/encounter-repository.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import type { TreasurePanel } from "./treasure-panel.js";
import { confirm, promptText } from "./encounter-builder-app.js";

export class SavedPanel {
  readonly repository = new EncounterRepository(new JournalRecipeStore());
  selectedId: string | null = null;
  recalculated: EvaluationSnapshot | null = null;
  missing: RecipeEntry[] = [];

  constructor(private readonly app: EncounterBuilderApp) {}

  async prepareContext(): Promise<Record<string, unknown>> {
    const records = this.repository.list();
    const selected = this.selectedId ? (records.find((r) => r.id === this.selectedId) ?? null) : null;
    const roster = this.app.state.resolved?.roster ?? null;
    const canRecalc = !!roster && roster.blockers.length === 0 && roster.reference.level !== null;
    return {
      records: records.map((r) => ({
        id: r.id,
        name: r.recipe.name,
        origin: t(`saved.origin.${r.recipe.origin}`),
        count: r.recipe.entries.reduce((n, e) => n + e.quantity, 0),
        updated: new Date(r.recipe.updatedAt).toLocaleString(),
        selected: r.id === this.selectedId,
      })),
      selected: selected ? this.#describe(selected) : null,
      recalculated: this.recalculated ? describeSnapshot(this.recalculated) : null,
      missing: this.missing,
      canRecalc,
      canSave: this.app.state.draft.entries.length > 0 && isGM(),
    };
  }

  #describe(record: RecipeRecord): Record<string, unknown> {
    const r = record.recipe;
    return {
      id: record.id,
      name: r.name,
      notes: r.notes,
      origin: t(`saved.origin.${r.origin}`),
      policy: r.policy ? t(`saved.policy.${r.policy}`) : null,
      entries: r.entries,
      seed: r.generation?.seed ?? null,
      evaluation: r.evaluation ? describeSnapshot(r.evaluation) : null,
      hasTrace: r.trace !== undefined,
      variant: r.variantOf
        ? {
            original: r.variantOf.original,
            diff: r.variantOf.diff.map((d) => ({ ...d, changeLabel: t(`saved.change.${d.change}`) })),
          }
        : null,
      created: new Date(r.createdAt).toLocaleString(),
      updated: new Date(r.updatedAt).toLocaleString(),
    };
  }

  async onChange(name: string, value: string): Promise<boolean> {
    if (name !== "saved.selected") return false;
    this.selectedId = value || null;
    this.recalculated = null;
    this.missing = [];
    await this.app.render({ parts: ["saved"] });
    return true;
  }

  async select(id?: string): Promise<void> {
    this.selectedId = id ?? null;
    this.recalculated = null;
    this.missing = [];
    await this.app.render({ parts: ["saved"] });
  }

  /** Save the current draft as a new recipe (Build tab shortcut and Saved tab button). */
  async saveCurrent(): Promise<void> {
    if (!isGM() || this.app.state.draft.entries.length === 0) return;
    const name = await promptText(t("saved.saveTitle"), t("saved.nameLabel"), t("saved.defaultName"));
    if (name === null) return;
    const resolved = this.app.state.resolved;
    const snapshot = snapshotEvaluation(
      resolved?.profile ?? null,
      resolved?.roster ?? null,
      this.app.state.evaluation,
    );
    const recipe = recipeFromDraft(name, this.app.state.draft, snapshot);
    const treasure = this.#treasure().toRecord();
    if (treasure) recipe.treasure = treasure;
    const record = await this.repository.save(recipe);
    this.selectedId = record.id;
    this.app.pushMessage("ok", t("saved.savedMessage", { name: recipe.name }));
    this.app.activeTab = "saved";
    await this.app.render({ parts: ["header", "tabs", "saved"] });
  }

  async open(id?: string): Promise<void> {
    const record = this.repository.get(id ?? this.selectedId ?? "");
    if (!record) return;
    const { catalog } = services();
    await catalog.ensureLoaded();
    const lookup = (uuid: string) => {
      const entry = catalog.get(uuid);
      if (entry)
        return {
          name: entry.name,
          level: entry.level,
          img: entry.img,
          packLabel: entry.packLabel,
          traits: entry.traits,
        };
      const doc = fromUuidSync(uuid) as ActorDocument | null;
      return doc && doc.documentName === "Actor"
        ? { name: doc.name, level: doc.level ?? undefined, img: doc.img ?? null }
        : null;
    };
    // Resolve compendium entries whose packs are not selected.
    for (const e of record.recipe.entries)
      if (!catalog.get(e.uuid) && e.uuid.startsWith("Compendium.")) await catalog.locate(e.uuid);
    const { draft, missing } = draftFromRecipe(record.recipe, lookup);
    this.missing = missing;
    this.selectedId = record.id;
    this.app.setDraft(draft);
    await this.#treasure().fromRecord(record.recipe.treasure);
    if (missing.length) this.app.pushMessage("warn", t("saved.missingSources", { count: missing.length }));
    else this.app.pushMessage("ok", t("saved.opened", { name: record.recipe.name }));
    this.app.activeTab = "build";
    await this.app.render({ parts: ["header", "tabs", "build", "saved", "deploy", "treasure"] });
  }

  #treasure(): TreasurePanel {
    return this.app.extensions.treasure as TreasurePanel;
  }

  /** Show a fresh evaluation beside the saved one; never overwrites. */
  async recalculate(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    const roster = this.app.state.resolved?.roster;
    if (!record || !roster || roster.blockers.length > 0 || roster.reference.level === null) {
      this.app.pushMessage("warn", t("evaluation.blocked"));
      await this.app.render({ parts: ["header", "saved"] });
      return;
    }
    this.recalculated = {
      ...recalculateRecipe(record.recipe, roster.partySize, roster.reference.level),
      partyName: this.app.state.resolved?.profile.name ?? "",
      partyProfileId: this.app.state.resolved?.profile.id ?? null,
      referencePolicy: roster.reference.policy,
      memberLevels: roster.counted.map((m) => ({ uuid: m.uuid, name: m.name, level: m.level ?? 0 })),
    };
    await this.app.render({ parts: ["saved"] });
  }

  /** Explicit overwrite of the saved snapshot with the recalculated one. */
  async updateEvaluation(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !this.recalculated || !isGM()) return;
    const ok = await confirm(t("saved.updateEvalTitle"), t("saved.updateEvalConfirm"));
    if (!ok) return;
    await this.repository.update(record.id, { ...record.recipe, evaluation: this.recalculated });
    this.recalculated = null;
    await this.app.render({ parts: ["saved"] });
  }

  /** Replace the saved entries/notes with the current draft (explicit edit). */
  async updateFromDraft(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !isGM() || this.app.state.draft.entries.length === 0) return;
    const ok = await confirm(
      t("saved.updateTitle"),
      t("saved.updateConfirm", { name: escapeHtml(record.recipe.name) }),
    );
    if (!ok) return;
    const resolved = this.app.state.resolved;
    const snapshot = snapshotEvaluation(
      resolved?.profile ?? null,
      resolved?.roster ?? null,
      this.app.state.evaluation,
    );
    const fresh = recipeFromDraft(record.recipe.name, this.app.state.draft, snapshot, record.recipe.notes);
    const updated: Recipe = { ...fresh, createdAt: record.recipe.createdAt };
    const treasure = this.#treasure().toRecord();
    if (treasure) updated.treasure = treasure;
    await this.repository.update(record.id, updated);
    this.app.pushMessage("ok", t("saved.savedMessage", { name: record.recipe.name }));
    await this.app.render({ parts: ["header", "saved"] });
  }

  async editNotes(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !isGM()) return;
    const notes = await promptText(t("saved.notesTitle"), t("saved.notesLabel"), record.recipe.notes);
    if (notes === null) return;
    await this.repository.update(record.id, { ...record.recipe, notes });
    await this.app.render({ parts: ["saved"] });
  }

  async rename(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !isGM()) return;
    const name = await promptText(t("saved.renameTitle"), t("saved.nameLabel"), record.recipe.name);
    if (name === null) return;
    await this.repository.rename(record.id, name);
    await this.app.render({ parts: ["saved"] });
  }

  async duplicate(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !isGM()) return;
    const copy = await this.repository.save(
      duplicateRecipe(record.recipe, t("saved.copyName", { name: record.recipe.name })),
    );
    this.selectedId = copy.id;
    await this.app.render({ parts: ["saved"] });
  }

  async delete(): Promise<void> {
    const record = this.repository.get(this.selectedId ?? "");
    if (!record || !isGM()) return;
    const ok = await confirm(
      t("saved.deleteTitle"),
      t("saved.deleteConfirm", { name: escapeHtml(record.recipe.name) }),
      "fa-solid fa-trash",
    );
    if (!ok) return;
    await this.repository.delete(record.id);
    this.selectedId = null;
    this.recalculated = null;
    await this.app.render({ parts: ["saved"] });
  }
}

function describeSnapshot(s: EvaluationSnapshot): Record<string, unknown> {
  return {
    ...s,
    when: new Date(s.timestamp).toLocaleString(),
    levels: s.memberLevels.map((m) => m.level).join(", "),
    threatLabel: s.selectedThreat ? t(`threat.${s.selectedThreat}`) : "—",
    inferredLabel: s.inferredLabel.startsWith("beyondExtreme")
      ? s.inferredLabel.replace("beyondExtreme", t("evaluation.beyondExtreme"))
      : t(`threat.${s.inferredLabel}`),
    completeLabel: s.complete ? t("evaluation.complete") : t("evaluation.incomplete"),
    differenceLabel:
      s.difference === null ? "—" : s.difference > 0 ? `+${s.difference}` : String(s.difference),
  };
}
