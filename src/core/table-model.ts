/**
 * Pure encounter-table model: rows, validation, and resolution with a trace.
 *
 * The Foundry layer (src/foundry/table-flags.ts, table-resolver.ts) maps RollTable/TableResult
 * documents to/from `TableModel`, and supplies dice rolls and document lookups through `TableLookup`.
 */
import { isFixedQuantity, validateFormula } from "./dice-grammar.js";
import type {
  CreatureGroupEntry,
  GenerationTemplate,
  NarrativeKind,
  ResultFlags,
  ResultKind,
  TableFlags,
  TableMode,
} from "./schemas.js";

export interface TableRow {
  /** TableResult id. */
  id: string;
  /** Native text/description (read-only for rows without module flags). */
  text: string;
  /** Native document reference (for native document rows). */
  documentUuid: string | null;
  range: [number, number];
  weight: number;
  drawn: boolean;
  /** Module metadata; null for native rows that were never configured. */
  flags: ResultFlags | null;
}

export interface TableModel {
  uuid: string;
  name: string;
  formula: string;
  replacement: boolean;
  mode: TableMode;
  flags: TableFlags;
  rows: TableRow[];
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

export interface TableIssue {
  level: "error" | "warning";
  code:
    | "formulaInvalid"
    | "rangeInvalid"
    | "rangeOverlap"
    | "rangeGap"
    | "rangeOutside"
    | "weightZero"
    | "quantityInvalid"
    | "creatureMissing"
    | "tableMissing"
    | "selfReference"
    | "cycle"
    | "templateEmpty"
    | "checkInvalid"
    | "noCreatures";
  rowId?: string;
  data?: Record<string, unknown>;
}

export interface ValidationContext {
  /** Returns true when the referenced document is known to exist (null = unknown, skip the check). */
  exists?: (uuid: string) => boolean | null;
  /** Returns the model for a referenced table, for cycle detection; null when unknown. */
  getTable?: (uuid: string) => TableModel | null;
}

export function validateTable(model: TableModel, context: ValidationContext = {}): TableIssue[] {
  const issues: TableIssue[] = [];
  const formula = validateFormula(model.formula);
  if (!formula.ok)
    issues.push({
      level: "error",
      code: "formulaInvalid",
      data: { formula: model.formula, error: formula.error },
    });

  if (model.flags.encounterCheck) {
    const check = validateFormula(model.flags.encounterCheck.formula);
    if (!check.ok || model.flags.encounterCheck.occursOn.length === 0) {
      issues.push({
        level: "error",
        code: "checkInvalid",
        data: { formula: model.flags.encounterCheck.formula },
      });
    }
  }

  // Ranges.
  const rows = [...model.rows].sort((a, b) => a.range[0] - b.range[0]);
  for (const row of rows) {
    const [lo, hi] = row.range;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi)
      issues.push({ level: "error", code: "rangeInvalid", rowId: row.id, data: { range: row.range } });
    // Weights are floored when ranges are derived (see rangesFromWeights), so 0 < weight < 1 is
    // just as unreachable as 0.
    if (model.mode === "weight" && !(Math.floor(row.weight) >= 1))
      issues.push({ level: "warning", code: "weightZero", rowId: row.id, data: { weight: row.weight } });
  }
  let maxEnd = -Infinity;
  if (model.mode === "range" && formula.ok) {
    // Rows are sorted by start; compare each against the furthest end seen so far, so a wide row
    // that covers several later rows is detected as overlapping all of them.
    let maxEndId: string | null = null;
    for (const cur of rows) {
      if (maxEndId !== null) {
        if (cur.range[0] <= maxEnd)
          issues.push({ level: "error", code: "rangeOverlap", rowId: cur.id, data: { with: maxEndId } });
        else if (cur.range[0] > maxEnd + 1)
          issues.push({
            level: "warning",
            code: "rangeGap",
            rowId: cur.id,
            data: { from: maxEnd + 1, to: cur.range[0] - 1 },
          });
      }
      if (maxEndId === null || cur.range[1] > maxEnd) {
        maxEnd = cur.range[1];
        maxEndId = cur.id;
      }
    }
    for (const row of rows) {
      if (row.range[0] < formula.min! || row.range[1] > formula.max!)
        issues.push({
          level: "warning",
          code: "rangeOutside",
          rowId: row.id,
          data: { min: formula.min, max: formula.max },
        });
    }
    if (rows.length > 0 && rows[0]!.range[0] > formula.min!)
      issues.push({
        level: "warning",
        code: "rangeGap",
        data: { from: formula.min, to: rows[0]!.range[0] - 1 },
      });
    if (rows.length > 0 && maxEnd < formula.max!)
      issues.push({
        level: "warning",
        code: "rangeGap",
        data: { from: maxEnd + 1, to: formula.max },
      });
  }

