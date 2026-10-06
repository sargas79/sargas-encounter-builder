# Sargas - Encounter Builder

A GM encounter workspace for the Pathfinder Second Edition system on Foundry VTT: pick a party, choose a
threat, and get a themed, budget-fitting encounter in one click — or build it by hand, roll it from a
regional table, or reopen a saved one. Then import, place tokens and (optionally) add them to combat with
one explicit action.

- Module id: `sargas-encounter-builder` · Title: _Sargas - Encounter Builder_
- Requires Foundry VTT 14 and the PF2e system (8.x). GM only.
- No creature content is bundled: creatures come from the compendiums installed in your world.

## What it does

- **Party first.** The start dialog asks for the party (PF2e Party actors first), the threat, the policy for
  mixed levels, and how you want to build. Nothing else opens until the party resolves to a valid reference
  level; the party strip at the top keeps all of it one click away.
- **Themed generation.** Random encounters are built _inside a theme_ (undead, fey, goblins, a forest
  environment tag, or a theme you authored) with a shape — pack, warband, boss + minions, mixed patrol, lair —
  and always fit the XP budget. Hard constraints are never loosened; the only relaxation is an "outsider
  boss" above themed minions.
- **Manual building** from an index-only compendium catalog with portraits, traits, rarity, tags and a live
  threat meter.
- **Classic encounter tables** on native RollTables: dice ranges or weights, creature groups with dice
  quantities, narrative results, nested tables with cycle protection, encounter checks, a full resolution
  trace, and policies that never scale a classic result silently.
- **Treasure** from GM Core Table 10-9: the party's budget for the encounter (its XP share of a level), a
  whole level, or any share; rolled from the equipment compendium into a Loot actor, an actor you point at,
  or a GM chat card.
- **Saved encounters** as GM-private journal entries with an evaluation snapshot that is never overwritten
  silently.
- **Deployment** that reuses world actors by compendium source, places unlinked hidden tokens on a spiral,
  optionally adds them to a combat it never starts, and can clean up exactly what it created.

## Requirements

