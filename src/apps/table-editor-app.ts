/**
 * EncounterTableEditor: structured editing layered on a native RollTable.
 * Nothing is written until the GM clicks Save; saving touches only module flags and edited rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MODULE_ID } from "../constants.js";
import { validateFormula } from "../core/dice-grammar.js";
import {
  COMPOSITION_PREFERENCES,
  emptyResultFlags,
  type NarrativeKind,
  type ResultFlags,
  type ResultKind,
  type TableFlags,
} from "../core/schemas.js";
import { THREAT_LEVELS } from "../core/budget.js";
import {
  NARRATIVE_KINDS,
  RESULT_KINDS,
  rangesFromWeights,
  validateTable,
  type TableIssue,
  type TableModel,
  type TableRow,
} from "../core/table-model.js";
import {
  ApplicationV2,
  DragDropClass,
  HandlebarsApplicationMixin,
  getDragEventData,
  isGM,
} from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { saveTable, tableToModel, type RowEdit } from "../foundry/table-flags.js";
import { escapeHtml, splitList } from "../core/util.js";
import { confirm } from "./dialogs.js";

const Base = HandlebarsApplicationMixin()(ApplicationV2()) as any;

interface EditRow {
  key: string;
  id: string | null;
  range: [number, number];
  weight: number;
  text: string;
  documentUuid: string | null;
  /** null = native row shown read-only */
  flags: ResultFlags | null;
  drawn: boolean;
}

