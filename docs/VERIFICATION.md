# Verification record

This file records what was verified against real sources during implementation, what could not be
verified in the build environment, and the exact steps to verify the remainder in a running Foundry world.

**Environment facts:** the build environment has no Foundry VTT installation and no browser access to
foundryvtt.com, paizo.com, or Archives of Nethys (those hosts were blocked by the egress proxy). Public
source files of the PF2e system were readable from `raw.githubusercontent.com`. All "verified" items below
were verified by reading source code and type definitions, not by executing code in Foundry.

## 1. Target versions

| Item                  | Evidence                                                                                                     | Decision                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| PF2e `release` branch | `static/system.json`: version **6.12.4**, compatibility `{minimum: 12.328, verified: 12.331, maximum: 12}`   | Foundry 12 line                                        |
| PF2e `v13-dev` branch | `static/system.json`: version **7.9.1**, compatibility `{minimum: 13.348, verified: 13.351, maximum: 13}`    | Foundry 13 line, the newest the system supports        |
| PF2e v14 branch       | No branch named `v14`, `v14-dev`, `v14-prototype`, `main`, `next`, or `release-v14` exists on the repository | **No PF2e release declares Foundry v14 compatibility** |
| Foundry v14           | foundryvtt.com unreachable from the build environment; could not confirm a stable v14 release                | Not confirmed                                          |

**Decision (updated after the maintainer confirmed their world runs Foundry v14):** the module targets
**Foundry VTT 14** only, with the PF2e release that supports it (PF2e 8.0.0 or later). `module.json` declares
`compatibility.minimum: "14"`, `compatibility.maximum: "14"`, and leaves `verified` unset because the module has
not been run. The public PF2e GitHub repository could not be used to
verify the v14 system API: as of 2026-10-01 its `release`/`master` branches still read 6.12.4 (Foundry 12) and
`v13-dev` reads 7.9.1 (Foundry 13), with no v14 branch — the repository appears to lag the published system.
All data paths in §2 were therefore verified against PF2e 7.9.1 sources, and all Foundry APIs in §3 against
the Foundry 13 type definitions shipped with it. Everything the module calls is either a v13 ApplicationV2 /
namespaced `foundry.*` API expected to persist in v14 or is wrapped in `src/foundry/compat.ts` with a
fallback. **Run the Quench suite on the real v14 + PF2e install before trusting any of §2–§3** (see §4 and §5).

## 2. PF2e data paths (verified by source reading, PF2e `v13-dev` @ 7.9.1)

| Purpose                    | Path / API                                                                                                                                                                      | Source                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actor level                | `actor.level` getter                                                                                                                                                            | `src/module/actor/base.ts` line ~208                                                                                                                   |
| Actor type check           | `actor.isOfType("character" \| "npc" \| "party" \| "familiar" \| "hazard")` and `actor.type`                                                                                    | `src/module/actor/base.ts`                                                                                                                             |
| NPC level in index         | `system.details.level.value`                                                                                                                                                    | `src/module/actor/npc/data.ts`; also the index field used by the system's own bestiary browser (`src/module/apps/compendium-browser/tabs/bestiary.ts`) |
| NPC traits / rarity / size | `system.traits.value`, `system.traits.rarity`, `system.traits.size.value`                                                                                                       | bestiary browser tab                                                                                                                                   |
| NPC publication            | `system.details.publication.title`                                                                                                                                              | bestiary browser tab                                                                                                                                   |
| Party actor type           | `type: "party"`                                                                                                                                                                 | `src/module/actor/party/document.ts`                                                                                                                   |
| Party members (source)     | `system.details.members: {uuid}[]`                                                                                                                                              | `src/module/actor/party/data.ts`                                                                                                                       |
| Party members (resolved)   | `party.members: CreaturePF2e[]` (prepared, excludes unresolvable)                                                                                                               | `src/module/actor/party/document.ts`                                                                                                                   |
| Compendium provenance      | `actor._stats.compendiumSource` (Foundry) and `actor.sourceId` getter (`duplicateSource ?? compendiumSource`)                                                                   | `src/module/actor/base.ts` line ~151                                                                                                                   |
| PWL setting                | world setting `pf2e.proficiencyVariant` (boolean) mirrored at `game.pf2e.settings.variants.pwol.enabled`                                                                        | `src/module/system/settings/variant-rules.ts` lines 96–103                                                                                             |
| System XP helper           | `game.pf2e.gm.calculateXP(partyLevel, partySize, npcLevels, hazards, { pwol })` returning `{ totalXP, encounterBudgets, rating, ratingXP, xpPerPlayer, partySize, partyLevel }` | `src/scripts/set-game-pf2e.ts` line ~95, `src/scripts/macros/xp/index.ts`                                                                              |

