/**
 * Tables tab: select a RollTable, roll it through the module resolver, inspect the trace,
 * apply the classic result to the draft, run a party-scaled template, or create a balanced variant.
 */
import { evaluateEncounter } from "../core/budget.js";
import { entryFromCatalog, toRecipeEntries, type Draft } from "../core/draft.js";
import { generateEncounter } from "../core/generator.js";
import { rngFromSeed } from "../core/rng.js";
import type { TraceEvent } from "../core/table-model.js";
import { diffEntries } from "../core/variant.js";
import { isGM } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { createEncounterTable, tableToModel } from "../foundry/table-flags.js";
import { listEncounterTables, rollEncounterTable, type TableRollReport } from "../foundry/table-resolver.js";
import { randomHexSeed } from "../core/util.js";
import { promptText } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import { panelActions, type Panel } from "./panel.js";
import { inferredThreatLabel } from "./view-models.js";

export class TablesPanel implements Panel {
  readonly actions: ReadonlySet<string> = panelActions<TablesPanel>(
    "roll",
    "applyClassic",
    "applyTemplate",
    "createVariant",
    "openEditor",
    "createTable",
    "validate",
  );
  selectedUuid: string | null = null;
  report: TableRollReport | null = null;
  busy = false;

  constructor(private readonly app: EncounterBuilderApp) {}

  async prepareContext(): Promise<Record<string, unknown>> {
    const tables = listEncounterTables().map((tb) => ({ ...tb, selected: tb.uuid === this.selectedUuid }));
    const report = this.report;
    const party = this.app.readyParty;
    let classicEvaluation: Record<string, unknown> | null = null;
    if (report && party && report.outcome.creatures.length) {
      const evaluation = evaluateEncounter({
        partySize: party.roster.partySize,
        referenceLevel: party.referenceLevel,
        selectedThreat: party.resolved.profile.selectedThreat,
        entries: report.outcome.creatures.map((c) => ({
          id: c.uuid,
          name: c.name,
          level: c.level ?? 0,
          quantity: c.quantity,
        })),
      });
      const inferred = evaluation.inferred;
      classicEvaluation = {
        supportedXP: evaluation.supportedXP,
        complete: evaluation.complete,
        inferredLabel: inferredThreatLabel(inferred.label, inferred.unquantified),
        warnings: evaluation.warnings.map((w) => t(`evaluation.warnings.${w.code}`, w.data)),
      };
    }
    return {
      tables,
      selected: this.selectedUuid,
      busy: this.busy,
      report: report
        ? {
            tableName: report.tableName,
            encounterOccurred: report.outcome.encounterOccurred,
            creatures: report.outcome.creatures.map((c) => ({ ...c, levelLabel: c.level ?? "?" })),
            narratives: report.outcome.narratives.map((n) => ({
              ...n,
              kindLabel: n.kind === "native" ? t("tables.native") : t(`tables.narrative.${n.kind}`),
            })),
            templates: report.outcome.templates.map((tp) => ({
              rowId: tp.rowId,
              text: tp.text,
              candidates: tp.template.candidates.length,
              traits: tp.template.traits.join(", "),
            })),
            unavailable: report.outcome.unavailable,
            notes: report.outcome.notes,
            errors: report.outcome.errors,
            stoppedByLimit: report.outcome.stoppedByLimit,
            replacementWarning: report.replacementWarning,
            trace: report.outcome.trace.map(formatTrace).join("\n"),
            hasCreatures: report.outcome.creatures.length > 0,
            hasTemplates: report.outcome.templates.length > 0,
            classicEvaluation,
          }
        : null,
      canRoll: !!this.selectedUuid && !this.busy,
    };
  }

  async onChange(name: string, value: string): Promise<boolean> {
    if (name !== "tables.selected") return false;
    this.selectedUuid = value || null;
    this.report = null;
    await this.app.render({ parts: ["tables"] });
    return true;
  }

  async onDrop(purpose: string | undefined, data: Record<string, unknown>): Promise<boolean> {
    if (purpose !== "table" || data.type !== "RollTable" || typeof data.uuid !== "string") return false;
    this.selectedUuid = data.uuid;
    this.report = null;
    await this.app.render({ parts: ["tables"] });
    return true;
  }

  async roll(): Promise<void> {
    if (!this.selectedUuid || this.busy) return;
    this.busy = true;
    await this.app.render({ parts: ["tables"] });
    try {
      this.report = await rollEncounterTable(this.selectedUuid);
    } catch (error) {
      this.app.reportError(error);
    } finally {
      this.busy = false;
    }
    await this.app.render({ parts: ["header", "tables"] });
  }

  /** Classic policy: load the rolled creatures into the draft unchanged. */
  async applyClassic(): Promise<void> {
    const report = this.report;
    if (!report || report.outcome.creatures.length === 0) return;
    const entries = report.outcome.creatures.map((c) =>
      entryFromCatalog({ ...c, level: c.level ?? 0 }, c.quantity),
    );
    const draft: Draft = { entries, origin: "table", trace: serializeReport(report) };
    this.app.setDraft(draft);
    this.app.pushMessage(
      "ok",
      t("tables.appliedClassic", { count: entries.reduce((n, e) => n + e.quantity, 0) }),
    );
    this.app.activeTab = "build";
    await this.app.render({ parts: ["header", "tabs", "build", "tables", "deploy"] });
  }

