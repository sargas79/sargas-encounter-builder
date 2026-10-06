# Manual and in-Foundry test matrix

Record the environment for every run. Do not mark a case passed without it.

| Field               | Value |
| ------------------- | ----- |
| Foundry VTT build   |       |
| PF2e system version |       |
| Module version      |       |
| Quench version      |       |
| Tester / date       |       |

## A. Quench suites (automated inside Foundry)

1. Install and enable [Quench](https://foundryvtt.com/packages/quench).
2. Log in as a GM, open a scene, and open the Quench panel (sidebar dice icon → Quench).
3. Select all `PF2e Encounter Builder` batches and run. Each batch records the versions in its first test.

| Batch              | Cases                                                                                    | Needs                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| system integration | T25 (XP helper cross-check), PWL setting, `actor.level`, Party actor members, runtime T8 | a world with PF2e; a Party actor and a bestiary compendium make more cases run                           |
| deployment         | T19, T20, T21, T22                                                                       | an accessible bestiary compendium and a viewed scene; creates and deletes temporary actors/tokens/combat |
| tables             | T17, grammar rejection                                                                   | creates and deletes a temporary RollTable                                                                |
| persistence        | T18, tag store                                                                           | creates and deletes a temporary Journal Entry                                                            |

Run the **deployment** batch a second time logged in as a **player**: T22 must report that the builder refuses to open and writes are refused (open the Actors sidebar: no button is shown; `game.modules.get("sargas-encounter-builder")` exposes nothing writable).

## B. Manual cases

| #   | Case                        | Steps                                                                                                                                            | Expected                                                                                                                                  | Result |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Launcher                    | As GM open the Actors sidebar                                                                                                                    | "Encounter Builder" button present; as a player it is absent                                                                              |        |
| M2  | Linked party                | Party tab → select a PF2e Party actor → Link                                                                                                     | Members listed live with levels; toggling participation changes "Participating" and the target budget in the header                       |        |
| M3  | Mixed levels (T4)           | Party with two different levels                                                                                                                  | Red blocker "choose a policy"; evaluation disabled until a policy is chosen; "average rounded down" is labeled estimate                   |        |
| M4  | Missing actor (T4)          | Add an actor to a standalone profile, delete the actor                                                                                           | Row shown as missing; still listed; not counted                                                                                           |        |
| M5  | Level change (T3)           | Change a counted character's level on its sheet                                                                                                  | Header and evaluation update without reopening                                                                                            |        |
| M6  | Catalog (T8)                | Select a bestiary pack, search, add                                                                                                              | No world actor is created; Inspect opens the compendium sheet read-only                                                                   |        |
| M7  | Out-of-range                | Add a creature 6 levels above the party                                                                                                          | Row marked "above +4", evaluation incomplete, inferred "Beyond Extreme (unquantified)"                                                    |        |
| M8  | Generator (T9/T10)          | Generate Moderate with a seed; regenerate with the same seed                                                                                     | Same result; hard constraints visible in the result; impossible constraints give a reason                                                 |        |
| M9  | Replace one                 | Lock two entries, Replace the third                                                                                                              | Locked entries unchanged, third replaced                                                                                                  |        |
| M10 | Table editor                | Create a table, add rows: none 1–30, creatures 31–50 (`1d4+1`), patrol 51–65 (two creatures), tracks 66–80, discovery 81–95, nested table 96–100 | Validation passes; native result text shows readable summaries when the table is opened natively                                          |        |
| M11 | Overlap / gap               | Set two rows to overlapping ranges, then leave a gap                                                                                             | Error (save blocked) / warning                                                                                                            |        |
| M12 | Quantity grammar            | Enter `1d4+@abilities.str.mod` as a quantity                                                                                                     | Rejected with an error                                                                                                                    |        |
| M13 | Roll (T11/T12/T16)          | Roll the table several times                                                                                                                     | Trace shows the die, matched row, quantity rolls; narrative rows produce no creatures; no chat messages appear; no result is marked drawn |        |
| M14 | Classic too dangerous (T13) | Table with a level-15 creature, party level 1, Use as rolled                                                                                     | Creature loaded unchanged, evaluation says Beyond Extreme                                                                                 |        |
| M15 | Balanced variant (T14)      | Create balanced variant from M14                                                                                                                 | New encounter from the rolled creatures; variant diff shown after saving                                                                  |        |
| M16 | Cycle (T15)                 | Table A → B → A                                                                                                                                  | Roll stops with "cycle detected"; editor validation shows the cycle                                                                       |        |
| M17 | Encounter check (T15/T16)   | Table with check `1d6` on `1`; roll repeatedly                                                                                                   | "No encounter" when the check fails, no table roll in the trace                                                                           |        |
| M18 | No-replacement (T17)        | Table with replacement off; roll 10 times from the module                                                                                        | No result marked drawn; native Draw still works afterwards                                                                                |        |
| M19 | Save / reload (T18)         | Save an encounter, reload the world, open it                                                                                                     | Entries, notes, seed and saved evaluation intact; journal entry not visible to players                                                    |        |
| M20 | Recalculate (T18)           | Change the party, Recalculate                                                                                                                    | Saved snapshot unchanged until "Update saved evaluation" is confirmed                                                                     |        |
| M21 | Reuse (T19)                 | Deploy with "reuse"; deploy again                                                                                                                | Second run reuses the imported actor; a same-named actor without compendium source is not matched                                         |        |
| M22 | Independent HP (T20)        | Deploy 3 copies, damage one                                                                                                                      | Others unaffected; tokens unlinked                                                                                                        |        |
| M23 | Combat (T21)                | Deploy with "new combat"                                                                                                                         | Combat exists, not started, no initiative                                                                                                 |        |
| M24 | Partial failure (T23)       | Lock the destination scene so token creation fails (e.g. deploy to a scene with no room near the origin)                                         | Exact failure list; Cleanup removes only created documents                                                                                |        |
| M25 | Hex scene                   | Deploy on a hex grid                                                                                                                             | Warning shown; tokens placed; positions sensible                                                                                          |        |
| M26 | Non-GM (T22)                | As a player: no launcher; `game.settings.set("sargas-encounter-builder", …)` is refused by the server                                            | Writes refused                                                                                                                            |        |
| M27 | Debug cross-check (T25)     | Enable Debug mode, build a standard encounter                                                                                                    | No mismatch message; console shows none                                                                                                   |        |
| M28 | PWL                         | Enable Proficiency Without Level                                                                                                                 | Header shows the variant; evaluation labeled as system calculation (or unsupported if the helper is missing)                              |        |

## B2. 0.2.0 additions (flow, themes, style)

| #   | Case              | Steps                                                                | Expected                                                                                                                                                                    | Result |
| --- | ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M29 | Start dialog      | Click the dragon tool or the sidebar button                          | Dialog with party (Party actors first), threat segments, level policy, four mode cards; Start opens the workspace on the chosen tab                                         |        |
| M30 | Gating            | Start with a new empty standalone profile                            | Build/Tables/Deploy tabs disabled with a tooltip; Party tab shown; adding a character enables them                                                                          |        |
| M31 | Party strip       | Click the party name / a threat segment                              | Dialog reopens / target budget updates everywhere                                                                                                                           |        |
| M32 | Default packs     | Fresh world, open the builder                                        | All PF2e bestiary compendiums pre-selected; footer shows indexed creature count                                                                                             |        |
| M33 | Themed generation | Generate with "Surprise me", Any                                     | Every creature shares the theme shown in the result pill; reroll keeps the theme; Re-theme changes it                                                                       |        |
| M34 | Shapes            | Generate Pack / Warband / Boss + minions / Mixed patrol / Lair       | Shapes hold: pack = one stat block ×N; warband = one leader above ≥2 troops; boss ≥2 above minions (outsider boss flagged); patrol 2–5 distinct within two levels; lair = 1 |        |
| M35 | Locked theme      | Lock a goblin, Generate with Surprise me                             | Theme inferred from the lock; other creatures are goblins/humanoids                                                                                                         |        |
| M36 | Custom theme      | New theme with required trait `undead` and one explicit UUID         | Appears under "Your themes"; generation stays inside it; delete removes it                                                                                                  |        |
| M37 | Exclude           | Ban icon on a catalog row and on a draft row                         | Creature removed from the draft and never generated; chip under the generator allows it again                                                                               |        |
| M38 | Look & feel       | Compare with Wondrous Spellbook side by side                         | Same dark palette, violet accent, segments, pills, empty states; readable under Foundry light theme                                                                         |        |
| M39 | Table editor      | Open the editor                                                      | Rows as cards, native rows read-only, validation badges inline                                                                                                              |        |
| M40 | Treasure          | Open the Treasure tab with a level-5 party of 4 and a Moderate draft | Budget card: 108 gp total (8% of 1,350), 25.6 gp currency, slots L6/L5 × 0.16; tab gated until the party resolves                                                           |        |
| M41 | Treasure          | Switch to Whole level                                                | 1,350 gp total, 320 gp currency, permanent L6 × 2, L5 × 2; consumables L6/L5/L4 × 2                                                                                         |        |
| M42 | Treasure          | Party of 6, Whole level                                              | Currency 480 gp (320 + 2 × 80); item slots unchanged                                                                                                                        |        |
| M43 | Treasure          | Generate with a seed, then again with the same seed                  | Identical rows and coins; trace lists every slot decision; items + coins never exceed the total                                                                             |        |
| M44 | Treasure          | Lock a row, Reroll                                                   | Locked row kept; other rows change; coins re-settle                                                                                                                         |        |
| M45 | Treasure          | Replace and Remove a row                                             | Replace swaps the same kind/slot within budget (or warns); Remove returns its value to coins                                                                                |        |
| M46 | Treasure          | Loot actor                                                           | Actor of type loot in "Encounter Builder: Treasure" with the items and coin stacks; default ownership None; sheet opens                                                     |        |
| M47 | Treasure          | Add to actor with a token selected                                   | Picker lists the selected token's actor first; confirmation; items and coins appear in its inventory                                                                        |        |
| M48 | Treasure          | Chat                                                                 | Whispered card to GMs with @UUID links, coins and totals; players see nothing                                                                                               |        |
| M49 | Treasure          | Save the encounter, reopen it                                        | Treasure restored with its seed and rows; missing compendium items reported, not silently dropped                                                                           |        |
| M50 | Treasure          | Uncheck "Allow uncommon", exclude Weapons                            | No uncommon items, no weapons in the result                                                                                                                                 |        |

## B3. 0.3.5–0.4.0 review fixes (need a live Foundry session)

- Deploy with "new combat", add a PC to that combat, Cleanup: confirm dialog appears; the combat and the PC
  combatant are kept, only deployed combatants are removed. Drag an extra copy of an imported actor onto the
  scene, Cleanup: that actor is kept and listed.
- Deploy on a hex scene: blocked. On a gridless scene: deploys with a warning.
- Actor with a wildcard token image (`randomImg`): deployed tokens get real images.
- Treasure "add to actor" on a PC that already has gold: coins are added to the existing stacks.
- Saved encounter with an extra GM journal page placed first: updating rewrites only the Summary page.
- Table editor: candidates field keeps UUIDs after save; "Derive ranges" on a mixed native/configured table
  saves without overlaps; closing with edits asks first; reopening keeps edits.
- During combat with the builder open and a seed typed (not blurred), damage an NPC: the field keeps its text.
- Two GM tabs: tag a creature in each; both tags survive.
- Keyboard: Tab to party/saved rows and press Enter; arrow keys across tabs; Tab to treasure chips.
- Deploy origin pick: Escape and Cancel stop it; the picking click does not select a token; switching scene
  mid-pick cancels with a warning.
- Info messages clear after ~8 s; warnings stay until dismissed. Narrow the window below 820 px: layout stacks.
- Quench batches appear even if a migration fails.

## C. Review items (T24)

- `git grep -i` for Paizo proper nouns in `src/`, `lang/`, `docs/`, `tests/`: none expected.
- No files under `packs/`; `module.json` declares no packs.
- `LICENSE-ORC.md` present; `src/rules/encounter-tables.ts` and `src/rules/treasure-tables.ts` carry the license header.
- Source compendiums: after a full session, compendium documents are unchanged (compare `_stats.modifiedTime`).

## D. Setting `compatibility.verified`

Only after sections A–C pass on a given build, set `module.json` → `compatibility.verified` to that exact
Foundry build and record it in `docs/VERIFICATION.md` §6.
