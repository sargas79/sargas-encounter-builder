# ORC Notice

> **TODO (maintainer):** the notice wording below was written without access to the official ORC License
> text (paizo.com and azoralaw.com were unreachable from the build environment). Before the next release,
> compare the notice paragraph and the Reserved Material / Expressly Designated Licensed Material sections
> with the official text at <https://paizo.com/orclicense>, correct any differences, then delete this note.
> Tracked in `docs/VERIFICATION.md` §4 item 7.

This product is licensed under the ORC License located at the Library of Congress at TX 9-307-067
and available online at various locations including <https://paizo.com/orclicense>,
<https://azoralaw.com/orclicense>, <https://gencon.com/orclicense> and others. All warranties are
disclaimed as set forth therein.

## Attribution

This product is based on the following Licensed Material:

- _Pathfinder GM Core_ © 2023, Paizo Inc. Authors: Logan Bonner, Mark Seifter, Amirali Attar Olyaee,
  Jason Bulmahn, Nathaniel Deming, Jesse Decker, Eleanor Ferron, Tim Hitchcock, Erik Keith, Laura Mohlman,
  Shay Snow, Alex Speidel, and Tabitha Thompson.

## Scope of Licensed Material in this repository

The only Licensed Material reproduced in this repository is the set of game mechanics in `src/rules/`:

- `encounter-tables.ts`: the encounter XP budgets by threat level, the per-character budget adjustment,
  and the creature XP values by level relative to the party.
- `treasure-tables.ts`: the party treasure by level (total value, permanent and consumable item slots by
  item level, party currency, and currency per additional PC).

If you use or adapt the Licensed Material in this repository, you must include this ORC Notice (or the
equivalent notice from the license) and the attribution above.

## Reserved Material

Reserved Material elements in this product include, but may not be limited to: all trademarks, registered
trademarks, proper nouns (characters, deities, locations, etc., as well as all adjectives, names, titles, and
descriptive terms derived from proper nouns), artworks, characters, dialogue, locations, organizations, plots,
storylines, and trade dress. This repository does not intentionally include any Reserved Material. The
example creature names used in documentation and tests are invented.

## Expressly Designated Licensed Material

This product contains no Expressly Designated Licensed Material beyond the mechanics named above.

## Separation from the MIT-licensed code

All other files in this repository (TypeScript sources, templates, styles, tests, documentation) are
licensed under the MIT License in `LICENSE`. The ORC License applies only to the game mechanics identified
above.