  // Row content.
  for (const row of model.rows) {
    const flags = row.flags;
    if (!flags) continue;
    switch (flags.kind) {
      case "creatures":
        if (flags.creatures.length === 0) issues.push({ level: "error", code: "noCreatures", rowId: row.id });
        for (const c of flags.creatures) {
          const q = validateFormula(c.quantity);
          if (!q.ok || q.min! < 0)
            issues.push({
              level: "error",
              code: "quantityInvalid",
              rowId: row.id,
              data: { quantity: c.quantity, uuid: c.uuid },
            });
          if (context.exists && context.exists(c.uuid) === false)
            issues.push({ level: "error", code: "creatureMissing", rowId: row.id, data: { uuid: c.uuid } });
        }
        break;
      case "table":
        if (!flags.tableUuid) issues.push({ level: "error", code: "tableMissing", rowId: row.id });
        else if (flags.tableUuid === model.uuid)
          issues.push({ level: "error", code: "selfReference", rowId: row.id });
        else if (context.exists && context.exists(flags.tableUuid) === false)
          issues.push({
            level: "error",
            code: "tableMissing",
            rowId: row.id,
            data: { uuid: flags.tableUuid },
          });
        else if (
          context.getTable &&
          reachesTable(flags.tableUuid, model.uuid, context.getTable, new Set([model.uuid]))
        ) {
          issues.push({ level: "error", code: "cycle", rowId: row.id, data: { uuid: flags.tableUuid } });
        }
        break;
      case "template":
        if (
          !flags.template ||
          (flags.template.candidates.length === 0 && flags.template.traits.length === 0)
        ) {
          issues.push({ level: "warning", code: "templateEmpty", rowId: row.id });
        }
        break;
      default:
        break;
    }
  }
  return issues;
}

function reachesTable(
  fromUuid: string,
  targetUuid: string,
  getTable: (uuid: string) => TableModel | null,
  visited: Set<string>,
): boolean {
  if (fromUuid === targetUuid) return true;
  if (visited.has(fromUuid)) return false;
  visited.add(fromUuid);
  const table = getTable(fromUuid);
  if (!table) return false;
  for (const row of table.rows) {
    if (
      row.flags?.kind === "table" &&
      row.flags.tableUuid &&
      reachesTable(row.flags.tableUuid, targetUuid, getTable, visited)
    )
      return true;
  }
  return false;
}

/* -------------------------------------------- */
/*  Weight mode: derive ranges from weights     */
/* -------------------------------------------- */

