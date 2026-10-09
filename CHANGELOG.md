# Changelog

## 0.4.2

Development only; no change to the module's behaviour.

- ESLint upgraded from 9 (no longer supported) to 10. Its new `no-useless-assignment` rule flagged one
  redundant initial value in the table editor, now removed.
- The test-only Handlebars dependency is updated to clear a new security advisory (`npm audit` is clean).
  Foundry's own Handlebars renders the module's templates, so released builds were not affected.

## 0.4.1

- The Browse catalog is no longer cut off at 200 creatures. The header shows the full match count (for example
  "200 / 734") and a Show more button at the end of the list loads the next 200. Changing a filter starts
  again from the first page.
- The generator's relative-level bounds now default to -2 / +2, like Browse. Any combination within -4..+4
  can still be chosen.

## 0.4.0

Accessibility, layout and internal restructuring:

- Party, profile and saved-encounter lists work from the keyboard (Tab, then Enter or Space).
- Tabs follow the standard pattern: arrow keys, Home and End move between them, and screen readers announce
  each tab and its panel. Form fields, table-editor row inputs and button groups have accessible names.
- Treasure category chips are keyboard-reachable and show a focus outline.
- Header messages can be dismissed; info and success messages clear after about 8 seconds.
- Picking the deploy origin can be cancelled with Escape or a Cancel button, no longer selects tokens, and is
  cancelled with a warning if the viewed scene changed.
- The builder window can be made narrower; its layout stacks in small windows.
- New actor-type labels (vehicle, army, unknown). Journal summaries, ledger labels and module folder and
  journal names are translatable; existing folders are still found.
- Internal: the builder window is split into typed panels (Party and Catalog added), dialogs and view models
  have their own modules, template-callable panel methods are whitelisted, duplicated code and dead handlers
  are removed, colours are CSS tokens, and tests check template actions and localization keys.

## 0.3.6

Performance, stability and rules edge cases:

- Combat updates to creatures outside the party no longer refresh the builder or wipe fields you are typing in.
- Only the panels being shown are prepared and redrawn; opening the builder, toggling packs and the first
  render no longer draw the window twice.
- Custom tags and themes pick up edits from other GMs or tabs, saving no longer overwrites them, and two
  simultaneous first saves no longer create two data journals.
- Drop-zone highlighting no longer flickers or stacks listeners.
- Data migrations run only on the active GM's client.
- Generator level and count fields show the corrected value immediately; a minimum above the maximum moves
  the other bound.
- Dice formulas no longer join numbers across spaces ("1 2d6" is an error, not 12d6).
- Tables report overlaps hidden behind a wide row (1–10 with 5–6) without false gaps, and warn on weights
  below 1, which can never be rolled.
- With Proficiency Without Level, creatures the system cannot price are flagged and the evaluation is marked
  incomplete instead of counting 0 XP.
- The large-party warning appears without a selected threat.
- The Lair archetype no longer fails when the minimum count is above 1.
- Treasure can fall back to level-0 items for low-level slots.
- Deployment refuses hex-grid scenes (gridless still deploys with a warning).
- Reusing world actors ignores sidebar duplicates, prefers actors the module imported, then the oldest, and
  also matches legacy `flags.core.sourceId`.
- Deployed tokens are built through the actor's token document, so wildcard token images work.
- "Add to actor" merges coins into the actor's existing coins.
- Deployment failures and the GM treasure chat card are localized.

## 0.3.5

Correctness and data-safety fixes from a full review:

- Generator: encounters with a minimum or maximum number of different creatures (packs, warbands, mixed
  patrols) no longer fail at random with "no feasible composition" when a valid encounter exists.
- Themed generator: keeps looking for the closest fit instead of taking the first acceptable one. Packs try
  other creatures, auto-theme tries other themes, and boss + minions tries an outsider boss before
  settling for an under-budget result. Theme constraints are still never loosened.