  /** Party-scaled policy: only for template rows. */
  async applyTemplate(): Promise<void> {
    const report = this.report;
    const template = report?.outcome.templates[0];
    const party = this.app.readyParty;
    if (!report || !template || !party) {
      this.app.pushMessage("warn", t(template ? "evaluation.blocked" : "tables.noTemplate"));
      await this.app.render({ parts: ["header", "tables"] });
      return;
    }
    const { catalog } = services();
    const tp = template.template;
    let candidates = (await Promise.all(tp.candidates.map((uuid) => catalog.locate(uuid)))).filter(
      (c): c is NonNullable<typeof c> => !!c,
    );
    if (candidates.length === 0 && tp.traits.length > 0)
      candidates = await catalog.search({ traits: tp.traits });
    const seed = randomHexSeed();
    const result = generateEncounter({
      threat: tp.threat ?? party.resolved.profile.selectedThreat,
      partySize: party.roster.partySize,
      referenceLevel: party.referenceLevel,
      candidates: candidates.map((c) => ({
        uuid: c.uuid,
        name: c.name,
        level: c.level,
        traits: c.traits,
        img: c.img,
        packLabel: c.packLabel,
      })),
      relativeMin: tp.levelMin ?? undefined,
      relativeMax: tp.levelMax ?? undefined,
      composition: tp.composition,
      rng: rngFromSeed(seed),
    });
    if (!result.ok) {
      this.app.pushMessage("error", t(`generator.failure.${result.reason}`, result.detail));
      await this.app.render({ parts: ["header", "tables"] });
      return;
    }
    const entries = result.entries.map((e) => entryFromCatalog(e, e.quantity));
    this.app.setDraft({
      entries,
      origin: "table",
      trace: serializeReport(report),
      generation: { seed, inputs: { template: tp, policy: "partyScaled" } },
    });
    this.app.pushMessage(
      "ok",
      t(`generator.resultMessage.${result.fit}`, {
        total: result.totalXP,
        target: result.target,
        difference: result.difference,
      }),
    );
    this.app.activeTab = "build";
    await this.app.render({ parts: ["header", "tabs", "build", "tables", "deploy"] });
  }

  /** Create a balanced variant of the classic result, keeping the original and recording the diff. */
  async createVariant(): Promise<void> {
    const report = this.report;
    const party = this.app.readyParty;
    if (!report || report.outcome.creatures.length === 0 || !party) {
      this.app.pushMessage("warn", t("evaluation.blocked"));
      await this.app.render({ parts: ["header", "tables"] });
      return;
    }
    const original = report.outcome.creatures.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      level: c.level ?? 0,
      quantity: c.quantity,
      locked: false,
    }));
    const pool = report.outcome.creatures.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      level: c.level ?? 0,
      traits: c.traits,
      img: c.img,
      packLabel: c.packLabel,
    }));
    const seed = randomHexSeed();
    const result = generateEncounter({
      threat: party.resolved.profile.selectedThreat,
      partySize: party.roster.partySize,
      referenceLevel: party.referenceLevel,
      candidates: pool,
      duplicateCap: 8,
      maxCount: 12,
      rng: rngFromSeed(seed),
    });
    if (!result.ok) {
      this.app.pushMessage(
        "error",
        t("tables.variantFailed", { reason: t(`generator.failure.${result.reason}`, result.detail) }),
      );
      await this.app.render({ parts: ["header", "tables"] });
      return;
    }
    const entries = result.entries.map((e) => entryFromCatalog(e, e.quantity));
    const draft: Draft = {
      entries,
      origin: "variant",
      trace: serializeReport(report),
      generation: { seed, inputs: { policy: "variant" } },
    };
    draft.variantOf = { original, diff: diffEntries(original, toRecipeEntries(draft)) };
    this.app.setDraft(draft);
    this.app.pushMessage("ok", t("tables.variantCreated", { changes: draft.variantOf.diff.length }));
    this.app.activeTab = "build";
    await this.app.render({ parts: ["header", "tabs", "build", "tables", "deploy"] });
  }

  async openEditor(): Promise<void> {
    if (!this.selectedUuid || !isGM()) return;
    const { EncounterTableEditor } = await import("./table-editor-app.js");
    await EncounterTableEditor.open(this.selectedUuid);
  }

  async createTable(): Promise<void> {
    if (!isGM()) return;
    const name = await promptText(t("tables.createTitle"), t("tables.createLabel"), t("tables.defaultName"));
    if (name === null) return;
    const table = await createEncounterTable(name);
    this.selectedUuid = table.uuid;
    this.report = null;
    await this.app.render({ parts: ["tables"] });
    await this.openEditor();
  }

  async validate(): Promise<void> {
    if (!this.selectedUuid) return;
    const doc = (await fromUuid(this.selectedUuid)) as RollTableDocument | null;
    if (!doc) return;
    const { validateTable } = await import("../core/table-model.js");
    const issues = validateTable(tableToModel(doc), { exists: (uuid) => (fromUuidSync(uuid) ? true : null) });
    this.app.pushMessage(
      issues.some((i) => i.level === "error") ? "warn" : "ok",
      t("tables.validated", {
        errors: issues.filter((i) => i.level === "error").length,
        warnings: issues.filter((i) => i.level === "warning").length,
      }),
    );
    await this.app.render({ parts: ["header"] });
  }
}

export function formatTrace(event: TraceEvent): string {
  return `${"  ".repeat(event.depth)}[${event.kind}] ${event.message}`;
}

function serializeReport(report: TableRollReport): unknown {
  return {
    tableUuid: report.tableUuid,
    tableName: report.tableName,
    rolledAt: report.rolledAt,
    encounterOccurred: report.outcome.encounterOccurred,
    trace: report.outcome.trace,
    original: report.outcome.creatures.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      level: c.level,
      quantity: c.quantity,
    })),
    narratives: report.outcome.narratives.map((n) => ({ kind: n.kind, text: n.text })),
    unavailable: report.outcome.unavailable,
    errors: report.outcome.errors,
  };
}