### Important behavioral differences vs. this module

- **`calculateXP` clamps out-of-range creatures** to ±4 (`Math.clamp` in `getXPFromMap`). This module does not:
  it marks them unsupported and reports an incomplete evaluation. The runtime cross-check therefore only
  compares totals when every creature is within −4..+4.
- **`calculateXP` budgets use `partySize × 20 × multiplier`** (`trivial 0.5, low 0.75, moderate 1, severe 1.5,
extreme 2`). For four characters this equals the rulebook table, but for other sizes it differs from the
  rulebook's per-character adjustments (e.g. Low for five characters: rulebook 80, system 75). This module
  uses the rulebook formula. The cross-check compares **creature XP totals**, not budgets.
- PF2e's encounter tracker uses the **rounded mean** of character levels as the party level
  (`src/module/encounter/document.ts`). This module requires an explicit policy for mixed-level parties.
- PWL creature XP values in the system (`xpVariantCreatureDifferences`) span −7..+7. When PWL is enabled this
  module delegates per-creature XP to `calculateXP` (one creature at a time) and labels the evaluation as a
  system calculation.

## 3. Foundry 13 document APIs (verified from the type definitions shipped in PF2e `types/foundry`)

| Item                                          | Verified                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TableResult` schema                          | `type` (`"text"` or `"document"`), `name`, `img`, `description`, `documentUuid`, `weight`, `range: [number, number]`, `drawn`, `flags` (`types/foundry/common/documents/table-result.d.mts`). `CONST.TABLE_RESULT_TYPES = { TEXT: "text", DOCUMENT: "document" }`. |
| `RollTable#roll({ roll, recursive, _depth })` | "only performs the roll and identifies the result"; returns `{ roll, results }`; does **not** post chat or mark results drawn. `recursive` defaults to true.                                                                                                       |
| `RollTable#draw(...)` / `#drawMany(...)`      | Accept `displayChat` and `recursive`; they formalize a draw (mark drawn, post chat). **This module never calls them.**                                                                                                                                             |
| `RollTable` fields                            | `formula`, `replacement`, `displayRoll`, `results` embedded collection.                                                                                                                                                                                            |
| `CompendiumCollection#getIndex({ fields })`   | Present.                                                                                                                                                                                                                                                           |
| `TokenDocument`                               | `actorLink`, `actorId`, `hidden`, `width`, `height` (grid units), `delta`; `getSize()`; `baseActor`, `isLinked`.                                                                                                                                                   |
| Grid                                          | `grid.isSquare / isHexagonal / isGridless`, `grid.size`, `getTopLeftPoint`, `getOffset`, `getAdjacentOffsets`; `CONST.GRID_TYPES.GRIDLESS = 0`, `SQUARE = 1`.                                                                                                      |
| `Combat`                                      | `createEmbeddedDocuments("Combatant", ...)`; `startCombat()` and `rollAll()` exist and are **never** called by this module.                                                                                                                                        |
| ApplicationV2                                 | `DEFAULT_OPTIONS` with `actions`, `HandlebarsApplicationMixin` with `PARTS`, `_prepareContext`, `_onRender`.                                                                                                                                                       |

## 4. Not verified (requires a running Foundry world)

These are isolated behind `src/foundry/*` adapters and are exercised by the Quench suite (`src/quench/tests.ts`) and the manual matrix (`docs/MANUAL-TESTS.md`).

1. That `RollTable#roll({ recursive: false })` leaves `drawn` untouched and posts no chat for a table with `replacement: false` (T17).
2. That unlinked tokens created from one world NPC have independent HP after damage in PF2e 7.x (T20).
3. That `game.pf2e.gm.calculateXP` is present with the signature above on the installed PF2e version (T25).
4. That the Party actor's `system.details.members` resolves to `party.members` as expected after world load.
5. That `_stats.compendiumSource` is populated on actors imported via `Actor.create(fromCompendium)` in the installed Foundry build (T19).
6. Placement geometry on hex and gridless scenes (warned, fallback used).
7. The ORC License notice wording in `LICENSE-ORC.md` (paizo.com unreachable from the build environment).

