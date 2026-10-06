/**
 * Map native RollTable / TableResult documents to and from the pure TableModel.
 * Saving is non-destructive: only module flags, ranges/weights and the native text of rows the GM
 * edited are written. Rows without module flags are left exactly as they were.
 */
import { FLAGS, MODULE_ID } from "../constants.js";
import {
  emptyTableFlags,
  validateResultFlags,
  validateTableFlags,
  type ResultFlags,
  type TableFlags,
} from "../core/schemas.js";
import { nativeTextForRow, type TableModel, type TableRow } from "../core/table-model.js";
import { documentClass } from "./compat.js";

export function readTableFlags(table: RollTableDocument): TableFlags {
  const raw = table.getFlag(MODULE_ID, FLAGS.table);
  if (!raw) return emptyTableFlags();
  const v = validateTableFlags(raw);
  if (v.ok) return v.value;
  console.warn(`${MODULE_ID} | invalid table flags on ${table.name}; using defaults`, v.errors);
  return emptyTableFlags();
}

export function readResultFlags(result: TableResultDocument): ResultFlags | null {
  const raw = result.getFlag(MODULE_ID, FLAGS.result);
  if (!raw) return null;
  const v = validateResultFlags(raw);
  if (v.ok) return v.value;
  console.warn(`${MODULE_ID} | invalid result flags on ${result.id}; treating as native`, v.errors);
  return null;
}

export function tableToModel(table: RollTableDocument): TableModel {
  const rows: TableRow[] = table.results.contents.map((r) => ({
    id: r.id,
    text: stripHtml(r.description ?? r.name ?? ""),
    documentUuid: r.type === "document" ? (r.documentUuid ?? null) : null,
    range: [Number(r.range?.[0] ?? 0), Number(r.range?.[1] ?? 0)],
    weight: Number(r.weight ?? 1),
    drawn: !!r.drawn,
    flags: readResultFlags(r),
  }));
  rows.sort((a, b) => a.range[0] - b.range[0]);
  const flags = readTableFlags(table);
  return {
    uuid: table.uuid,
    name: table.name,
    formula: table.formula || "1d20",
    replacement: !!table.replacement,
    mode: flags.mode,
    flags,
    rows,
  };
}

export interface RowEdit {
  /** Existing result id, or null for a new row. */
  id: string | null;
  range: [number, number];
  weight: number;
  text: string;
  flags: ResultFlags;
}

export interface TableSave {
  formula: string;
  flags: TableFlags;
  rows: RowEdit[];
  /** Result ids to delete. */
  deleteIds: string[];
  /** Native (unconfigured) rows: only their range/weight is written, e.g. after "Derive ranges". */
  nativeRanges?: { id: string; range: [number, number]; weight: number }[];
}

/** Persist edits. Rows the GM did not touch are not rewritten. */
export async function saveTable(
  table: RollTableDocument,
  save: TableSave,
  names: (uuid: string) => string | null,
): Promise<void> {
  if (!game.user.isGM) throw new Error("GM only");
  const updates: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  for (const row of save.rows) {
    const text =
      row.flags.kind === "narrative" || row.flags.kind === "none"
        ? row.text
        : nativeTextForRow(row.flags, names, row.text);
    const data = {
      type: "text",
      description: text,
      name: text.slice(0, 80),
      range: row.range,
      weight: Math.max(0, Math.floor(row.weight)),
      flags: { [MODULE_ID]: { [FLAGS.result]: row.flags } },
    };
    if (row.id) {
      const existing = table.results.get(row.id);
      if (!existing) continue;
      if (!rowChanged(existing, data, row.flags)) continue;
      updates.push({ _id: row.id, ...data });
    } else creates.push(data);
  }
  for (const row of save.nativeRanges ?? []) {
    const existing = table.results.get(row.id);
    if (!existing) continue;
    const weight = Math.max(0, Math.floor(row.weight));
    if (
      existing.range[0] === row.range[0] &&
      existing.range[1] === row.range[1] &&
      existing.weight === weight
    )
      continue;
    updates.push({ _id: row.id, range: row.range, weight });
  }
  if (save.deleteIds.length) await table.deleteEmbeddedDocuments("TableResult", save.deleteIds);
  if (updates.length) await table.updateEmbeddedDocuments("TableResult", updates);
  if (creates.length) await table.createEmbeddedDocuments("TableResult", creates);
  const tableUpdate: Record<string, unknown> = {};
  if (table.formula !== save.formula) tableUpdate.formula = save.formula;
  const currentFlags = JSON.stringify(table.getFlag(MODULE_ID, FLAGS.table) ?? null);
  if (currentFlags !== JSON.stringify(save.flags))
    tableUpdate[`flags.${MODULE_ID}.${FLAGS.table}`] = save.flags;
  if (Object.keys(tableUpdate).length) await table.update(tableUpdate);
}

function rowChanged(
  existing: TableResultDocument,
  data: Record<string, unknown>,
  flags: ResultFlags,
): boolean {
  const currentFlags = JSON.stringify(existing.getFlag(MODULE_ID, FLAGS.result) ?? null);
  return (
    currentFlags !== JSON.stringify(flags) ||
    existing.description !== data.description ||
    existing.range[0] !== (data.range as [number, number])[0] ||
    existing.range[1] !== (data.range as [number, number])[1] ||
    existing.weight !== data.weight
  );
}

export async function createEncounterTable(name: string, formula = "1d100"): Promise<RollTableDocument> {
  if (!game.user.isGM) throw new Error("GM only");
  return documentClass("RollTable").create({
    name,
    formula,
    replacement: true,
    displayRoll: true,
    flags: { [MODULE_ID]: { [FLAGS.table]: emptyTableFlags() } },
  });
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
