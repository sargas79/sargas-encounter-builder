/**
 * Versioned data schemas for everything the module persists, plus boundary validators.
 *
 * Bump a schema version whenever a persisted shape changes, and add a migration in
 * ../foundry/migrations.ts. Validators are deliberately tolerant of unknown extra fields
 * (they are preserved on write) and strict about the fields the module reads.
 */
import type { ThreatLevel } from "../rules/encounter-tables.js";
import type { ReferenceLevelPolicy } from "./budget.js";

export const SCHEMA_VERSIONS = {
  partyProfile: 1,
  recipe: 1,
  tableFlags: 1,
  resultFlags: 1,
  tagStore: 1,
} as const;

/* -------------------------------------------- */
/*  Party profiles (world setting)              */
/* -------------------------------------------- */

export interface PartyMemberOverride {
  uuid: string;
  /** false = present in roster but not participating */
  active: boolean;
  /** GM override: count an NPC ally as a party member */
  countsAsMember?: boolean;
}

export interface PartyProfileV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  /** Linked profiles read members from a PF2e Party actor; standalone profiles list actors directly. */
  kind: "linked" | "standalone";
  /** UUID of the PF2e Party actor when kind === "linked". */
  partyActorUuid?: string;
  /** Standalone: full member list. Linked: overrides for members of the Party actor. */
  members: PartyMemberOverride[];
  referencePolicy: ReferenceLevelPolicy | null;
  manualReferenceLevel: number | null;
  selectedThreat: ThreatLevel;
}

export type PartyProfile = PartyProfileV1;

/* -------------------------------------------- */
/*  Saved encounter recipes (JournalEntry flag) */
/* -------------------------------------------- */

export interface RecipeEntry {
  uuid: string;
  /** Name at save time, for display when the source is missing. */
  name: string;
  /** Level at save time, for display when the source is missing. */
  level: number;
  quantity: number;
  locked: boolean;
}

export interface EvaluationSnapshot {
  timestamp: number;
  partyProfileId: string | null;
  partyName: string;
  memberLevels: { uuid: string; name: string; level: number }[];
  partySize: number;
  referenceLevel: number;
  referencePolicy: ReferenceLevelPolicy | null;
  selectedThreat: ThreatLevel | null;
  target: number | null;
  supportedXP: number;
  complete: boolean;
  inferredLabel: string;
  difference: number | null;
}

export interface RecipeV1 {
  schemaVersion: 1;
  name: string;
  notes: string;
  entries: RecipeEntry[];
  /** How this encounter was produced. */
  origin: "manual" | "generated" | "table" | "variant";
  generation?: {
    seed: string | null;
    inputs: Record<string, unknown>;
  };
  policy?: "classic" | "partyScaled";
  /** Table resolution trace, when origin is "table" or "variant". */
  trace?: unknown;
  /** Original outcome for a balanced variant, with the diff that produced the saved entries. */
  variantOf?: {
    original: RecipeEntry[];
    diff: VariantDiffEntry[];
  };
  evaluation: EvaluationSnapshot | null;
  /** Treasure rolled for this encounter (optional; validated loosely, restored best-effort). */
  treasure?: TreasureRecordV1;
  createdAt: number;
  updatedAt: number;
}

export interface TreasureRecordV1 {
  seed: string | null;
  share: number;
  /** GM-chosen treasure level; absent or null means the party's reference level. */
  level?: number | null;
  /** Award mode at save time; absent means "custom" with the saved share. */
  mode?: "encounter" | "level" | "custom";
  options: {
    allowUncommon: boolean;
    allowRare: boolean;
    includeConsumables: boolean;
    valuablesShare: number;
    preferTraits: string[];
    excludeCategories: string[];
  };
  entries: {
    uuid: string;
    name: string;
    level: number;
    price: number;
    kind: "permanent" | "consumable" | "valuable";
    slotLevel: number;
    locked: boolean;
  }[];
  coins: { pp: number; gp: number; sp: number; cp: number };
}

export interface VariantDiffEntry {
  uuid: string;
  name: string;
  change: "added" | "removed" | "quantityChanged";
  from: number;
  to: number;
}

export type Recipe = RecipeV1;

/* -------------------------------------------- */
/*  Encounter table flags                       */
/* -------------------------------------------- */

export type TableMode = "range" | "weight";

export interface TableFlagsV1 {
  schemaVersion: 1;
  /** Whether ranges are authored explicitly or derived from weights. */
  mode: TableMode;
  /** Optional encounter check, e.g. "1d6" with trigger values [1]. */
  encounterCheck: { formula: string; occursOn: number[] } | null;
  tags: { region: string[]; terrain: string[]; season: string[]; timeOfDay: string[] };
  notes: string;
}