/** Assign consecutive ranges proportional to weights over 1..total weight. Only for weight mode. */
export function rangesFromWeights(
  rows: TableRow[],
): { id: string; range: [number, number]; formula: string }[] {
  let cursor = 1;
  const out: { id: string; range: [number, number]; formula: string }[] = [];
  for (const row of rows) {
    const w = Math.max(0, Math.floor(row.weight));
    if (w === 0) {
      // Valid for Foundry's schema (ascending) and never rolled: table totals start at 1.
      out.push({ id: row.id, range: [0, 0], formula: "" });
      continue;
    }
    out.push({ id: row.id, range: [cursor, cursor + w - 1], formula: "" });
    cursor += w;
  }
  const total = Math.max(1, cursor - 1);
  return out.map((o) => ({ ...o, formula: `1d${total}` }));
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

export interface ResolveLimits {
  maxDepth: number;
  maxQuantityPerEntry: number;
  maxTotalCreatures: number;
}

export interface CreatureRef {
  uuid: string;
  name: string;
  level: number | null;
  img?: string | null;
  traits?: string[];
  packLabel?: string | null;
}

/** Port the pure resolver needs. All document access and dice go through here. */
export interface TableLookup {
  getTable(uuid: string): Promise<TableModel | null>;
  /** Roll the table's formula (or the module's derived formula in weight mode). Must not post chat or mutate. */
  rollFormula(
    formula: string,
    purpose: "table" | "quantity" | "check",
  ): Promise<{ total: number; detail: string }>;
  resolveCreature(uuid: string): Promise<CreatureRef | null>;
}

export interface TraceEvent {
  depth: number;
  kind:
    | "encounterCheck"
    | "tableRoll"
    | "match"
    | "noMatch"
    | "quantityRoll"
    | "creature"
    | "creatureMissing"
    | "narrative"
    | "none"
    | "template"
    | "nested"
    | "tableMissing"
    | "limit"
    | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface ResolvedCreature {
  uuid: string;
  name: string;
  level: number | null;
  quantity: number;
  img: string | null;
  traits: string[];
  packLabel: string | null;
  /** Row the creature came from (for diagnostics). */
  rowId: string;
  tableUuid: string;
}

export interface ResolvedNarrative {
  kind: NarrativeKind | "native";
  text: string;
  notes: string;
  journalUuid: string | null;
  tableUuid: string;
  rowId: string;
}

export interface TableOutcome {
  /** False when the encounter check said "no encounter". */
  encounterOccurred: boolean;
  creatures: ResolvedCreature[];
  narratives: ResolvedNarrative[];
  /** Templates encountered (party-scaled generation handled by the caller). */
  templates: { template: GenerationTemplate; rowId: string; tableUuid: string; text: string }[];
  /** Creatures whose sources could not be resolved; never silently dropped. */
  unavailable: { uuid: string; quantity: string; rowId: string; tableUuid: string }[];
  notes: string[];
  trace: TraceEvent[];
  errors: string[];
  stoppedByLimit: boolean;
}

export async function resolveTable(
  rootUuid: string,
  lookup: TableLookup,
  limits: ResolveLimits,
): Promise<TableOutcome> {
  const outcome: TableOutcome = {
    encounterOccurred: true,
    creatures: [],
    narratives: [],
    templates: [],
    unavailable: [],
    notes: [],
    trace: [],
    errors: [],
    stoppedByLimit: false,
  };
  const trace = (event: TraceEvent) => outcome.trace.push(event);
  let totalCreatures = 0;

  const root = await lookup.getTable(rootUuid);
  if (!root) {
    trace({ depth: 0, kind: "tableMissing", message: `table ${rootUuid} not found` });
    outcome.errors.push(`table ${rootUuid} not found`);
    return outcome;
  }

  // Encounter check (root only).
  if (root.flags.encounterCheck) {
    const { formula, occursOn } = root.flags.encounterCheck;
    const check = validateFormula(formula);
    if (!check.ok) {
      trace({ depth: 0, kind: "error", message: `invalid encounter check formula "${formula}"` });
      outcome.errors.push(`invalid encounter check formula "${formula}"`);
      return outcome;
    }
    const roll = await lookup.rollFormula(formula, "check");
    const occurred = occursOn.includes(roll.total);
    trace({
      depth: 0,
      kind: "encounterCheck",
      message: `${formula} = ${roll.total} → ${occurred ? "encounter" : "no encounter"}`,
      data: { total: roll.total, occursOn },
    });
    if (!occurred) {
      outcome.encounterOccurred = false;
      return outcome;
    }
  }

  const visit = async (table: TableModel, depth: number, path: string[]): Promise<void> => {
    if (depth > limits.maxDepth) {
      trace({ depth, kind: "limit", message: `nesting depth ${depth} exceeds ${limits.maxDepth}` });
      outcome.errors.push(`nesting depth limit (${limits.maxDepth}) exceeded at ${table.name}`);
      outcome.stoppedByLimit = true;
      return;
    }
    const formula = table.mode === "weight" ? weightFormula(table) : table.formula;
    const check = validateFormula(formula);
    if (!check.ok) {
      trace({ depth, kind: "error", message: `invalid table formula "${formula}" on ${table.name}` });
      outcome.errors.push(`invalid table formula "${formula}" on ${table.name}`);
      return;
    }
    const roll = await lookup.rollFormula(formula, "table");
    trace({
      depth,
      kind: "tableRoll",
      message: `${table.name}: ${formula} = ${roll.total}`,
      data: { tableUuid: table.uuid, total: roll.total, detail: roll.detail },
    });
    const rows = table.mode === "weight" ? applyWeightRanges(table) : table.rows;
    const matched = rows.filter((r) => roll.total >= r.range[0] && roll.total <= r.range[1]);
    if (matched.length === 0) {
      trace({ depth, kind: "noMatch", message: `no row matches ${roll.total} on ${table.name}` });
      outcome.errors.push(`no row matches ${roll.total} on ${table.name}`);
      return;
    }
    for (const row of matched) {
      trace({
        depth,
        kind: "match",
        message: `matched row ${row.range[0]}–${row.range[1]}: ${summarizeRow(row)}`,
        data: { rowId: row.id },
      });
      await resolveRow(table, row, depth, path);
      if (outcome.stoppedByLimit) return;
    }
  };

  const resolveRow = async (
    table: TableModel,
    row: TableRow,
    depth: number,
    path: string[],
  ): Promise<void> => {
    const flags = row.flags;
    if (!flags) {
      // Native row: text is narrative; a document reference to a RollTable nests, to an Actor adds one creature.
      if (row.documentUuid?.includes(".RollTable.") || row.documentUuid?.startsWith("RollTable.")) {
        await nest(row.documentUuid, table, row, depth, path);
      } else if (row.documentUuid?.includes("Actor.")) {
        await addCreature({ uuid: row.documentUuid, quantity: "1" }, table, row, depth);
      } else {
        outcome.narratives.push({
          kind: "native",
          text: row.text,
          notes: "",
          journalUuid: null,
          tableUuid: table.uuid,
          rowId: row.id,
        });
        trace({ depth, kind: "narrative", message: `native text: ${row.text.slice(0, 80)}` });
      }
      return;
    }
    if (flags.notes) outcome.notes.push(flags.notes);
    switch (flags.kind) {
      case "none":
        trace({ depth, kind: "none", message: "no encounter" });
        outcome.narratives.push({
          kind: "other",
          text: row.text,
          notes: flags.notes,
          journalUuid: flags.journalUuid,
          tableUuid: table.uuid,
          rowId: row.id,
        });
        break;
      case "narrative":
        trace({
          depth,
          kind: "narrative",
          message: `${flags.narrativeKind ?? "other"}: ${row.text.slice(0, 80)}`,
        });
        outcome.narratives.push({
          kind: flags.narrativeKind ?? "other",
          text: row.text,
          notes: flags.notes,
          journalUuid: flags.journalUuid,
          tableUuid: table.uuid,
          rowId: row.id,
        });
        break;
      case "creatures":
        for (const group of flags.creatures) {
          await addCreature(group, table, row, depth);
          if (outcome.stoppedByLimit) return;
        }
        break;
      case "table":
        if (!flags.tableUuid) {
          trace({ depth, kind: "tableMissing", message: "row references no table" });
          outcome.errors.push(`row ${row.id} on ${table.name} references no table`);
        } else await nest(flags.tableUuid, table, row, depth, path);
        break;
      case "template":
        if (flags.template) {
          trace({
            depth,
            kind: "template",
            message: `party-scaled template (${flags.template.candidates.length} candidates)`,
          });
          outcome.templates.push({
            template: flags.template,
            rowId: row.id,
            tableUuid: table.uuid,
            text: row.text,
          });
        } else {
          trace({ depth, kind: "error", message: "template row without template" });
          outcome.errors.push(`template row ${row.id} on ${table.name} has no template configured`);
        }
        break;
    }
  };

  const nest = async (
    uuid: string,
    parent: TableModel,
    row: TableRow,
    depth: number,
    path: string[],
  ): Promise<void> => {
    if (path.includes(uuid)) {
      trace({ depth, kind: "limit", message: `cycle detected: ${[...path, uuid].join(" → ")}` });
      outcome.errors.push(`cycle detected through ${uuid}`);
      outcome.stoppedByLimit = true;
      return;
    }
    const child = await lookup.getTable(uuid);
    if (!child) {
      trace({ depth, kind: "tableMissing", message: `nested table ${uuid} not found` });
      outcome.errors.push(`nested table ${uuid} (from ${parent.name}, row ${row.id}) not found`);
      return;
    }
    trace({ depth, kind: "nested", message: `→ ${child.name}`, data: { tableUuid: uuid } });
    await visit(child, depth + 1, [...path, uuid]);
  };

  const addCreature = async (
    group: CreatureGroupEntry,
    table: TableModel,
    row: TableRow,
    depth: number,
  ): Promise<void> => {
    let quantity: number;
    if (isFixedQuantity(group.quantity)) quantity = Number.parseInt(group.quantity, 10);
    else {
      const q = validateFormula(group.quantity);
      if (!q.ok) {
        trace({ depth, kind: "error", message: `invalid quantity "${group.quantity}" for ${group.uuid}` });
        outcome.errors.push(`invalid quantity "${group.quantity}" on ${table.name}`);
        outcome.unavailable.push({
          uuid: group.uuid,
          quantity: group.quantity,
          rowId: row.id,
          tableUuid: table.uuid,
        });
        return;
      }
      const roll = await lookup.rollFormula(group.quantity, "quantity");
      quantity = roll.total;
      trace({
        depth,
        kind: "quantityRoll",
        message: `${group.quantity} = ${roll.total}`,
        data: { uuid: group.uuid, total: roll.total, detail: roll.detail },
      });
    }
    if (quantity > limits.maxQuantityPerEntry) {
      trace({
        depth,
        kind: "limit",
        message: `quantity ${quantity} exceeds ${limits.maxQuantityPerEntry} per entry`,
      });
      outcome.errors.push(`quantity ${quantity} exceeds the per-entry limit (${limits.maxQuantityPerEntry})`);
      outcome.stoppedByLimit = true;
      return;
    }
    if (quantity <= 0) {
      trace({ depth, kind: "creature", message: `${group.uuid} × 0 (skipped)` });
      return;
    }
    if (totalCreatures + quantity > limits.maxTotalCreatures) {
      trace({ depth, kind: "limit", message: `total creatures would exceed ${limits.maxTotalCreatures}` });
      outcome.errors.push(`total creatures exceed the limit (${limits.maxTotalCreatures})`);
      outcome.stoppedByLimit = true;
      return;
    }
    const ref = await lookup.resolveCreature(group.uuid);
    if (!ref) {
      trace({ depth, kind: "creatureMissing", message: `${group.uuid} × ${quantity}: source unavailable` });
      outcome.unavailable.push({
        uuid: group.uuid,
        quantity: String(quantity),
        rowId: row.id,
        tableUuid: table.uuid,
      });
      return;
    }
    totalCreatures += quantity;
    trace({ depth, kind: "creature", message: `${ref.name} × ${quantity}` });
    const existing = outcome.creatures.find((c) => c.uuid === ref.uuid);
    if (existing) existing.quantity += quantity;
    else
      outcome.creatures.push({
        uuid: ref.uuid,
        name: ref.name,
        level: ref.level,
        quantity,
        img: ref.img ?? null,
        traits: ref.traits ?? [],
        packLabel: ref.packLabel ?? null,
        rowId: row.id,
        tableUuid: table.uuid,
      });
  };

  await visit(root, 0, [rootUuid]);
  return outcome;
}

function weightFormula(table: TableModel): string {
  const total = table.rows.reduce((s, r) => s + Math.max(0, Math.floor(r.weight)), 0);
  return `1d${Math.max(1, total)}`;
}

function applyWeightRanges(table: TableModel): TableRow[] {
  const derived = rangesFromWeights(table.rows);
  return table.rows.map((row, i) => ({ ...row, range: derived[i]!.range }));
}

export function summarizeRow(row: TableRow): string {
  const flags = row.flags;
  if (!flags) return row.documentUuid ? `@${row.documentUuid}` : row.text.slice(0, 60);
  switch (flags.kind) {
    case "creatures":
      return flags.creatures.map((c) => `${c.quantity} × ${c.uuid.split(".").pop()}`).join(", ");
    case "table":
      return `table ${flags.tableUuid ?? "?"}`;
    case "narrative":
      return `${flags.narrativeKind ?? "narrative"}: ${row.text.slice(0, 60)}`;
    case "none":
      return "no encounter";
    case "template":
      return "party-scaled template";
  }
}

/** Plain-text summary written into the native result text so native draws stay readable. */
export function nativeTextForRow(
  flags: ResultFlags,
  names: (uuid: string) => string | null,
  originalText = "",
): string {
  switch (flags.kind) {
    case "creatures": {
      const parts = flags.creatures.map((c) => `${c.quantity} × ${names(c.uuid) ?? c.uuid}`);
      return [parts.join(", "), flags.notes].filter(Boolean).join(" — ");
    }
    case "table":
      return [`Roll on ${names(flags.tableUuid ?? "") ?? flags.tableUuid ?? "another table"}`, flags.notes]
        .filter(Boolean)
        .join(" — ");
    case "none":
      return originalText || "No encounter";
    case "template":
      return [originalText || "Party-scaled encounter", flags.notes].filter(Boolean).join(" — ");
    case "narrative":
      return originalText || flags.notes || "Narrative result";
  }
}

export const RESULT_KINDS: ResultKind[] = ["creatures", "table", "narrative", "none", "template"];
export const NARRATIVE_KINDS: NarrativeKind[] = ["tracks", "travelers", "discovery", "weather", "other"];
