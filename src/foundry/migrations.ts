/**
 * Schema migration runner. Runs on `ready` on the active GM's client only, is idempotent,
 * preserves unknown fields, and logs a single summary line.
 *
 * Data locations:
 *  - party profiles: world setting (array)
 *  - recipes: JournalEntry flags in the module folder
 *  - tag store: module data JournalEntry flag
 *  - table/result flags: RollTable and TableResult flags (migrated lazily on read; see table-flags.ts)
 */
import { FLAGS, MODULE_ID, SETTINGS } from "../constants.js";
import {
  SCHEMA_VERSIONS,
  validateRecipe,
  validateResultFlags,
  validateTableFlags,
  validateTagStore,
  validateThemeStore,
} from "../core/schemas.js";
import { getSetting, setSetting } from "./settings.js";

/** Bump when any persisted schema changes; add a step to MIGRATIONS below. */
export const CURRENT_DATA_VERSION = 2;

/** Module id used by the 0.1.0 pre-release; its document flags are copied forward once. */
export const LEGACY_MODULE_ID = "pf2e-encounter-builder";

/** Authors whose `pf2e-encounter-builder` manifest is ours (the 0.1.0 release listed "sargas79"). */
const LEGACY_AUTHORS = ["sargas79", "diego vescovini"];

/**
 * True when a module installed under the legacy id belongs to a different author. The id is also used
 * by an unrelated package on the Foundry registry, so its flags must never be copied forward.
 */
export function legacyModuleIsForeign(
  installed: { title?: string; authors?: Iterable<{ name?: string; github?: string }> } | null | undefined,
): boolean {
  if (!installed) return false;
  const authors = Array.from(installed.authors ?? []);
  if (authors.length === 0) return !/encounter builder/i.test(installed.title ?? "");
  return !authors.some((a) =>
    [a.name, a.github].some((v) => v && LEGACY_AUTHORS.includes(v.trim().toLowerCase())),
  );
}

/**
 * Select the journal flags worth copying from the legacy namespace: only keys we do not already hold
 * and only values that validate against our own schemas (foreign or corrupt data is left alone).
 */