export type ResultKind = "creatures" | "table" | "narrative" | "none" | "template";
export type NarrativeKind = "tracks" | "travelers" | "discovery" | "weather" | "other";

export interface CreatureGroupEntry {
  uuid: string;
  /** Fixed count or a pure dice formula (see dice-grammar.ts). */
  quantity: string;
}

export interface GenerationTemplate {
  /** Explicit candidate UUIDs, and/or filters applied to the selected packs. */
  candidates: string[];
  traits: string[];
  levelMin: number | null;
  levelMax: number | null;
  composition: CompositionPreference;
  threat: ThreatLevel | null;
}

export type CompositionPreference =
  "unrestricted" | "solo" | "pair" | "group" | "bossWithSupport" | "warband" | "mixedPatrol";
export const COMPOSITION_PREFERENCES: readonly CompositionPreference[] = [
  "unrestricted",
  "solo",
  "pair",
  "group",
  "bossWithSupport",
  "warband",
  "mixedPatrol",
];

export interface ResultFlagsV1 {
  schemaVersion: 1;
  kind: ResultKind;
  creatures: CreatureGroupEntry[];
  tableUuid: string | null;
  narrativeKind: NarrativeKind | null;
  template: GenerationTemplate | null;
  notes: string;
  journalUuid: string | null;
}

export type TableFlags = TableFlagsV1;
export type ResultFlags = ResultFlagsV1;

/* -------------------------------------------- */
/*  Custom tags (module data JournalEntry flag) */
/* -------------------------------------------- */

export interface TagStoreV1 {
  schemaVersion: 1;
  /**
   * Entries of source UUID -> tags such as "family:goblinoid" or "environment:forest".
   * Stored as an array because UUIDs contain dots, which Foundry expands as nested paths in object keys.
   */
  entries: { uuid: string; tags: string[] }[];
}

export type TagStore = TagStoreV1;

/* -------------------------------------------- */
/*  Validators                                  */
/* -------------------------------------------- */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
/** Keep only the string elements of an array; anything that is not an array becomes []. */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);
const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const THREATS: readonly string[] = ["trivial", "low", "moderate", "severe", "extreme"];
const POLICIES: readonly string[] = ["uniform", "averageFloor", "highest", "lowest", "manual"];
const RESULT_KINDS: readonly string[] = ["creatures", "table", "narrative", "none", "template"];
const COMPOSITIONS: readonly string[] = COMPOSITION_PREFERENCES;
const NARRATIVE: readonly string[] = ["tracks", "travelers", "discovery", "weather", "other"];

export function validatePartyProfile(raw: unknown): ValidationResult<PartyProfile> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (!isString(raw.id) || !raw.id) errors.push("id missing");
  if (!isString(raw.name)) errors.push("name missing");
  if (raw.kind !== "linked" && raw.kind !== "standalone") errors.push("kind invalid");
  if (raw.kind === "linked" && !isString(raw.partyActorUuid))
    errors.push("partyActorUuid missing for linked profile");
  if (!Array.isArray(raw.members)) errors.push("members not an array");
  else {
    raw.members.forEach((m, i) => {
      if (!isObject(m) || !isString(m.uuid) || !isBool(m.active)) errors.push(`members[${i}] invalid`);
    });
  }
  if (raw.referencePolicy !== null && !POLICIES.includes(raw.referencePolicy as string))
    errors.push("referencePolicy invalid");
  if (raw.manualReferenceLevel !== null && !isInt(raw.manualReferenceLevel))
    errors.push("manualReferenceLevel invalid");
  if (!THREATS.includes(raw.selectedThreat as string)) errors.push("selectedThreat invalid");
  return errors.length ? { ok: false, errors } : { ok: true, value: raw as unknown as PartyProfile };
}