## 5. Runtime verification steps

1. Install Foundry VTT 13 (latest stable) and PF2e 7.x. Note both versions.
2. Install this module from the repository (`npm ci && npm run build`, then copy `module.json`, `dist/`, `lang/`, `styles/`, `templates/` into `Data/modules/sargas-encounter-builder/`).
3. Install and enable the **Quench** module. Open the Quench panel and run the `sargas-encounter-builder` suites.
4. Follow `docs/MANUAL-TESTS.md` for the remaining manual cases and record the Foundry build and PF2e version in the results table.
5. Only after all suites pass may `module.json`'s `compatibility.verified` be set, to the exact Foundry build used.

## 6. Test results in the build environment

Recorded on 2026-10-01 in the build container (Node 22.22.0, no Foundry):

| Check                                         | Result                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm test` (Vitest 4)                         | 130 tests, 8 files, all passing                                                        |
| `npm run lint` (ESLint 9 + typescript-eslint) | clean                                                                                  |
| `npm run typecheck` (TypeScript 5.9, strict)  | clean                                                                                  |
| `npm run build` (Vite 7, ES module)           | `dist/sargas-encounter-builder.js` + lazy chunks                                       |
| Quench suites                                 | **not executed** (no Foundry available); 4 batches registered in `src/quench/tests.ts` |
| Manual matrix (`docs/MANUAL-TESTS.md`)        | **not executed**                                                                       |

At 0.1.0, `module.json` declared `compatibility.minimum: "13"`, `maximum: "14"`, and no `verified` (superseded:
see §1 and §6b).

## 6b. 0.2.0 update

- The maintainer's other modules (`wondrous-spellbook`, `sargas-investigation-board`, `victory-counter-v13`)
  are verified on Foundry 14.366–14.368 with PF2e 8.5.1, so `module.json` now declares Foundry 14 and PF2e
  8.0.0 minimums. The PF2e data paths in §2 were verified against 7.9.1 source; PF2e 8 keeps the item paths
  those modules use (`system.level.value`, `system.traits.value`, `system.traits.rarity`), and the NPC paths
  are checked at runtime by the Quench "system integration" batch.
- Build-environment results for 0.2.0: 148 Vitest tests passing; lint, typecheck and build clean. Quench and
  the manual matrix (including M29–M39) remain to be run.

## 6c. 0.3.0 treasure

- `src/rules/treasure-tables.ts` reproduces GM Core Table 10-9 from the implementer's knowledge of the
  book; Archives of Nethys could not be fetched from the build environment. Spot-check at least levels 1,
  5, 10 and 20 against the printed table before trusting the numbers.
- Item index fields read from `pf2e.equipment-srd`: `type`, `img`, `system.level.value`,
  `system.price.value` ({pp,gp,sp,cp}), `system.price.per`, `system.traits.rarity`, `system.traits.value`,
  `system.stackGroup` ("coins" marks the coin items). Verify on PF2e 8.x that these are index-able and
  that the coin items are named "Platinum/Gold/Silver/Copper Pieces".
- Loot actor creation: `type: "loot"`, `system.lootSheetType: "Loot"`, items passed as embedded data.

## 7. Foundry v14-specific risks to verify first

The code was written against the v13 API surface. On v14 check these before anything else:

1. `foundry.applications.api.ApplicationV2` / `HandlebarsApplicationMixin` behaviour of `PARTS`, `actions`,
   `_onRender`, `render({ parts })` (used by both applications).
2. `foundry.applications.ux.DragDrop.implementation` and `TextEditor.implementation.getDragEventData`
   (wrapped in `src/foundry/compat.ts` with fallbacks).
3. `CONFIG.<Document>.documentClass.create(...)` for Actor, JournalEntry, RollTable, Folder, Combat.
4. `RollTable#roll({ recursive: false })` semantics and the `TableResult` schema (`type`, `documentUuid`, `range`, `weight`, `drawn`).
5. `Scene#dimensions` fields (`sceneX`, `sceneY`, `sceneWidth`, `sceneHeight`) and `grid.size`/`grid.type`.
6. `canvas.canvasCoordinatesFromClient` for origin picking (falls back to `canvas.mousePosition`).
7. Handlebars helpers `eq`, `ne`, `concat`, `localize` availability in templates.
8. The `renderActorDirectory` hook signature (HTMLElement vs. jQuery) for the launcher button.
