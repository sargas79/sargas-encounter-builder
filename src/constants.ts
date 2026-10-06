/** Module identifier. Also the namespace for flags, settings, hooks and CSS classes. */
export const MODULE_ID = "sargas-encounter-builder" as const;

/** Flag keys used under `flags[MODULE_ID]`. */
export const FLAGS = {
  /** Saved encounter recipe stored on a JournalEntry. */
  recipe: "recipe",
  /** Table-level encounter metadata on a RollTable. */
  table: "table",
  /** Row-level encounter metadata on a TableResult. */
  result: "result",
  /** Custom creature tag map on the module data JournalEntry. */
  tags: "tags",
  /** GM-authored themes on the module data JournalEntry. */
  themes: "themes",
  /** Marker that a JournalEntry is the module data journal. */
  dataJournal: "dataJournal",
  /** Provenance marker on imported world Actors. */
  importedFrom: "importedFrom",
  /** Marker on tokens created by a deployment operation. */
  deployment: "deployment",
  /** Provenance marker on Loot actors created from a treasure result. */
  treasure: "treasure",
  /** Marker on the module-managed summary page of a saved recipe JournalEntry. */
  summary: "summary",
  /** Role of a module-created Folder ("recipes", "loot"), so it is found again under any name. */
  folder: "folder",
} as const;

/** World setting keys. */
export const SETTINGS = {
  partyProfiles: "partyProfiles",
  activeParty: "activeParty",
  selectedPacks: "selectedPacks",
  packsInitialized: "packsInitialized",
  tableMaxDepth: "tableMaxDepth",
  tableMaxQuantityPerEntry: "tableMaxQuantityPerEntry",
  tableMaxTotalCreatures: "tableMaxTotalCreatures",
  numberDuplicateTokens: "numberDuplicateTokens",
  debugMode: "debugMode",
  dataSchemaVersion: "dataSchemaVersion",
  /** Per-user UI memory: last party, mode and threat. */
  uiState: "uiState",
} as const;

/**
 * English names of module-owned documents. New documents get the localized name
 * (`documents.*` in lang/en.json); these stay as the fallback and so that folders created by
 * earlier versions, before folders carried a role flag, are still found by name.
 */
export const DOCUMENT_NAMES = {
  dataJournal: "Encounter Builder Data",
  recipeFolder: "Encounter Builder: Saved Encounters",
  lootFolder: "Encounter Builder: Treasure",
} as const;

/** Hooks emitted by the module (all prefixed with the module id). */
export const HOOKS = {
  evaluationChanged: `${MODULE_ID}.evaluationChanged`,
  deploymentComplete: `${MODULE_ID}.deploymentComplete`,
} as const;