export class EncounterTableEditor extends Base {
  static #instances = new Map<string, EncounterTableEditor>();

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-table-editor-{id}`,
    classes: ["seb", "seb-editor"],
    tag: "div",
    window: { title: `${MODULE_ID}.editor.title`, icon: "fa-solid fa-table-list", resizable: true },
    position: { width: 860, height: 720 },
    actions: {
      addRow: EncounterTableEditor.#onAddRow,
      removeRow: EncounterTableEditor.#onRemoveRow,
      moveUp: EncounterTableEditor.#onMoveRow,
      moveDown: EncounterTableEditor.#onMoveRow,
      configureRow: EncounterTableEditor.#onConfigureRow,
      addCreature: EncounterTableEditor.#onAddCreature,
      removeCreature: EncounterTableEditor.#onRemoveCreature,
      deriveRanges: EncounterTableEditor.#onDeriveRanges,
      validate: EncounterTableEditor.#onValidate,
      save: EncounterTableEditor.#onSave,
    },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/table-editor.hbs`, scrollable: [".seb-rows"] },
  };

  tableUuid: string;
  model: TableModel | null = null;
  formula = "1d100";
  flags: TableFlags | null = null;
  rows: EditRow[] = [];
  deleteIds: string[] = [];
  issues: TableIssue[] = [];
  dirty = false;
  #listening = false;
  #names = new Map<string, string>();
  /** Close-confirmation state: a prompt is open, or the GM already chose to discard. */
  #closePrompt = false;
  #discardConfirmed = false;

  constructor(tableUuid: string, options: Record<string, unknown> = {}) {
    super({ ...options, id: `${MODULE_ID}-table-editor-${tableUuid.replace(/\W/g, "_")}` });
    this.tableUuid = tableUuid;
  }

  static async open(tableUuid: string): Promise<EncounterTableEditor | null> {
    if (!isGM()) return null;
    let app = EncounterTableEditor.#instances.get(tableUuid);
    if (!app) {
      app = new EncounterTableEditor(tableUuid);
      EncounterTableEditor.#instances.set(tableUuid, app);
    }
    // Reopening an editor with unsaved edits brings it forward instead of reloading over the edits.
    if (app.rendered && app.dirty) {
      app.bringToFront?.();
      return app;
    }
    await app.load();
    await app.render({ force: true });
    return app;
  }

  async load(): Promise<void> {
    const doc = (await fromUuid(this.tableUuid)) as RollTableDocument | null;
    if (!doc) throw new Error(`table ${this.tableUuid} not found`);
    this.model = tableToModel(doc);
    this.formula = this.model.formula;
    this.flags = structuredClone(this.model.flags);
    this.rows = this.model.rows.map((r) => ({
      key: r.id,
      id: r.id,
      range: [...r.range] as [number, number],
      weight: r.weight,
      text: r.text,
      documentUuid: r.documentUuid,
      flags: r.flags ? structuredClone(r.flags) : null,
      drawn: r.drawn,
    }));
    this.deleteIds = [];
    this.dirty = false;
    await this.#resolveNames();
    this.#validate();
  }

  async #resolveNames(): Promise<void> {
    const { catalog } = services();
    for (const row of this.rows) {
      for (const c of row.flags?.creatures ?? []) {
        if (this.#names.has(c.uuid)) continue;
        const entry = await catalog.locate(c.uuid);
        if (entry) this.#names.set(c.uuid, entry.name);
        else {
          const doc = fromUuidSync(c.uuid) as { name?: string } | null;
          if (doc?.name) this.#names.set(c.uuid, doc.name);
        }
      }
      for (const uuid of row.flags?.template?.candidates ?? []) {
        if (this.#names.has(uuid)) continue;
        const entry = await catalog.locate(uuid);
        const name = entry?.name ?? (fromUuidSync(uuid) as { name?: string } | null)?.name;
        if (name) this.#names.set(uuid, name);
      }
      if (row.flags?.tableUuid && !this.#names.has(row.flags.tableUuid)) {
        const doc = fromUuidSync(row.flags.tableUuid) as { name?: string } | null;
        if (doc?.name) this.#names.set(row.flags.tableUuid, doc.name);
      }
    }
  }

  #currentModel(): TableModel {
    const rows: TableRow[] = this.rows.map((r) => ({
      id: r.key,
      text: r.text,
      documentUuid: r.documentUuid,
      range: r.range,
      weight: r.weight,
      drawn: r.drawn,
      flags: r.flags,
    }));
    return {
      uuid: this.tableUuid,
      name: this.model?.name ?? "",
      formula: this.formula,
      replacement: this.model?.replacement ?? true,
      mode: this.flags?.mode ?? "range",
      flags: this.flags!,
      rows,
    };
  }

  #validate(): void {
    this.issues = validateTable(this.#currentModel(), {
      exists: (uuid) => (this.#names.has(uuid) || fromUuidSync(uuid) ? true : false),
      getTable: (uuid) => {
        const doc = fromUuidSync(uuid) as RollTableDocument | null;
        return doc && doc.documentName === "RollTable" ? tableToModel(doc) : null;
      },
    });
  }

  /* -------------------------------------------- */

  async _prepareContext(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = (await super._prepareContext?.(options)) ?? {};
    const issuesByRow = new Map<string, TableIssue[]>();
    const tableIssues: TableIssue[] = [];
    for (const issue of this.issues) {
      if (issue.rowId) issuesByRow.set(issue.rowId, [...(issuesByRow.get(issue.rowId) ?? []), issue]);
      else tableIssues.push(issue);
    }
    const describe = (issue: TableIssue) => ({
      level: issue.level,
      text: t(`editor.issues.${issue.code}`, issue.data),
    });
    const formula = validateFormula(this.formula);
    return {
      ...base,
      // Prefix for element ids: several editors (one per table) can be open at once.
      uid: this.id,
      name: this.model?.name ?? "",
      formula: this.formula,
      formulaRange: formula.ok ? `${formula.min}–${formula.max}` : t("editor.formulaInvalid"),
      flags: this.flags,
      isWeight: this.flags?.mode === "weight",
      encounterCheck: this.flags?.encounterCheck ?? { formula: "", occursOn: [] },
      occursOn: this.flags?.encounterCheck?.occursOn.join(", ") ?? "",
      tags: {
        region: this.flags?.tags.region.join(", ") ?? "",
        terrain: this.flags?.tags.terrain.join(", ") ?? "",
        season: this.flags?.tags.season.join(", ") ?? "",
        timeOfDay: this.flags?.tags.timeOfDay.join(", ") ?? "",
      },
      tableIssues: tableIssues.map(describe),
      dirty: this.dirty,
      replacement: this.model?.replacement ?? true,
      rows: this.rows.map((row, index) => ({
        ...row,
        index,
        rowNumber: index + 1,
        isNative: !row.flags,
        kinds: RESULT_KINDS.map((k) => ({
          value: k,
          label: t(`editor.kind.${k}`),
          selected: row.flags?.kind === k,
        })),
        narrativeKinds: NARRATIVE_KINDS.map((k) => ({
          value: k,
          label: t(`tables.narrative.${k}`),
          selected: row.flags?.narrativeKind === k,
        })),
        isCreatures: row.flags?.kind === "creatures",
        isTable: row.flags?.kind === "table",
        isNarrative: row.flags?.kind === "narrative",
        isTemplate: row.flags?.kind === "template",
        creatures: (row.flags?.creatures ?? []).map((c, ci) => ({
          ...c,
          ci,
          number: ci + 1,
          name: this.#names.get(c.uuid) ?? c.uuid,
          quantityValid: validateFormula(c.quantity).ok,
        })),
        tableName: row.flags?.tableUuid ? (this.#names.get(row.flags.tableUuid) ?? row.flags.tableUuid) : "",
        template: row.flags?.template ?? {
          candidates: [],
          traits: [],
          levelMin: null,
          levelMax: null,
          composition: "unrestricted",
          threat: null,
        },
        // The input holds raw UUIDs (it is parsed back as UUIDs); resolved names are shown read-only below it.
        templateCandidates: (row.flags?.template?.candidates ?? []).join(", "),
        templateCandidateNames: (row.flags?.template?.candidates ?? [])
          .map((uuid) => this.#names.get(uuid) ?? uuid)
          .join(", "),
        templateTraits: row.flags?.template?.traits.join(", ") ?? "",
        compositions: COMPOSITION_PREFERENCES.map((value) => ({
          value,
          label: t(`generator.composition.${value}`),
          selected: (row.flags?.template?.composition ?? "unrestricted") === value,
        })),
        threatOptions: THREAT_LEVELS.map((value) => ({
          value,
          label: t(`threat.${value}`),
          selected: row.flags?.template?.threat === value,
        })),
        issues: (issuesByRow.get(row.key) ?? []).map(describe),
        invalid: (issuesByRow.get(row.key) ?? []).some((i) => i.level === "error"),
      })),
    };
  }

  async _onRender(context: Record<string, unknown>, options: Record<string, unknown>): Promise<void> {
    await super._onRender?.(context, options);
    const root: HTMLElement = this.element;
    if (!this.#listening) {
      root.addEventListener("change", (event) => void this.#onChange(event));
      this.#listening = true;
    }
    const DragDrop = DragDropClass();
    if (DragDrop) {
      new DragDrop({
        dropSelector: ".seb-ed-row",
        permissions: { dragstart: () => false, drop: () => isGM() },
        callbacks: { drop: (event: DragEvent) => void this.#onDrop(event) },
      }).bind(root);
    }
  }

  /** Ask before discarding unsaved edits. A confirmed close does not prompt again. */
  async close(options: Record<string, unknown> = {}): Promise<this> {
    if (this.dirty && !this.#discardConfirmed) {
      if (this.#closePrompt) return this;
      this.#closePrompt = true;
      let ok: boolean;
      try {
        ok = await confirm(
          t("editor.unsavedTitle"),
          t("editor.unsavedConfirm", { name: escapeHtml(this.model?.name ?? "") }),
        );
      } finally {
        this.#closePrompt = false;
      }
      if (!ok) return this;
      this.#discardConfirmed = true;
    }
    try {
      return await super.close(options);
    } finally {
      this.#discardConfirmed = false;
    }
  }

  _onClose(options: Record<string, unknown>): void {
    super._onClose?.(options);
    EncounterTableEditor.#instances.delete(this.tableUuid);
    this.#listening = false;
  }

  /* -------------------------------------------- */

  async #onChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const name = target?.name;
    if (!name || !this.flags) return;
    const value = target.value;
    this.dirty = true;
    const [scope, a, b, c] = name.split(".");
    if (scope === "table") {
      switch (a) {
        case "formula":
          this.formula = value.trim();
          break;
        case "mode":
          this.flags.mode = value === "weight" ? "weight" : "range";
          break;
        case "notes":
          this.flags.notes = value;
          break;
        case "checkFormula":
          this.flags.encounterCheck = value.trim()
            ? { formula: value.trim(), occursOn: this.flags.encounterCheck?.occursOn ?? [1] }
            : null;
          break;
        case "checkOccursOn":
          if (this.flags.encounterCheck) this.flags.encounterCheck.occursOn = parseIntList(value);
          break;
        case "tag":
          if (b && b in this.flags.tags) (this.flags.tags as Record<string, string[]>)[b] = splitList(value);
          break;
      }
    } else if (scope === "row" && a !== undefined) {
      const row = this.rows[Number(a)];
      if (!row) return;
      switch (b) {
        case "lo":
          row.range = [Number.parseInt(value, 10) || 0, row.range[1]];
          break;
        case "hi":
          row.range = [row.range[0], Number.parseInt(value, 10) || 0];
          break;
        case "weight":
          row.weight = Number.parseInt(value, 10) || 0;
          break;
        case "text":
          row.text = value;
          break;
        case "kind":
          if (row.flags && RESULT_KINDS.includes(value as ResultKind)) {
            const kind = value as ResultKind;
            row.flags = {
              ...row.flags,
              kind,
              narrativeKind: kind === "narrative" ? (row.flags.narrativeKind ?? "other") : null,
            };
            if (kind === "template" && !row.flags.template)
              row.flags.template = {
                candidates: [],
                traits: [],
                levelMin: null,
                levelMax: null,
                composition: "unrestricted",
                threat: null,
              };
          }
          break;
        case "narrativeKind":
          if (row.flags)
            row.flags.narrativeKind = NARRATIVE_KINDS.includes(value as NarrativeKind)
              ? (value as NarrativeKind)
              : "other";
          break;
        case "notes":
          if (row.flags) row.flags.notes = value;
          break;
        case "journalUuid":
          if (row.flags) row.flags.journalUuid = value.trim() || null;
          break;
        case "tableUuid":
          if (row.flags) row.flags.tableUuid = value.trim() || null;
          break;
        case "creature": {
          const line = row.flags?.creatures[Number(c)];
          if (!line) return;
          // name: row.<i>.creature.<ci>.<field> -> parts: [row, i, creature, ci, field]
          const field = name.split(".")[4];
          if (field === "quantity") line.quantity = value.trim();
          else if (field === "uuid") line.uuid = value.trim();
          break;
        }
        case "template": {
          const tp = row.flags?.template;
          if (!tp) return;
          switch (c) {
            case "candidates":
              tp.candidates = splitList(value, false);
              await this.#resolveNames();
              break;
            case "traits":
              tp.traits = splitList(value);
              break;
            case "levelMin":
              tp.levelMin = value === "" ? null : Number.parseInt(value, 10);
              break;
            case "levelMax":
              tp.levelMax = value === "" ? null : Number.parseInt(value, 10);
              break;
            case "composition":
              tp.composition = value as typeof tp.composition;
              break;
            case "threat":
              tp.threat = (value || null) as typeof tp.threat;
              break;
          }
          break;
        }
      }
    }
    this.#validate();
    await this.render();
  }

  async #onDrop(event: DragEvent): Promise<void> {
    const data = getDragEventData(event);
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>(".seb-ed-row");
    const row = rowEl ? this.rows[Number(rowEl.dataset.index)] : undefined;
    if (!row || typeof data.uuid !== "string") return;
    if (!row.flags) row.flags = { ...emptyResultFlags("narrative"), notes: "" };
    if (data.type === "Actor") {
      row.flags.kind = "creatures";
      row.flags.creatures.push({ uuid: data.uuid, quantity: "1" });
      const name = (fromUuidSync(data.uuid) as { name?: string } | null)?.name;
      if (name) this.#names.set(data.uuid, name);
    } else if (data.type === "RollTable") {
      row.flags.kind = "table";
      row.flags.tableUuid = data.uuid;
      const name = (fromUuidSync(data.uuid) as { name?: string } | null)?.name;
      if (name) this.#names.set(data.uuid, name);
    } else if (data.type === "JournalEntry" || data.type === "JournalEntryPage") {
      row.flags.journalUuid = data.uuid;
    } else return;
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  /* -------------------------------------------- */

  static async #onAddRow(this: EncounterTableEditor): Promise<void> {
    const last = this.rows[this.rows.length - 1];
    const lo = last ? last.range[1] + 1 : 1;
    this.rows.push({
      key: `new-${Date.now()}-${this.rows.length}`,
      id: null,
      range: [lo, lo],
      weight: 1,
      text: "",
      documentUuid: null,
      flags: emptyResultFlags("narrative"),
      drawn: false,
    });
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  static async #onRemoveRow(this: EncounterTableEditor, _event: Event, target: HTMLElement): Promise<void> {
    const index = Number(target.closest<HTMLElement>(".seb-ed-row")?.dataset.index);
    const row = this.rows[index];
    if (!row) return;
    if (row.id) this.deleteIds.push(row.id);
    this.rows.splice(index, 1);
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  static async #onMoveRow(this: EncounterTableEditor, _event: Event, target: HTMLElement): Promise<void> {
    const index = Number(target.closest<HTMLElement>(".seb-ed-row")?.dataset.index);
    const delta = target.dataset.action === "moveUp" ? -1 : 1;
    const other = index + delta;
    if (!this.rows[index] || !this.rows[other]) return;
    [this.rows[index], this.rows[other]] = [this.rows[other]!, this.rows[index]!];
    this.dirty = true;
    await this.render();
  }

  static async #onConfigureRow(
    this: EncounterTableEditor,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const row = this.rows[Number(target.closest<HTMLElement>(".seb-ed-row")?.dataset.index)];
    if (!row || row.flags) return;
    row.flags = emptyResultFlags("narrative");
    if (row.documentUuid?.includes("RollTable")) {
      row.flags.kind = "table";
      row.flags.tableUuid = row.documentUuid;
    } else if (row.documentUuid?.includes("Actor")) {
      row.flags.kind = "creatures";
      row.flags.creatures.push({ uuid: row.documentUuid, quantity: "1" });
    }
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  static async #onAddCreature(this: EncounterTableEditor, _event: Event, target: HTMLElement): Promise<void> {
    const row = this.rows[Number(target.closest<HTMLElement>(".seb-ed-row")?.dataset.index)];
    if (!row?.flags) return;
    row.flags.creatures.push({ uuid: "", quantity: "1" });
    this.dirty = true;
    await this.render();
  }

  static async #onRemoveCreature(
    this: EncounterTableEditor,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const row = this.rows[Number(target.closest<HTMLElement>(".seb-ed-row")?.dataset.index)];
    const ci = Number(target.dataset.ci);
    if (!row?.flags) return;
    row.flags.creatures.splice(ci, 1);
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  /** Weight mode only: write derived ranges into the rows (explicit action, never automatic). */
  static async #onDeriveRanges(this: EncounterTableEditor): Promise<void> {
    if (this.flags?.mode !== "weight") return;
    const derived = rangesFromWeights(
      this.rows.map((r) => ({
        id: r.key,
        text: r.text,
        documentUuid: r.documentUuid,
        range: r.range,
        weight: r.weight,
        drawn: r.drawn,
        flags: r.flags,
      })),
    );
    derived.forEach((d, i) => {
      this.rows[i]!.range = d.range;
    });
    this.formula = derived[0]?.formula ?? this.formula;
    this.dirty = true;
    this.#validate();
    await this.render();
  }

  static async #onValidate(this: EncounterTableEditor): Promise<void> {
    this.#validate();
    await this.render();
  }

  static async #onSave(this: EncounterTableEditor): Promise<void> {
    if (!isGM() || !this.flags) return;
    this.#validate();
    if (this.issues.some((i) => i.level === "error")) {
      ui.notifications.warn(t("editor.saveBlocked"));
      await this.render();
      return;
    }
    const doc = (await fromUuid(this.tableUuid)) as RollTableDocument | null;
    if (!doc) return;
    const rows: RowEdit[] = this.rows
      .filter((r) => r.flags)
      .map((r) => ({ id: r.id, range: r.range, weight: r.weight, text: r.text, flags: r.flags! }));
    // Native rows stay unconfigured, but ranges derived from weights must still reach them.
    const nativeRanges = this.rows
      .filter((r) => !r.flags && r.id)
      .map((r) => ({ id: r.id!, range: r.range, weight: r.weight }));
    try {
      await saveTable(
        doc,
        { formula: this.formula, flags: this.flags, rows, deleteIds: this.deleteIds, nativeRanges },
        (uuid) => this.#names.get(uuid) ?? null,
      );
      ui.notifications.info(t("editor.saved", { name: doc.name }));
      await this.load();
      await this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      ui.notifications.error(
        t("errors.generic", { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  }
}

function parseIntList(value: string): number[] {
  return value
    .split(/[,;\s]+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
}