export function validateRecipe(raw: unknown): ValidationResult<Recipe> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (!isString(raw.name)) errors.push("name missing");
  if (!isString(raw.notes)) errors.push("notes missing");
  if (!Array.isArray(raw.entries)) errors.push("entries not an array");
  else {
    raw.entries.forEach((e, i) => {
      if (
        !isObject(e) ||
        !isString(e.uuid) ||
        !isInt(e.quantity) ||
        e.quantity < 0 ||
        !isBool(e.locked) ||
        !isInt(e.level)
      ) {
        errors.push(`entries[${i}] invalid`);
      }
    });
  }
  if (!["manual", "generated", "table", "variant"].includes(raw.origin as string))
    errors.push("origin invalid");
  if (raw.evaluation !== null && !isObject(raw.evaluation)) errors.push("evaluation invalid");
  if (!isInt(raw.createdAt) || !isInt(raw.updatedAt)) errors.push("timestamps invalid");
  if (errors.length) return { ok: false, errors };
  // Display names are best-effort: a missing one falls back to the uuid.
  const entries = (raw.entries as Record<string, unknown>[]).map((e) =>
    isString(e.name) ? e : { ...e, name: e.uuid as string },
  );
  const value: Record<string, unknown> = { ...raw, entries };
  // Treasure is an optional extra: a damaged record is dropped, never the whole encounter.
  if (raw.treasure !== undefined && !isValidTreasureRecord(raw.treasure)) {
    const { treasure: _dropped, ...rest } = value;
    return { ok: true, value: rest as unknown as Recipe };
  }
  return { ok: true, value: value as unknown as Recipe };
}

export function isValidTreasureRecord(raw: unknown): raw is TreasureRecordV1 {
  if (!isObject(raw)) return false;
  if (raw.seed !== null && !isString(raw.seed)) return false;
  if (typeof raw.share !== "number" || !Number.isFinite(raw.share)) return false;
  if (raw.level !== undefined && raw.level !== null && !isInt(raw.level)) return false;
  if (raw.mode !== undefined && !["encounter", "level", "custom"].includes(raw.mode as string)) return false;
  if (!isObject(raw.options) || !Array.isArray(raw.entries) || !isObject(raw.coins)) return false;
  const o = raw.options;
  const stringArray = (v: unknown) => Array.isArray(v) && v.every(isString);
  if (
    !isBool(o.allowUncommon) ||
    !isBool(o.allowRare) ||
    !isBool(o.includeConsumables) ||
    typeof o.valuablesShare !== "number" ||
    !stringArray(o.preferTraits) ||
    !stringArray(o.excludeCategories)
  )
    return false;
  const coins = raw.coins;
  if (!(["pp", "gp", "sp", "cp"] as const).every((k) => isInt(coins[k]) && (coins[k] as number) >= 0))
    return false;
  return raw.entries.every(
    (e) =>
      isObject(e) &&
      isString(e.uuid) &&
      isString(e.name) &&
      isInt(e.level) &&
      typeof e.price === "number" &&
      Number.isFinite(e.price) &&
      e.price >= 0 &&
      ["permanent", "consumable", "valuable"].includes(e.kind as string) &&
      isInt(e.slotLevel) &&
      isBool(e.locked),
  );
}

export function validateTableFlags(raw: unknown): ValidationResult<TableFlags> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (raw.mode !== "range" && raw.mode !== "weight") errors.push("mode invalid");
  if (raw.encounterCheck !== null) {
    if (
      !isObject(raw.encounterCheck) ||
      !isString(raw.encounterCheck.formula) ||
      !Array.isArray(raw.encounterCheck.occursOn)
    ) {
      errors.push("encounterCheck invalid");
    }
  }
  if (!isObject(raw.tags)) errors.push("tags missing");
  if (!isString(raw.notes)) errors.push("notes missing");
  if (errors.length) return { ok: false, errors };
  const tags = raw.tags as Record<string, unknown>;
  const check = raw.encounterCheck as Record<string, unknown> | null;
  const value = {
    ...raw,
    // Trigger values are compared against roll totals: numeric strings are coerced, anything else dropped.
    encounterCheck: check
      ? {
          ...check,
          occursOn: (check.occursOn as unknown[])
            .map((n) => (isString(n) && n.trim() !== "" ? Number(n) : n))
            .filter(isInt),
        }
      : null,
    tags: {
      ...tags,
      region: strings(tags.region),
      terrain: strings(tags.terrain),
      season: strings(tags.season),
      timeOfDay: strings(tags.timeOfDay),
    },
  };
  return { ok: true, value: value as unknown as TableFlags };
}