- Deploy cleanup asks for confirmation, keeps an imported actor that other tokens now use, and keeps a
  created combat that gained other combatants (removing only the deployment's own). Kept items are listed.
- Saved encounters: updating one rewrites only the module's own summary page, never the GM's notes.
- Table editor: template candidates show raw UUIDs (names appear in a hint below) so saving no longer
  corrupts them; "Derive ranges" also saves native rows; reopening keeps unsaved edits; closing with unsaved
  changes asks first.
- Security: saved-encounter names are escaped in the update and delete dialogs.
- Damaged table flags, recipes and custom themes are repaired on load instead of crashing table validation
  or silently never triggering an encounter check.
- Release zips link their own version's download, ship without sourcemaps, and declare Foundry 14 as the
  maximum compatible version. Quench batches register on `quenchReady`.
- Development: releases fail if tag, `package.json` and CHANGELOG disagree; CI runs the format check;
  `--legacy-peer-deps` is gone; `npm run test:coverage` added.

## 0.3.4

- Threat meter: tier labels that would overlap (Low and Moderate at narrow widths) now drop onto a
  second row instead of drawing over each other.

## 0.3.3

- Build › Browse: typing in the search box no longer drops or garbles characters. A search now updates
  the catalog rows in place while the box has focus instead of re-rendering the whole panel under the
  caret.

## 0.3.2

Review fixes for the treasure generator:

- Coins are recognised by price, not by English name, so translated compendiums still get their coins.
- A damaged treasure record no longer hides the whole saved encounter; it is dropped on load instead.
- Replacing a gem stays inside the gems-and-art share instead of spending the purse.
- A hoard rolled for one encounter is cleared (encounter mode) or flagged (other modes) when the draft
  is replaced, so it is not saved onto an unrelated encounter.
- Saved treasure restores its award mode; small shares no longer show 0%.
- The equipment index loads in the background with a visible state when the tab opens, and refreshes
  when the compendium changes.
- Items priced per stack (ammunition) are budgeted at the stack value that is actually awarded.
- Parties smaller than four show "below four" currency wording.

## 0.3.1

- Treasure: the GM can choose the treasure level (1 to 20) instead of the party's reference level. The
  choice is stored with saved encounters.

## 0.3.0

- **Treasure tab.** GM Core Table 10-9 budgets for the current party: this encounter's XP share of a
  level, a whole level, or a custom share. Seeded generation from the PF2e equipment compendium fills
  permanent and consumable slots without exceeding the total; the rest becomes coins (optionally gems and
  art objects). Rarity, consumables, theme-trait preference and category exclusions are options. Rows can
  be locked, replaced or removed. Outputs: a Loot actor, items added to an actor, or a GM chat card.
  Treasure is saved with the encounter and re-settled against the party when reopened.
- `LICENSE-ORC.md` now covers `src/rules/treasure-tables.ts`.

## 0.2.4

- Fixed: Generate (and any action that posts a message or warning) failed with "Template part
  'header' must render a single HTML element". The header part now has one root element; a test
  renders every part template in both empty and fully populated states and asserts a single root.

## 0.2.3

- Fixed: the workspace opened stuck at the top-left corner, with an empty Build tab, "0 compendiums"
  in the footer, and could not be closed. The first render awaited a nested render from inside
  `_onFirstRender`; ApplicationV2 serialises renders, so the window never finished rendering. Pack
  selection and party resolution now happen before the first render, and lifecycle hooks no longer
  await renders.

## 0.2.2

- Fixed: the launchers (dragon tool in the Token controls, button in the Actors sidebar header) did not
  appear on first load. Their hooks were registered after Foundry had already rendered the scene
  controls; they are now registered at `init`, and the controls are redrawn on `ready`.

## 0.2.1

- **Upgrading from 0.1.0.** The old id `pf2e-encounter-builder` is also used by an unrelated module on
  the Foundry package registry, so Foundry's updater fetches that package instead of ours. Uninstall
  `pf2e-encounter-builder` and install this module from its manifest URL (see README).
- The one-time migration that copies 0.1.0 data forward now validates every record and skips entirely
  when a module by another author is installed under the old id, so foreign data is never imported.

## 0.2.0

- Renamed the module to `sargas-encounter-builder` ("Sargas - Encounter Builder"). A migration copies
  saved encounters, tags and table metadata from the 0.1.0 flag namespace; world settings (party
  profiles, selected packs) are not carried over and are set up again by the start dialog.
- Targets Foundry VTT 14 and PF2e 8.x.
- Party-first flow: a start dialog asks for party, threat and mode; Build, Tables and Deploy are gated
  until the party resolves.
- Themed random generation: encounters are built inside a creature theme (type, family, environment),
  with archetypes (pack, warband, boss and minions, mixed patrol, lair) and GM-authored themes.
- Visual rebuild in the shared "Nocturne" style used by the other Sargas modules.

## 0.1.0

- First release: party profiles, budgets, compendium catalog, balanced generation, classic encounter
  tables, saved encounters, deployment.