|             |                                                                                     |
| ----------- | ----------------------------------------------------------------------------------- |
| Foundry VTT | 14                                                                                  |
| System      | Pathfinder Second Edition 8.0.0 or later                                            |
| Optional    | [Quench](https://foundryvtt.com/packages/quench) to run the in-Foundry test batches |

## Installation

In Foundry's _Add-on Modules_ → _Install Module_, paste this manifest URL:

```
https://github.com/sargas79/Sargas-encounter-builder/releases/latest/download/module.json
```

Releases are on the [GitHub releases page](https://github.com/sargas79/Sargas-encounter-builder/releases).

**Upgrading from 0.1.0 (`pf2e-encounter-builder`).** That id is also used by an unrelated module on the
Foundry package registry, so Foundry's updater fetches the wrong package for it. Uninstall
`pf2e-encounter-builder`, install this module from the manifest URL above, and open the world once as GM:
saved encounters, tags and tables are copied forward automatically.

From source: `npm ci && npm run build`, then copy `module.json`, `dist/`, `lang/`,
`styles/` and `templates/` into `Data/modules/sargas-encounter-builder/`.

## Usage

### Opening

Click the dragon in the token controls or the **Encounter Builder** button in the Actors sidebar header.
Both open the **New encounter** dialog:

1. **Party** — a PF2e Party actor (auto-selected when there is exactly one), a saved standalone profile, or
   a new profile.
2. **Threat** — Trivial to Extreme; the target budget follows the party size.
3. **If levels differ** — average rounded down (labeled as an estimate), highest, lowest, or a manual level.
4. **Mode** — Generate, Browse, Table, or Saved.

The party strip stays at the top: click the party name to reopen the dialog, click a threat segment to
change it. Build, Tables and Deploy are disabled until the party resolves.

### Party

- **Party actors** mirror the PF2e Party actor live; toggle participation per member without editing the
  actor. Familiars and companions are listed but not counted. An NPC ally counts only if you switch the
  "count as party member" override on.
- **Standalone profiles** hold character actors you add by drag-and-drop or the picker.
- Missing or inaccessible actors are flagged, never dropped.

### Build → Generate

Pick a **Theme** ("Surprise me" chooses one that fits) and a **Shape**, then **Generate**. **Reroll** keeps
the theme and shape; **Re-theme** keeps the shape and picks another theme. Lock creatures you like: the
theme is then inferred from them, and **Replace** rerolls a single row. **Advanced** exposes relative level
bounds, creature count bounds, duplicate cap, seed, and the outsider-boss toggle.

Themes are derived from the selected compendiums: by creature type (undead, fey…), by type + sub-theme
(goblin, ghoul, or your `family:` tags), and by `environment:` tags. **New theme** stores your own: required
traits, "any of" traits, an environment tag, explicit creature UUIDs, notes.

Shapes: **Any** (whatever fits), **Pack** (one creature × N), **Warband** (a leader above 2+ troops),
**Boss + minions** (boss 2+ levels above minions, boss may be an outsider), **Mixed patrol** (2–5 different
creatures within two levels), **Lair** (one creature).

### Build → Browse

Search, filter by relative level, traits, tags and rarity, press **Add** (or Enter for the first match).
**Inspect** opens the compendium sheet; nothing is imported by browsing. Open the compendium picker (book
icon) to change source packs — all PF2e bestiaries are selected the first time.

### The threat meter

The bar shows supported XP against the five tiers with your target marked. "Reads as" is the inferred
threat: the lowest tier whose budget covers the total, _Beyond Extreme_ above it, and _(unquantified)_ when
any creature is more than 4 levels above the party. Creatures outside −4..+4 are not counted or clamped;
the meter says _incomplete_ instead.

### Treasure

Pick the award: **This encounter** (the draft's XP out of the ~1,000 XP a level takes, so a Moderate fight
earns 8% of the level's treasure), **Whole level**, or a **Custom share**. **Treasure level** defaults to the party's reference level and can be set to any level 1 to
20 (a hoard from a higher-level foe, or a lower one for a side cache). The budget card shows total
value, currency (scaled by party size), and the expected permanent and consumable item slots by item
level. Options: uncommon and rare items, consumables, preferring the encounter theme's traits, a share of
the coins as gems and art objects, a seed, and item categories to exclude.

**Generate treasure** fills slots from `pf2e.equipment-srd` without ever exceeding the total; a slot can
relax by up to two item levels; whatever is left becomes coins. Rows can be locked (kept on reroll),
replaced or removed. Outputs: **Loot actor** (in "Encounter Builder: Treasure", no player ownership until
you grant it), **Add to actor** (a selected token's actor, or pick one), **Chat** (whispered to GMs).
Treasure is stored with a saved encounter and re-settled against the current party when reopened.

### Tables

Pick or create a RollTable and roll it with the module resolver (no chat message, nothing marked drawn,
nothing imported). The editor configures each row: creatures (fixed or dice quantities), another table,
narrative, no encounter, or a party-scaled template; dice ranges or weights; an encounter check; region /
terrain / season / time tags; GM notes and a journal link. Validation flags malformed formulas, overlaps,
gaps, missing references and cycles.

Policies: **Use as rolled** (classic, evaluated afterward), **Generate from template** (template rows
only), **Balanced variant** (a separate encounter built from the rolled creatures; the original stays in
the trace with a diff).

### Saved

**Save** stores the current encounter with its creatures, locks, notes, seed, theme, trace and an
evaluation snapshot. Reopen it, **Recalculate for current party** (shown beside the saved snapshot), update
it from the builder, rename, duplicate or delete.

### Deploy

Choose the scene, **reuse existing** (matched by compendium source, never by name) or **fresh copy**,
hidden or visible tokens, combat handling, and an origin on the canvas. Tokens are unlinked (independent
HP) and numbered. On partial failure you get the exact list and a cleanup that deletes only what the
operation created. Combat is never started and initiative never rolled.

## Budget rules

Target = `base + (party size − 4) × per-character adjustment` (Trivial 40/10, Low 60/20, Moderate 80/20,
Severe 120/30, Extreme 160/40). Tiers whose target is 0 or less for the party size are unavailable. Creature
XP by relative level: −4: 10, −3: 15, −2: 20, −1: 30, 0: 40, +1: 60, +2: 80, +3: 120, +4: 160. Construction
XP is not an award; the module never awards XP.

Treasure (GM Core Table 10-9): per party level, a total value, permanent and consumable item slots by item
level, party currency, and currency per additional PC. Currency scales with party size; item slots do not.
An encounter's share is its XP / 1,000.

Under **Proficiency Without Level** the module takes per-creature XP from `game.pf2e.gm.calculateXP` and
labels the evaluation as a system calculation; with **Debug mode** on it cross-checks standard totals
against the same helper.

## Settings

| Setting                                        | Default |
| ---------------------------------------------- | ------- |
| Encounter tables: maximum nesting depth        | 5       |
| Encounter tables: maximum creatures per entry  | 20      |
| Encounter tables: maximum creatures per result | 40      |
| Number duplicate tokens                        | on      |
| Debug mode                                     | off     |

## Permissions

Everything is GM only: the launchers are hidden from players, the application refuses to open for them,
and every write path re-checks `game.user.isGM`. Module documents (saved encounters, the data journal
holding tags and themes) are created with no player ownership.

## Project structure

```
src/core      pure logic: budget, catalog, draft, generator, themes, themed-generator, treasure, tables
src/foundry   adapters: PF2e data paths, party service, catalogs, deployment, treasure, tables, stores
src/apps      ApplicationV2 windows: builder, start dialog, panels, table editor
templates/    Handlebars parts and partials      styles/   Nocturne stylesheet
tests/        Vitest (unit + mocked)             src/quench/  in-Foundry batches
docs/         VERIFICATION.md, MANUAL-TESTS.md, implementation prompt
```

## Compatibility and status

- Unit and mocked tests: `npm test`; coverage report (text + `coverage/index.html`): `npm run test:coverage`.
  Lint, typecheck, format check and build run in CI on every push.
- Runtime in Foundry: run the Quench batches and `docs/MANUAL-TESTS.md` on your Foundry 14 + PF2e 8
  world, then record versions in `docs/VERIFICATION.md`. `compatibility.verified` is set only after that.
- Not implemented (no controls shown): hazards, elite/weak adjustments, scheduled regional checks,
  conditional table rules, XP awards, treasure for new characters (Table 10-10).

## Design

Shares the "Nocturne" dark palette and component conventions of the other Sargas modules: scoped `--seb-*`
tokens, tinted primary buttons, eyebrow section titles, 34px portraits, pills, empty states, custom
checkboxes, `prefers-reduced-motion` and visible focus.

## License

Code, templates, styles, tests and documentation: MIT (`LICENSE`). The encounter-building and treasure
mechanics in `src/rules/encounter-tables.ts` and `src/rules/treasure-tables.ts` are ORC Licensed Material
from _Pathfinder GM Core_; see `LICENSE-ORC.md`.
No Paizo Reserved Material is included; example names in tests and docs are invented.