export function validateResultFlags(raw: unknown): ValidationResult<ResultFlags> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (!RESULT_KINDS.includes(raw.kind as string)) errors.push("kind invalid");
  if (!Array.isArray(raw.creatures)) errors.push("creatures not an array");
  else {
    raw.creatures.forEach((c, i) => {
      if (!isObject(c) || !isString(c.uuid) || !isString(c.quantity)) errors.push(`creatures[${i}] invalid`);
    });
  }
  if (raw.tableUuid !== null && !isString(raw.tableUuid)) errors.push("tableUuid invalid");
  if (raw.template !== null) {
    if (
      !isObject(raw.template) ||
      !Array.isArray(raw.template.candidates) ||
      !COMPOSITIONS.includes(raw.template.composition as string)
    ) {
      errors.push("template invalid");
    }
  }
  if (!isString(raw.notes)) errors.push("notes missing");
  if (errors.length) return { ok: false, errors };
  // Coerce the optional fields the table code reads, so a damaged row cannot crash validation or resolution.
  const template = raw.template as Record<string, unknown> | null;
  const value = {
    ...raw,
    narrativeKind: NARRATIVE.includes(raw.narrativeKind as string)
      ? raw.narrativeKind
      : raw.kind === "narrative"
        ? "other"
        : null,
    journalUuid: isString(raw.journalUuid) ? raw.journalUuid : null,
    template: template
      ? {
          ...template,
          candidates: strings(template.candidates),
          traits: strings(template.traits),
          levelMin: finiteOrNull(template.levelMin),
          levelMax: finiteOrNull(template.levelMax),
          threat: THREATS.includes(template.threat as string) ? template.threat : null,
        }
      : null,
  };
  return { ok: true, value: value as unknown as ResultFlags };
}

export function validateTagStore(raw: unknown): ValidationResult<TagStore> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  // Legacy pre-release shape: { tags: { [uuid]: string[] } } -> convert to entries.
  if (!Array.isArray(raw.entries) && isObject(raw.tags)) {
    const entries = Object.entries(raw.tags)
      .filter(([, tags]) => Array.isArray(tags) && tags.every(isString))
      .map(([uuid, tags]) => ({ uuid, tags: tags as string[] }));
    return { ok: true, value: { schemaVersion: 1, entries } };
  }
  if (!Array.isArray(raw.entries)) errors.push("entries missing");
  else {
    raw.entries.forEach((e, i) => {
      if (!isObject(e) || !isString(e.uuid) || !Array.isArray(e.tags) || !e.tags.every(isString))
        errors.push(`entries[${i}] invalid`);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: raw as unknown as TagStore };
}

/* -------------------------------------------- */
/*  Factories                                   */
/* -------------------------------------------- */

export function emptyTableFlags(): TableFlags {
  return {
    schemaVersion: 1,
    mode: "range",
    encounterCheck: null,
    tags: { region: [], terrain: [], season: [], timeOfDay: [] },
    notes: "",
  };
}

export function emptyResultFlags(kind: ResultKind = "narrative"): ResultFlags {
  return {
    schemaVersion: 1,
    kind,
    creatures: [],
    tableUuid: null,
    narrativeKind: kind === "narrative" ? "other" : null,
    template: null,
    notes: "",
    journalUuid: null,
  };
}

export function emptyTagStore(): TagStore {
  return { schemaVersion: 1, entries: [] };
}

/* -------------------------------------------- */
/*  Custom themes (module data JournalEntry)    */
/* -------------------------------------------- */

export interface CustomThemeRecord {
  id: string;
  name: string;
  requiredTraits: string[];
  anyTraits: string[];
  environment: string | null;
  candidateUuids: string[];
  notes: string;
}

export interface ThemeStoreV1 {
  schemaVersion: 1;
  themes: CustomThemeRecord[];
}

export function validateThemeStore(raw: unknown): ValidationResult<ThemeStoreV1> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["not an object"] };
  if (raw.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (!Array.isArray(raw.themes)) errors.push("themes missing");
  else {
    raw.themes.forEach((t, i) => {
      if (
        !isObject(t) ||
        !isString(t.id) ||
        !isString(t.name) ||
        !Array.isArray(t.requiredTraits) ||
        !Array.isArray(t.anyTraits) ||
        !Array.isArray(t.candidateUuids) ||
        (t.environment !== null && !isString(t.environment)) ||
        !isString(t.notes)
      )
        errors.push(`themes[${i}] invalid`);
    });
  }
  if (errors.length) return { ok: false, errors };
  // Non-string list elements can never match a trait or uuid; drop them instead of the whole store.
  const themes = (raw.themes as Record<string, unknown>[]).map((t) => ({
    ...t,
    requiredTraits: strings(t.requiredTraits),
    anyTraits: strings(t.anyTraits),
    candidateUuids: strings(t.candidateUuids),
  }));
  return { ok: true, value: { ...raw, themes } as unknown as ThemeStoreV1 };
}

export function emptyThemeStore(): ThemeStoreV1 {
  return { schemaVersion: 1, themes: [] };
}
