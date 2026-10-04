# Changelog

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