export function pickLegacyJournalFlags(
  legacy: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (!legacy || typeof legacy !== "object") return update;
  const have = current ?? {};
  const consider = (key: string, valid: boolean) => {
    if (legacy[key] !== undefined && have[key] === undefined && valid)
      update[`flags.${MODULE_ID}.${key}`] = legacy[key];
  };
  consider(FLAGS.dataJournal, legacy[FLAGS.dataJournal] === true);
  consider(FLAGS.tags, validateTagStore(legacy[FLAGS.tags]).ok);
  consider(FLAGS.themes, validateThemeStore(legacy[FLAGS.themes]).ok);
  if (legacy[FLAGS.recipe] !== undefined && have[FLAGS.recipe] === undefined) {
    const recipe = migrateRecipeRecord(asRecord(legacy[FLAGS.recipe])).record;
    if (validateRecipe(recipe).ok) update[`flags.${MODULE_ID}.${FLAGS.recipe}`] = recipe;
  }
  // A data-journal marker without a usable store would create an empty, duplicate data journal.
  if (update[`flags.${MODULE_ID}.${FLAGS.dataJournal}`] && !update[`flags.${MODULE_ID}.${FLAGS.tags}`])
    delete update[`flags.${MODULE_ID}.${FLAGS.dataJournal}`];
  return update;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export type MigrationStep = {
  version: number;
  description: string;
  run: () => Promise<{ changed: number }>;
};

/* -------------------------------------------- */
/*  Pure per-record migrations (unit-tested)    */
/* -------------------------------------------- */

/** Migrate a single party profile record to the current schema. Unknown fields are preserved. */
export function migratePartyProfileRecord(raw: Record<string, unknown>): {
  record: Record<string, unknown>;
  changed: boolean;
} {
  const record = { ...raw };
  let changed = false;
  if (record.schemaVersion === undefined) {
    // Pre-versioned prototype shape: { id, name, members: string[] } -> standalone profile.
    record.schemaVersion = 1;
    record.kind = record.kind ?? "standalone";
    if (Array.isArray(record.members) && record.members.every((m) => typeof m === "string")) {
      record.members = (record.members as string[]).map((uuid) => ({ uuid, active: true }));
    }
    record.referencePolicy = record.referencePolicy ?? null;
    record.manualReferenceLevel = record.manualReferenceLevel ?? null;
    record.selectedThreat = record.selectedThreat ?? "moderate";
    changed = true;
  }
  return { record, changed };
}

/** Migrate a single recipe record to the current schema. Unknown fields are preserved. */
export function migrateRecipeRecord(raw: Record<string, unknown>): {
  record: Record<string, unknown>;
  changed: boolean;
} {
  const record = { ...raw };
  let changed = false;
  if (record.schemaVersion === undefined) {
    record.schemaVersion = 1;
    record.notes = typeof record.notes === "string" ? record.notes : "";
    record.origin = record.origin ?? "manual";
    record.evaluation = record.evaluation ?? null;
    const now = Date.now();
    record.createdAt = typeof record.createdAt === "number" ? record.createdAt : now;
    record.updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : now;
    if (Array.isArray(record.entries)) {
      record.entries = record.entries.map((e) => {
        const entry = { ...(e as Record<string, unknown>) };
        entry.locked = typeof entry.locked === "boolean" ? entry.locked : false;
        entry.level = typeof entry.level === "number" ? entry.level : 0;
        entry.name = typeof entry.name === "string" ? entry.name : "";
        return entry;
      });
    }
    changed = true;
  }
  return { record, changed };
}

/* -------------------------------------------- */
/*  Runner                                      */
/* -------------------------------------------- */

const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    description: "Stamp schemaVersion on party profiles and saved recipes",
    async run() {
      let changed = 0;
      const profiles = getSetting<unknown[]>(SETTINGS.partyProfiles) ?? [];
      const migratedProfiles = profiles.map((p) => {
        const result = migratePartyProfileRecord((p ?? {}) as Record<string, unknown>);
        if (result.changed) changed++;
        return result.record;
      });
      if (changed > 0) await setSetting(SETTINGS.partyProfiles, migratedProfiles);

      for (const journal of game.journal.contents) {
        const raw = journal.getFlag(MODULE_ID, FLAGS.recipe);
        if (!raw || typeof raw !== "object") continue;
        const result = migrateRecipeRecord(raw as Record<string, unknown>);
        if (result.changed) {
          await journal.setFlag(MODULE_ID, FLAGS.recipe, result.record);
          changed++;
        }
      }
      return { changed };
    },
  },
  {
    version: 2,
    description: "Copy document flags from the pf2e-encounter-builder namespace",
    async run() {
      if (legacyModuleIsForeign(game.modules.get(LEGACY_MODULE_ID))) {
        console.warn(
          `${MODULE_ID} | A module by another author is installed as "${LEGACY_MODULE_ID}"; its data is not migrated.`,
        );
        return { changed: 0 };
      }
      let changed = 0;
      for (const journal of game.journal.contents) {
        const update = pickLegacyJournalFlags(
          journal.flags?.[LEGACY_MODULE_ID] as Record<string, unknown> | undefined,
          journal.flags?.[MODULE_ID] as Record<string, unknown> | undefined,
        );
        if (Object.keys(update).length === 0) continue;
        await journal.update(update);
        changed++;
      }
      for (const table of game.tables.contents) {
        const legacy = table.flags?.[LEGACY_MODULE_ID] as Record<string, unknown> | undefined;
        if (legacy?.[FLAGS.table] === undefined || table.getFlag(MODULE_ID, FLAGS.table) !== undefined)
          continue;
        if (!validateTableFlags(legacy[FLAGS.table]).ok) continue;
        const results = table.results.contents
          .map((r) => ({
            _id: r.id,
            flags: (r.flags?.[LEGACY_MODULE_ID] as Record<string, unknown> | undefined)?.[FLAGS.result],
          }))
          .filter((r) => r.flags !== undefined && validateResultFlags(r.flags).ok)
          .map((r) => ({ _id: r._id, [`flags.${MODULE_ID}.${FLAGS.result}`]: r.flags }));
        await table.update({ [`flags.${MODULE_ID}.${FLAGS.table}`]: legacy[FLAGS.table] });
        if (results.length) await table.updateEmbeddedDocuments("TableResult", results);
        changed++;
      }
      return { changed };
    },
  },
];

interface MigrationGameView {
  user?: { id?: string; isGM?: boolean } | null;
  users?: { activeGM?: { id?: string; isSelf?: boolean } | null } | null;
}

/**
 * Only one client may migrate: the designated active GM (`game.users.activeGM`), so two GMs
 * connecting together do not run the same steps twice. Cores without `activeGM` fall back to
 * any GM.
 */
export function shouldRunMigrations(view: MigrationGameView): boolean {
  if (!view.user?.isGM) return false;
  const activeGM = view.users?.activeGM;
  if (activeGM == null) return true;
  return activeGM.isSelf ?? (!!activeGM.id && activeGM.id === view.user.id);
}

export async function runMigrations(): Promise<void> {
  if (!shouldRunMigrations(game as unknown as MigrationGameView)) return;
  const stored = Number(getSetting<number>(SETTINGS.dataSchemaVersion) ?? 0);
  if (stored >= CURRENT_DATA_VERSION) return;

  let totalChanged = 0;
  const applied: number[] = [];
  for (const step of MIGRATIONS.filter((m) => m.version > stored).sort((a, b) => a.version - b.version)) {
    try {
      const { changed } = await step.run();
      totalChanged += changed;
      applied.push(step.version);
      await setSetting(SETTINGS.dataSchemaVersion, step.version);
    } catch (error) {
      console.error(`${MODULE_ID} | Migration ${step.version} failed (${step.description})`, error);
      ui.notifications.error(game.i18n.format(`${MODULE_ID}.migrations.failed`, { version: step.version }));
      return;
    }
  }
  console.info(
    `${MODULE_ID} | Migrations applied: ${applied.join(", ") || "none"}; records changed: ${totalChanged}; schema versions: ${JSON.stringify(SCHEMA_VERSIONS)}`,
  );
}
