> **Note:** this is the original generation brief used to build the module, not user documentation. See `README.md`.

# Implementation prompt: PF2e Encounter Builder for Foundry VTT

You are a senior Foundry VTT and Pathfinder Second Edition module developer. Implement a complete, usable module from this specification, delivered in the milestones in §12. Do not stop at a design document, mock interface, or pseudocode. Inspect the repository and available Foundry/PF2e sources first, then plan and implement in testable increments.

## 0. Environment facts and verification sources

- The repository starts empty apart from `LICENSE` (MIT). There are no existing conventions; use the toolchain in §0.1.
- You cannot run Foundry VTT in this environment. Verify integration points against source code and typings, isolate anything still uncertain behind the `PF2eAdapter` / Foundry adapter boundary, and record it in `docs/VERIFICATION.md` with exact manual verification steps.
- Primary verification sources, in order:
  1. The open-source PF2e system repository (`github.com/foundryvtt/pf2e`) at the release tag you target — for the NPC/character/party data model, `game.pf2e` APIs, settings keys, and the Foundry type definitions it ships (`types/foundry`).
  2. Version-matched Foundry API docs (https://foundryvtt.com/api/v14/ or the version actually targeted).
  3. Archives of Nethys rules pages (https://2e.aonprd.com/Rules.aspx?ID=2717, ID=2719) for rule constants.
- **Target version decision:** confirm that a stable Foundry v14 release and a PF2e release declaring v14 compatibility both exist. If they do, target v14 with `compatibility.minimum`/`verified` set honestly (leave `verified` unset unless tested). If either does not, target the newest stable Foundry generation that PF2e supports and treat v14 as provisional. Record the decision and evidence in `docs/VERIFICATION.md`.
- Never claim unexecuted runtime tests passed. Never invent methods or assume older schemas still apply.

### 0.1 Toolchain (fixed decisions)

- TypeScript, ES modules, strict mode. Bundle with Vite (library mode) to a single `dist/` module entry.
- Tests: Vitest for pure and mocked-integration tests. In-Foundry integration tests use the Quench module, registered only when Quench is active, and are run manually by a GM.
- Lint/format: ESLint + Prettier with a minimal config.
- Node LTS; npm; commit `package-lock.json`.
- Scripts: `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`. All must pass at the end of every milestone.

### 0.2 Licensing and data sources

- **ORC (Open RPG Creative License).** Paizo publishes Remaster rules under the ORC. The module may use ORC Licensed Material (game mechanics such as the XP budget and creature XP tables) as long as it:
  - includes the ORC License notice in a `LICENSE-ORC.md` (or an ORC section in the README) that identifies which material is ORC Licensed Material and credits the source books (e.g. _Pathfinder GM Core_, Paizo Inc.);
  - does not use **Reserved Material** (Paizo trademarks, setting proper names, deities, characters, artwork, trade dress) beyond what the license and Paizo's community use policy allow;
  - keeps ORC material clearly separated from the MIT-licensed code (e.g. rule constants in `src/rules/` with a header comment naming the source and license).
    Read the actual ORC license text and record the notice wording in the repo; do not paraphrase its requirements from memory.
- **Archives of Nethys.** Use AoN pages as the human-readable reference to confirm the rule constants in §4.1 and cite them in the ORC attribution. Do not scrape AoN, call its internal search endpoints, or fetch it at runtime: it is not a published data API, and its terms for automated access are not established here.
- **Creature data.** Comes from the PF2e system compendia installed in the GM's world (which the system itself licenses under ORC/OGL). Do not bundle creature data in the first release. If bundled content is wanted later, source it from the PF2e system repository's pack data (which carries explicit license files) rather than from AoN, and carry its license and attribution forward.

## 1. Target and working rules

- Module ID: `sargas-encounter-builder`. Namespaced flags, CSS classes, hooks, and settings.
- Use ApplicationV2 (with HandlebarsApplicationMixin if templates are used) and supported public document APIs and hooks. No monkey patches or private APIs.
- Keep all user-facing text localizable; ship English (`lang/en.json`).
- GM-only module. Note that Foundry's server-side document permissions and world-scoped settings are the real authorization boundary; module-level `game.user.isGM` checks are a UX layer and a defense-in-depth guard on every write path, not a substitute. Do not grant players ownership of any module-created document by default.
- Licensing (see §0.2): the code is MIT. The rule constants in §4.1 are Pathfinder Remaster game mechanics and are used as ORC Licensed Material with the required ORC notice and attribution. No creature stat blocks are bundled; creatures come from installed world/compendium content at runtime. Placeholder examples in docs/tests use invented names.
- **Reuse PF2e where it already provides the capability** (see §2 and §3). Do not build a parallel implementation that can disagree with the system.

## 2. Product objective

A GM workspace connecting party management, compendium-backed encounter building, balanced random generation, classic weighted random encounter tables, saved encounter recipes, and explicit scene deployment.

Balanced generation is separate from classic random tables. A classic wilderness table may produce an encounter the party cannot safely fight. Never silently scale or replace its result.

Main workflow: select party → select manual, balanced random, or table-driven mode → preview and evaluate → save, import, or deploy.

## 3. Party management

### 3.1 Sources

- **Primary source: PF2e's native Party actor** (`type: "party"`). Verify its member storage and accessor (e.g. `members`) in the targeted PF2e source. The GM can select any Party actor as the active party; the module reads members live.
- **Module party profiles** (world setting) exist for cases the Party actor doesn't cover: excluding a member from this encounter without editing the Party actor, or composing an ad-hoc group. A profile is either _linked_ (a Party actor UUID plus per-member participation overrides) or _standalone_ (a list of Actor UUIDs). Profiles never copy character sheet data.

### 3.2 Membership rules

- Each member has an active/participating toggle; inactive members remain listed.
- Party size = number of active members of type `character`. Count characters, not connected users, owners, or scene tokens.
- Familiars, animal companions, and other non-`character` actors do not count toward party size. If they appear in a Party actor, list them as "not counted" with the reason.
- NPC allies do not count by default. The GM may mark an NPC ally as "counts as a party member" per profile; show this clearly as a GM override.
- Reject unsupported Actor types (in standalone profiles) with a useful explanation; prevent duplicate membership.
- Flag missing or inaccessible Actor UUIDs; never silently replace or drop them.
- Recalculate on relevant `updateActor`, `deleteActor`, and Party-actor membership changes. Register hooks once; debounce re-renders.

### 3.3 Reference level

- Read each character's level via `actor.level` (verify in source).
- All active levels equal → that level is the reference level, policy "uniform".
- Mixed levels → evaluation is blocked until the GM chooses a policy: "average rounded down" (labeled as a module estimate, not an official balance guarantee), "highest", "lowest", or "manual override" (integer 1–25, validated). The choice is stored on the profile.
- No active characters, no valid levels, or an invalid override → show the problem and disable generation and deployment.
- Always display: party name and source (Party actor / profile), counted participants, individual levels, reference level and policy, selected threat, and target budget.

## 4. PF2e budgeting

Implement as pure, independently unit-tested functions with no Foundry globals.

### 4.1 Constants (verify against the cited rules pages before coding)

| Threat   | Budget for four characters | Per-character adjustment |
| -------- | -------------------------: | -----------------------: |
| Trivial  |            40 XP (ceiling) |                    10 XP |
| Low      |                      60 XP |                    20 XP |
| Moderate |                      80 XP |                    20 XP |
| Severe   |                     120 XP |                    30 XP |
| Extreme  |                     160 XP |                    40 XP |

| Creature level − reference level |  XP |
| -------------------------------- | --: |
| −4                               |  10 |
| −3                               |  15 |
| −2                               |  20 |
| −1                               |  30 |
| 0                                |  40 |
| +1                               |  60 |
| +2                               |  80 |
| +3                               | 120 |
| +4                               | 160 |

### 4.2 Target budget

- `target(threat, n) = base(threat) + (n − 4) × adjustment(threat)`, where `n` is counted party size (§3.2).
- Trivial is a ceiling: any total ≤ target qualifies.
- If a computed target is ≤ 0 (e.g. Low for a single character: 60 − 3×20 = 0), that threat is **unavailable** for this party size: show it disabled with the reason, and the generator refuses it. Do not clamp or substitute.
- Party size 0 → no budgets; evaluation is blocked.
- Party sizes above 8 are computed by the formula but flagged "large party: rules guidance is limited."

### 4.3 Encounter evaluation

- Each creature's contribution = XP for `(creature level − reference level)` × quantity, using the creature's current effective level (`actor.level` for world actors; the index level for compendium entries — see §5).
- A creature outside −4..+4 is **out of range**: its contribution is not counted, not extrapolated, not clamped. The evaluation is marked **incomplete** and lists each out-of-range entry. Below −4 is described as "negligible threat (not counted)"; above +4 as "beyond the budget table (danger not quantified)".
- Show target threat and budget, supported XP subtotal, completeness, difference from target, and warnings.

### 4.4 Inferred threat (normative algorithm)

Given supported subtotal `xp` and party size `n`, considering only tiers whose target is > 0:

1. If the evaluation is incomplete because of any creature above +4 → inferred threat is **"Beyond Extreme (unquantified)"**, regardless of `xp`.
2. Else if `xp` > target(Extreme) → **"Beyond Extreme"**.
3. Else if `xp` ≤ target(Trivial) → **"Trivial"**.
4. Else → the **lowest** tier whose target is ≥ `xp` (e.g. 90 XP for four characters → Severe, since 80 < 90 ≤ 120; exactly 80 → Moderate).
5. If the evaluation is incomplete only because of creatures below −4, apply 2–4 and append "(incomplete: negligible creatures not counted)".

Always label this as **inferred**, distinct from the GM-selected **target**. Document the algorithm in the README.

### 4.5 Cross-check with PF2e

- Verify whether the targeted PF2e exposes an encounter XP helper (e.g. `game.pf2e.gm.calculateXP`). If it does, add a Quench test and a debug-mode runtime check asserting the module's totals match it for the standard rules; on mismatch, log one diagnostic and show a warning. The module's pure functions remain the source of truth for unit tests.
- Variant rules: detect the Proficiency Without Level setting via the verified PF2e settings key. If it is enabled and the PF2e helper supports it, use the PF2e helper's per-creature XP values and label the evaluation "PWL (system calculation)". Otherwise show "Variant not supported: budgets may be inaccurate" and do not substitute an invented formula.

### 4.6 XP awards

Encounter construction XP is not an award. Party-size budget adjustments are never presented as XP awarded. No automatic XP awards in this release.

### 4.7 Acceptance example

Five level-4 characters: Moderate target = 80 + 1×20 = 100 XP. Two level-4 creatures and one level-2 creature = 40 + 40 + 20 = 100 XP → complete, difference 0, inferred Moderate.

## 5. Creature catalog

- Discover accessible Actor compendiums; let the GM choose source packs (world setting).
- Include PF2e actors of type `npc` only. Exclude characters, hazards, familiars, parties, and other types.
- Browse via `pack.getIndex({ fields: [...] })` with explicitly requested fields. Verify the paths in the targeted PF2e source (expected candidates: `system.details.level.value`, `system.traits.value`, `system.traits.rarity`, `system.traits.size.value`, `system.details.publication`). Load full documents only for inspect, validate, or import.
- Search by name; filter by level (absolute or relative to the reference level), traits, rarity, size, source pack, and custom tags.
- Identity is the source UUID, never the name.
- **Custom tags** (creature family, environment): stored in a single module-owned JournalEntry ("Encounter Builder Data", GM-only ownership) as a flag map `uuid → tags[]`, with a versioned schema. Not in a world setting. Do not assume packs carry terrain/environment metadata.
- Cache indexes in memory per session keyed by pack ID; invalidate on compendium document create/update/delete hooks for that pack and on pack-selection changes; provide a manual refresh action. Never persist index copies to settings.
- Show loading, empty, inaccessible, and missing-source states.
- Adding a creature to a preview never imports it or modifies its source.
- Entry actions: inspect, add, quantity edit, remove, lock-for-generation.

## 6. Builder modes

### 6.1 Manual mode

Search and add creatures, adjust quantities, see live evaluation. Unusual compositions produce warnings, not rejections.

### 6.2 Balanced random mode

**Inputs:** target threat, active party, selected packs, creature level bounds (relative values are relative to the reference level; absolute values are levels), min/max total creature count, trait/family/environment/rarity filters, composition preference, duplicate cap, excluded creatures, locked entries.

**Hard constraints** (never loosened; violation → explicit failure with reason):

- Locked entries are included unchanged.
- Total supported XP ≤ the threat's _band ceiling_ (see near-fit below); for Trivial, ≤ target.
- Total creature count within [min, max].
- Every creature passes all filters and level bounds and is within −4..+4 of the reference level.
- No excluded creature; no creature exceeding the duplicate cap.
- Composition preference when it's not "unrestricted":
  - **solo:** exactly one creature, total count 1.
  - **pair:** exactly two creatures (same or different).
  - **group:** at least 3 creatures, none more than 1 level above the reference level.
  - **boss with support:** exactly one creature at the highest level present, at least 2 levels above every other creature, plus ≥ 1 support creature.

**Soft preferences** (affect scoring only): closeness to target XP, creature variety, trait coherence, fewer distinct stat blocks for easier running.

**Algorithm (required approach):**

1. Compute remaining budget after locked entries. If locked entries alone exceed the band ceiling → fail with "locked entries exceed budget" and the overage.
2. Enumerate multisets of relative levels in −4..+4 (respecting level bounds, count limits, and the composition rule) whose XP sum fits the remaining budget. This search space is small; enumerate it exhaustively with pruning and a hard cap on enumerated combinations (e.g. 50,000). If the cap is hit, report it.
3. Discard level-multisets that the filtered catalog can't fill (count available distinct creatures per level, considering the duplicate cap).
4. Classify: **exact** (sum = target), **near fit** (target − sum ≤ the tier's per-character adjustment, and sum ≤ target), else **under budget**. Prefer exact; then near fit; return an under-budget result only if no better option exists, labeled with its difference and reason. Never exceed the target except Trivial's ceiling rule, which has no lower bound.
5. Randomly choose among the best class (weighted by soft-preference score) using the injectable RNG, then randomly fill each level slot from the eligible creatures.
6. Empty catalog, no feasible multiset, or impossible constraints → fail with the specific constraint(s) responsible. Never retry with loosened constraints silently.

**Determinism:** the generator takes an injectable RNG (`() => number` in [0,1)) and an optional seed (use a small seeded PRNG such as mulberry32). The seed covers generation only; table resolution (§7) uses Foundry dice unless stated otherwise. Same seed + same catalog + same inputs → same result.

**Actions:** regenerate, and replace-one-entry (re-run steps 2–5 holding all other entries locked).

### 6.3 Table-driven mode

Roll a selected regional table (§7), show the resolution trace and result, and evaluate the result against the active party.

## 7. Classic encounter tables

Use native RollTable and TableResult documents with structured metadata in module flags (versioned schema).

### 7.1 Verify before coding

- The TableResult `type` values and document-reference field in the targeted version (Foundry v13 merged result types into `text` and `document` with a `documentUuid` field; confirm v14 keeps this).
- Differences between `RollTable#roll`, `#draw`, and `#drawMany`: chat output, `drawn` state mutation, `replacement` behavior, and **native recursive resolution of nested RollTable results** (and its built-in depth limit).

### 7.2 Resolution rules

- The module's resolver calls the native roll **without native recursion** (verify the option, e.g. `recursive: false`) and performs nesting itself, so cycle detection and depth limits apply exactly once.
- It never posts chat messages, never sets `drawn`, never imports, and never mutates documents. "Replacement" is therefore always effectively on for module rolls; repeated wilderness checks can't exhaust a table. If a table has `replacement: false` and drawn results, warn that native draws differ from module rolls, and evaluate over all results without changing their state.
- Quantity formulas and encounter-check formulas must be pure dice expressions: validate against an allowlist grammar (integers, `NdM`, `+`, `-`, `*`, parentheses, `kh`/`kl`). Reject `@` references, function calls, and flavor text. Evaluate with Foundry's `Roll`.
- Limits (module settings with safe defaults): max nesting depth 5, max quantity per entry 20, max total resolved creatures 40. Exceeding a limit stops resolution with a visible error and the partial trace.

### 7.3 Supported content

- Table formulas such as `1d20`, `1d100`, `2d6`.
- **Range mode** (explicit authored ranges; never auto-normalized) and **weight mode** (weights; ranges derived by the editor). The table's mode is stored in a flag; existing tables default to range mode.
- Result kinds (flag `kind`): `creatures` (one or more `{uuid, quantity}` entries, quantity fixed or a dice formula), `table` (UUID of another RollTable), `narrative` (tracks, travelers, discovery, weather, other), `none` (no encounter), `template` (party-scaled generation template, §7.5).
- World or compendium Actor UUIDs; GM notes; optional JournalEntry/Page UUID; region, terrain, season, time-of-day tags.
- Optional encounter check per table (e.g. "encounter on 1 on 1d6").
- Each module-authored result also writes a plain-text summary into the native result text (e.g. "1d4+1 × Wolf-analogue; GM note…") so native draws without the module stay readable.

### 7.4 Editor

- Add/remove/reorder rows; edit range or weight, kind, creature group, quantities, notes, linked table/journal, tags.
- Drag-and-drop Actors and RollTables onto rows.
- Validate: malformed formulas, overlapping ranges, gaps, ranges outside the formula's possible results, zero weights (unreachable), missing references, self/cyclic references.
- Native results without module flags appear read-only as narrative/text or document references. Never parse prose into creature references.
- Opening an existing table in the editor does not write anything until the GM saves; saving only adds or updates module flags and the rows the GM edited.

### 7.5 Resolution policies

1. **Classic** (default): preserve rolled identities and quantities; evaluate and warn afterward. Never scale silently.
2. **Party-scaled:** only for `template` results, which define allowed candidates (UUID list and/or filters), composition preference, and optional threat. The result is generated with §6.2 for the active party. Other result kinds show "not scalable: no template configured."

**Create balanced variant** (explicit action on a classic result): runs §6.2 using the classic result's creatures as the candidate pool (and their traits as filters); stores the original outcome, the variant, and a per-entry diff (added/removed/quantity changed).

### 7.6 Trace

Record: encounter-check formula and result; each table's UUID and name; dice formula and total; matched range/row; nested results; each quantity formula and roll; unavailable sources; failed rolls; the original outcome; and the scaled/variant outcome if one was requested. Unavailable sources and failed rolls appear in the result and trace and are never silently dropped.

## 8. Saved encounters

- Each saved encounter recipe is a JournalEntry in a module folder ("Encounter Builder: Saved Encounters"), default ownership NONE for non-GMs, with data in a versioned flag (`flags.sargas-encounter-builder.recipe`, `schemaVersion`).
- Stored: name, entries `{uuid, quantity, locked}`, notes, generation inputs/seed, policy, table trace if any, and an **evaluation snapshot** (party identity, counted members and levels, reference level and policy, threat, target, totals, inferred threat, timestamp).
- On open: resolve UUIDs and report missing ones; show the saved snapshot; offer "Recalculate for current party", which shows the new evaluation alongside the original and never overwrites the snapshot unless the GM explicitly chooses "Update saved evaluation".
- Edit, duplicate, rename, delete (with confirmation).
- Migrations: a migration runner keyed by `schemaVersion` runs on `ready` for GMs only, is idempotent, never deletes unknown fields, and logs a single summary.
- Party profiles and module preferences live in world settings. Large collections (recipes, tags) live in documents.

## 9. Import and scene deployment

| Action           | Effect                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Add to encounter | Add reference and quantity only                                   |
| Inspect          | Show the source creature sheet (read-only for compendium sources) |
| Import creatures | Create world Actors from source documents                         |
| Place tokens     | Create tokens on the selected scene                               |
| Add to combat    | Add the tokens just placed to a selected or new Combat            |

- Imports and deployment require explicit GM action.
- Import policy per run: **reuse existing** (match a world Actor whose `_stats.compendiumSource` — verify the field in the target version — equals the source UUID; never match by name) or **fresh copy**. Imports preserve provenance via the native compendium-source field plus a module flag.
- Never modify compendium documents.
- Tokens are always **unlinked** (`actorLink: false`) for deployed NPCs, regardless of the prototype setting, so identical creatures have independent HP and conditions. Verify PF2e's synthetic actor behavior in a Quench test.
- Token names: when deploying more than one token from the same actor, append a number ("Name 1", "Name 2", …), unless the GM turns this off.
- Deployment preview: scene, creature counts, import/reuse policy, hidden/visible, placement origin and footprint, combat option.
- Placement (first release): the GM clicks an origin on the canvas; tokens are placed on a square spiral of free grid cells around it, respecting each token's size in grid units, clipped to scene bounds, and avoiding existing tokens. Square grids are supported. Hex and gridless scenes show a warning and fall back to the spiral with offsets of the token's pixel width. If not every token fits, block deployment and say how many fit.
- Tokens are hidden by default; a "visible" option is available.
- Disable the deploy button during writes; ignore duplicate submissions of the same in-flight operation.
- Track every document the operation creates. On partial failure, report exact successes and failures and offer cleanup that deletes only operation-created documents. Never delete reused Actors or pre-existing tokens.
- Combat: optional. Never start combat, roll initiative, reveal tokens, or award XP.

## 10. Architecture

Services (TypeScript modules under `src/`):

- `PF2eAdapter`: all system data access (levels, actor types, Party actor members, PWL setting, `calculateXP` cross-check, index field paths). The only place PF2e data paths appear.
- `PartyService`: profiles, membership, participation, reference-level policies, actor update handling.
- `CreatureCatalog`: pack discovery, index requests, filters, tags, cache, UUID resolution.
- `EncounterBudget`: pure budget/XP/inferred-threat functions.
- `EncounterGenerator`: pure enumerative generator with injectable RNG.
- `TableResolver`: checks, rolls, nested resolution, safety limits, trace.
- `EncounterRepository`: recipes, tags store, migrations.
- `DeploymentService`: imports, placement, combat, partial-failure handling.
- `EncounterBuilderApp`: ApplicationV2 UI with tabs (Party, Build, Tables, Saved, Deploy).
- `EncounterTableEditor`: ApplicationV2 editor layered on RollTables.

Rules:

- `EncounterBudget` and `EncounterGenerator` import nothing from Foundry. Other services receive Foundry access through thin adapters so they can be tested with mocks.
- Validate persisted and imported module metadata at boundaries (hand-written validators or a small schema library).
- Register hooks once; clean up listeners on app close; avoid render loops; never load full packs to browse.
- Async errors produce one clear notification and one console diagnostic; no console flooding.
- Entry point registers settings, hooks, a scene-controls or sidebar button (GM only), and Quench tests if Quench is active.

## 11. Tests and acceptance

Vitest (pure and mocked integration) plus Quench (in-Foundry, manual), plus a documented manual test matrix in `docs/MANUAL-TESTS.md`. Every case below names its layer.

1. (Vitest) Four same-level PCs yield standard budgets for every tier.
2. (Vitest) Five level-4 PCs → Moderate 100 XP; two level-4 + one level-2 creatures = 100 XP, complete, inferred Moderate.
3. (Vitest, mocked) Participation toggles and level changes update evaluation.
4. (Vitest) Mixed levels block evaluation until a policy is chosen; no active PCs, missing UUIDs, and invalid overrides are surfaced.
5. (Vitest) Every relative level −4..+4 gives correct XP; −5 and +5 produce incomplete evaluation with the right labels.
6. (Vitest) Small parties: Low for one PC is unavailable; budgets ≤ 0 are never passed to the generator.
7. (Vitest) Inferred-threat algorithm boundaries (exactly at each tier, one XP above, beyond Extreme, above-+4 creature).
8. (Vitest, mocked) Search/add uses indexes only and never calls import or document creation.
9. (Vitest) Generator: exact, near-fit, under-budget, impossible, locked-over-budget, empty catalog, and enumeration cap all terminate with the correct outcome.
10. (Vitest) Seeded generation is reproducible; property test over random seeds/inputs that every hard constraint holds in every success.
11. (Vitest, mocked Roll) Range-mode and weight-mode tables resolve with their intended semantics.
12. (Vitest, mocked Roll) Multi-creature results and quantity dice resolve correctly.
13. (Vitest) Classic outcomes are unchanged even when beyond Extreme.
14. (Vitest) Balanced variants keep the original outcome and produce a correct diff.
15. (Vitest) Nested tables, cycles, depth limit, missing UUIDs, invalid/disallowed formulas, and excessive quantities fail safely with traces.
16. (Vitest) Narrative and none results create no creatures and can't be deployed.
17. (Quench) Repeated module rolls don't change `drawn` state, don't post chat, and don't exhaust a no-replacement table.
18. (Vitest + Quench) Saved recipes survive reload and migrations; recalculation keeps the original snapshot.
19. (Vitest, mocked + Quench) Reuse matches by compendium source only, not names; fresh copies preserve provenance.
20. (Quench) Identical deployed NPC tokens have independent HP and conditions.
21. (Quench) Adding to combat doesn't start combat or roll initiative.
22. (Quench, as a player) Non-GMs can't open the builder or perform protected writes; module documents aren't visible to players.
23. (Vitest, mocked) Partial deployment failures are reported exactly; cleanup removes only operation-created documents.
24. (Review) No creature content is bundled; ORC rule constants carry the ORC notice and attribution; no Reserved Material is used; source compendiums are never written to.
25. (Quench) Where the PF2e XP helper exists, module totals match it for standard rules.

Record the actual Foundry build and PF2e version for every Quench/manual run. Do not mark runtime cases as passed without that record.

## 12. Milestones and workflow

Work in this order. At the end of each milestone, run build, lint, typecheck, and tests, fix failures, update docs, and commit with a descriptive message. A milestone is done only when its listed tests exist and pass (Vitest) or are written and documented for manual runs (Quench).

1. **Foundations:** verify versions and data paths (§0), add the ORC notice and attribution (§0.2), write `docs/VERIFICATION.md` and versioned schema definitions, scaffold toolchain, `module.json`, localization, and `EncounterBudget` with tests 1, 2, 5, 6, 7.
2. **Party and catalog:** `PF2eAdapter`, `PartyService`, `CreatureCatalog`, manual mode UI. Tests 3, 4, 8, 25.
3. **Generator:** `EncounterGenerator` and balanced mode UI. Tests 9, 10.
4. **Deployment:** `DeploymentService`, preview, placement, combat. Tests 19–23.
5. **Tables:** `TableResolver`, `EncounterTableEditor`, table mode, policies, balanced variant. Tests 11–17.
6. **Persistence:** `EncounterRepository`, saved recipes, tags store, migrations. Test 18.
7. **Wrap-up:** README (installation, party setup, compendium selection, table authoring, saving, deployment, inferred-threat algorithm, known limitations), `docs/MANUAL-TESTS.md`, test 24 review.

Continue through all milestones unless a concrete environment blocker prevents it. Ask questions only for genuine blockers; otherwise make conservative, documented decisions.

**Final report:** implemented features per milestone, actual test results (with command output summary), the target versions and how they were verified, remaining limitations, and exact runtime verification steps.

## 13. Deferred (do not build or display)

Hazards, elite/weak transformations, automatic scheduled regional checks, advanced conditional table rules, XP awards. Keep extension points clean (e.g. the budget functions accept a hazards list that is always empty), but show no nonfunctional controls and do not describe these as completed.
