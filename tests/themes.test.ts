import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compositionSatisfied, generateEncounter, hardConstraintViolations } from "../src/core/generator.js";
import { mulberry32 } from "../src/core/rng.js";
import {
  archetypeConstraints,
  archetypeCountRange,
  availableThemes,
  generateThemedEncounter,
  type ThemedCandidate,
} from "../src/core/themed-generator.js";
import {
  deriveThemes,
  inferThemeFromLocked,
  matchesTheme,
  primaryTraitOf,
  subTraitsOf,
  themePool,
} from "../src/core/themes.js";

function c(uuid: string, level: number, traits: string[], tags: string[] = []): ThemedCandidate {
  return { uuid, name: uuid, level, traits, tags };
}

/** A small invented bestiary with three clear themes plus noise. */
function bestiary(): ThemedCandidate[] {
  return [
    c("gob-warrior", 1, ["goblin", "humanoid"], ["environment:forest"]),
    c("gob-archer", 1, ["goblin", "humanoid"], ["environment:forest"]),
    c("gob-shaman", 2, ["goblin", "humanoid"]),
    c("gob-chief", 4, ["goblin", "humanoid"]),
    c("gob-dog", 1, ["animal"], ["environment:forest", "family:goblin-pets"]),
    c("ghoul", 1, ["ghoul", "undead"]),
    c("ghast", 2, ["ghoul", "undead"]),
    c("ghoul-lord", 5, ["ghoul", "undead"]),
    c("skeleton", 0, ["skeleton", "undead", "mindless"]),
    c("wight", 3, ["undead"]),
    c("necromancer", 5, ["human", "humanoid"]),
    c("wolf", 1, ["animal"], ["environment:forest"]),
    c("bear", 4, ["animal"], ["environment:forest"]),
    c("sprite", 1, ["fey", "sprite"]),
    c("dryad", 3, ["fey"], ["environment:forest"]),
    c("ooze", 2, ["ooze", "mindless"]),
  ];
}

describe("themes: derivation and membership", () => {
  it("classifies primary type and sub-themes, ignoring descriptor traits", () => {
    expect(primaryTraitOf(c("x", 1, ["goblin", "humanoid"]))).toBe("humanoid");
    expect(subTraitsOf(c("x", 1, ["goblin", "humanoid", "mindless", "evil"]))).toEqual(["goblin"]);
    expect(subTraitsOf(c("x", 1, ["animal"], ["family:goblin-pets"]))).toEqual(["family:goblin-pets"]);
    expect(primaryTraitOf(c("x", 1, ["weird"]))).toBeNull();
  });

  it("derives type, sub-theme and environment themes with member counts", () => {
    const themes = deriveThemes(bestiary());
    const ids = themes.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "auto:humanoid",
        "auto:humanoid/goblin",
        "auto:undead",
        "auto:undead/ghoul",
        "auto:animal",
        "auto:fey",
        "env:forest",
      ]),
    );
    expect(ids).not.toContain("auto:ooze"); // only one member
    expect(ids).not.toContain("auto:humanoid/human"); // below the sub-theme minimum
    const goblins = themes.find((t) => t.id === "auto:humanoid/goblin")!;
    expect(goblins).toMatchObject({
      size: 4,
      minLevel: 1,
      maxLevel: 4,
      primaryTrait: "humanoid",
      subTrait: "goblin",
    });
  });

  it("builds pools that only contain matching creatures", () => {
    const pool = themePool(
      deriveThemes(bestiary()).find((t) => t.id === "auto:undead")!,
      bestiary(),
    );
    expect(pool.map((p) => p.uuid).sort()).toEqual(["ghast", "ghoul", "ghoul-lord", "skeleton", "wight"]);
    const forest = themePool(
      deriveThemes(bestiary()).find((t) => t.id === "env:forest")!,
      bestiary(),
    );
    expect(forest.map((p) => p.uuid).sort()).toEqual([
      "bear",
      "dryad",
      "gob-archer",
      "gob-dog",
      "gob-warrior",
      "wolf",
    ]);
  });

  it("supports custom themes with required/any traits, environment and explicit uuids", () => {
    const customs = [
      {
        id: "cult",
        name: "Marsh cult",
        requiredTraits: ["undead"],
        anyTraits: [],
        environment: null,
        candidateUuids: ["necromancer"],
        notes: "",
      },
    ];
    const themes = availableThemes(bestiary(), customs);
    const cult = themes.find((t) => t.id === "custom:cult")!;
    const pool = bestiary().filter((x) => matchesTheme(x, cult, new Map(customs.map((k) => [k.id, k]))));
    expect(pool.map((p) => p.uuid).sort()).toEqual([
      "ghast",
      "ghoul",
      "ghoul-lord",
      "necromancer",
      "skeleton",
      "wight",
    ]);
  });

  it("infers a theme from locked creatures", () => {
    expect(
      inferThemeFromLocked([c("a", 1, ["ghoul", "undead"]), c("b", 2, ["ghoul", "undead"])]),
    ).toMatchObject({ primaryTrait: "undead", subTrait: "ghoul" });
    expect(inferThemeFromLocked([c("a", 1, ["ghoul", "undead"]), c("b", 2, ["undead"])])).toMatchObject({
      primaryTrait: "undead",
      subTrait: null,
    });
    expect(inferThemeFromLocked([c("a", 1, ["undead"]), c("b", 2, ["animal"])])).toBeNull();
    expect(
      inferThemeFromLocked([c("a", 1, ["aquatic", "fey"]), c("b", 2, ["aquatic", "animal"])]),
    ).toBeNull();
  });
});

describe("themed generation", () => {
  const party = { threat: "moderate" as const, partySize: 4, referenceLevel: 2 };

  it("keeps every creature inside the chosen theme (hard constraint)", () => {
    const result = generateThemedEncounter({
      ...party,
      candidates: bestiary(),
      theme: "auto:undead",
      archetype: "any",
      rng: mulberry32(3),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const e of result.entries) expect(e.traits).toContain("undead");
    expect(result.theme.id).toBe("auto:undead");
    expect(result.explanation).toContain("theme:auto:undead");
  });

  it("auto mode picks a theme that fits and never mixes themes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const result = generateThemedEncounter({
        ...party,
        candidates: bestiary(),
        theme: "auto",
        archetype: "any",
        rng: mulberry32(seed),
      });
      expect(result.ok, `seed ${seed}`).toBe(true);
      if (!result.ok) continue;
      const customs = new Map();
      for (const e of result.entries) {
        const cand = bestiary().find((b) => b.uuid === e.uuid)!;
        expect(matchesTheme(cand, result.theme, customs), `${e.uuid} in ${result.theme.id}`).toBe(true);
      }
    }
  });

  it("pack: one stat block, several copies", () => {
    const result = generateThemedEncounter({
      ...party,
      referenceLevel: 3,
      candidates: bestiary(),
      theme: "auto:animal",
      archetype: "pack",
      rng: mulberry32(5),
      maxCount: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.quantity).toBeGreaterThanOrEqual(3);
    expect(result.entries[0]!.traits).toContain("animal");
  });

  it("warband: one leader above 2+ troops, at least two stat blocks", () => {
    const result = generateThemedEncounter({
      ...party,
      threat: "severe",
      candidates: bestiary(),
      theme: "auto:humanoid/goblin",
      archetype: "warband",
      rng: mulberry32(8),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const levels = result.entries.flatMap((e) => Array<number>(e.quantity).fill(e.level));
    expect(
      compositionSatisfied(
        levels.map((l) => l - party.referenceLevel),
        "warband",
      ),
    ).toBe(true);
    expect(new Set(result.entries.map((e) => e.uuid)).size).toBeGreaterThanOrEqual(2);
    for (const e of result.entries) expect(e.traits).toContain("goblin");
  });

  it("boss with minions may take an outsider boss, and reports it", () => {
    // Ghouls alone cannot form boss+minions at moderate for level 2 (ghoul-lord +3 = 120 > 80), so the
    // solver falls back to an outsider boss above an undead minion pool.
    const result = generateThemedEncounter({
      ...party,
      threat: "extreme",
      candidates: bestiary(),
      theme: "auto:undead/ghoul",
      archetype: "bossMinions",
      rng: mulberry32(2),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const minions = result.entries.filter((e) => e.uuid !== result.outsider?.uuid);
    for (const m of minions) expect(m.traits).toContain("ghoul");
    expect(result.explanation.some((x) => x.startsWith("archetype:bossMinions"))).toBe(true);
  });

  it("fails explicitly when the theme pool cannot satisfy the archetype", () => {
    const result = generateThemedEncounter({
      ...party,
      candidates: bestiary(),
      theme: "auto:fey",
      archetype: "warband",
      rng: mulberry32(1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["noFeasibleComposition", "noCandidatesInLevelBounds"]).toContain(result.reason);
    expect(result.theme?.id).toBe("auto:fey");
  });

  it("reports unknown themes and empty catalogs", () => {
    expect(
      generateThemedEncounter({ ...party, candidates: bestiary(), theme: "auto:nope", archetype: "any" }),
    ).toMatchObject({ ok: false, reason: "themeNotFound" });
    expect(
      generateThemedEncounter({ ...party, candidates: [], theme: "auto", archetype: "any" }),
    ).toMatchObject({ ok: false, reason: "noThemes" });
  });

  it("locked entries infer the theme and are preserved", () => {
    const result = generateThemedEncounter({
      ...party,
      threat: "severe",
      candidates: bestiary(),
      theme: "auto",
      archetype: "any",
      locked: [{ uuid: "ghoul", name: "ghoul", level: 1, quantity: 1, traits: ["ghoul", "undead"] }],
      rng: mulberry32(4),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.kind).toBe("locked");
    expect(result.entries.find((e) => e.uuid === "ghoul" && e.locked)).toBeTruthy();
    for (const e of result.entries) expect(e.traits).toContain("undead");
  });

  it("is reproducible and respects base hard constraints (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100000 }),
        fc.constantFrom("any", "pack", "warband", "bossMinions", "mixedPatrol", "lair"),
        fc.constantFrom("trivial", "low", "moderate", "severe", "extreme"),
        fc.integer({ min: 1, max: 6 }),
        (seed, archetype, threat, referenceLevel) => {
          const input = {
            threat,
            partySize: 4,
            referenceLevel,
            candidates: bestiary(),
            theme: "auto" as const,
            archetype,
            rng: mulberry32(seed),
          };
          const a = generateThemedEncounter(input);
          const b = generateThemedEncounter({ ...input, rng: mulberry32(seed) });
          expect(a).toEqual(b);
          if (a.ok) {
            const pool = themePool(a.theme, bestiary());
            const outsider = a.outsider?.uuid;
            for (const e of a.entries) {
              if (e.uuid === outsider) continue;
              expect(
                pool.some((p) => p.uuid === e.uuid),
                `${e.uuid} outside ${a.theme.id}`,
              ).toBe(true);
            }
            expect(a.totalXP).toBeLessThanOrEqual(a.target);
          }
          return true;
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("generator: new compositions and distinct constraints", () => {
  it("warband and mixedPatrol rules", () => {
    expect(compositionSatisfied([2, 0, 0], "warband")).toBe(true);
    expect(compositionSatisfied([2, 2, 0], "warband")).toBe(false);
    expect(compositionSatisfied([2, 0], "warband")).toBe(false);
    expect(compositionSatisfied([1, 0, -1], "mixedPatrol")).toBe(true);
    expect(compositionSatisfied([2, -1], "mixedPatrol")).toBe(false);
    expect(compositionSatisfied([0, 0, 0, 0, 0, 0], "mixedPatrol")).toBe(false);
  });

  it("minDistinct / maxDistinct are enforced in the fill stage", () => {
    const pool = [
      { uuid: "a", name: "a", level: 2, traits: [] },
      { uuid: "b", name: "b", level: 2, traits: [] },
      { uuid: "c", name: "c", level: 2, traits: [] },
    ];
    const one = generateEncounter({
      threat: "moderate",
      partySize: 4,
      referenceLevel: 2,
      candidates: pool,
      maxDistinctCreatures: 1,
      rng: mulberry32(1),
    });
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.entries).toHaveLength(1);
      expect(
        hardConstraintViolations(
          { threat: "moderate", partySize: 4, referenceLevel: 2, candidates: pool, maxDistinctCreatures: 1 },
          one,
        ),
      ).toEqual([]);
    }
    const two = generateEncounter({
      threat: "moderate",
      partySize: 4,
      referenceLevel: 2,
      candidates: pool,
      minDistinctCreatures: 2,
      rng: mulberry32(1),
    });
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("review fixes (0.2.0)", () => {
  const party = { threat: "moderate" as const, partySize: 4, referenceLevel: 2 };

  it("archetype minimums win over a smaller user max count instead of failing with countRangeInvalid", () => {
    const result = generateThemedEncounter({
      ...party,
      referenceLevel: 3,
      candidates: bestiary(),
      theme: "auto:animal",
      archetype: "pack",
      maxCount: 2,
      rng: mulberry32(1),
    });
    expect(result.ok || result.reason !== "countRangeInvalid").toBe(true);
  });

  it("an excluded creature is never used as the outsider boss", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const result = generateThemedEncounter({
        ...party,
        threat: "extreme",
        candidates: bestiary(),
        theme: "auto:undead/ghoul",
        archetype: "bossMinions",
        excludeUuids: ["necromancer", "bear"],
        rng: mulberry32(seed),
      });
      if (result.ok) expect(result.entries.map((e) => e.uuid)).not.toContain("necromancer");
    }
  });

  it("re-theme with locked creatures picks a different theme that still contains them", () => {
    const locked = [
      { uuid: "gob-warrior", name: "gob-warrior", level: 1, quantity: 1, traits: ["goblin", "humanoid"] },
    ];
    const first = generateThemedEncounter({
      ...party,
      threat: "severe",
      candidates: bestiary(),
      theme: "auto",
      archetype: "any",
      locked,
      rng: mulberry32(2),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = generateThemedEncounter({
      ...party,
      threat: "severe",
      candidates: bestiary(),
      theme: "auto",
      archetype: "any",
      locked,
      excludeThemeIds: [first.theme.id],
      rng: mulberry32(3),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.theme.id).not.toBe(first.theme.id);
    expect(themePool(second.theme, bestiary()).some((c) => c.uuid === "gob-warrior")).toBe(true);
  });

  it("pack with one locked creature uses that stat block; two locked stat blocks cannot form a pack", () => {
    const one = generateThemedEncounter({
      ...party,
      referenceLevel: 3,
      candidates: bestiary(),
      theme: "auto:animal",
      archetype: "pack",
      locked: [{ uuid: "wolf", name: "wolf", level: 1, quantity: 1, traits: ["animal"] }],
      rng: mulberry32(1),
    });
    expect(one.ok).toBe(true);
    if (one.ok) expect(new Set(one.entries.map((e) => e.uuid))).toEqual(new Set(["wolf"]));
    const two = generateThemedEncounter({
      ...party,
      referenceLevel: 3,
      candidates: bestiary(),
      theme: "auto:animal",
      archetype: "pack",
      locked: [
        { uuid: "wolf", name: "wolf", level: 1, quantity: 1, traits: ["animal"] },
        { uuid: "gob-dog", name: "gob-dog", level: 1, quantity: 1, traits: ["animal"] },
      ],
      rng: mulberry32(1),
    });
    expect(two).toMatchObject({ ok: false, reason: "lockedViolatesComposition" });
  });

  it("sub-theme keys containing a slash survive derivation", () => {
    const pool = [
      c("a", 1, ["humanoid"], ["family:orc/warband"]),
      c("b", 1, ["humanoid"], ["family:orc/warband"]),
      c("d", 2, ["humanoid"], ["family:orc/warband"]),
    ];
    const theme = deriveThemes(pool).find((t) => t.id === "auto:humanoid/family:orc/warband")!;
    expect(theme).toBeTruthy();
    expect(themePool(theme, pool)).toHaveLength(3);
  });

  it("custom themes converted to Theme objects keep their any-of traits", () => {
    const custom = {
      id: "x",
      name: "Fey or beasts",
      requiredTraits: [],
      anyTraits: ["fey", "animal"],
      environment: null,
      candidateUuids: [],
      notes: "",
    };
    const theme = availableThemes(bestiary(), [custom]).find((t) => t.id === "custom:x")!;
    const pool = themePool(theme, bestiary());
    expect(pool.every((p) => p.traits.includes("fey") || p.traits.includes("animal"))).toBe(true);
    expect(pool.length).toBeGreaterThan(0);
  });
});

describe("themed generation keeps the best fit instead of the first success", () => {
  const party = { threat: "moderate" as const, partySize: 4, referenceLevel: 5 };

  it("pack: tries other stat blocks when the first one only gives a near fit", () => {
    // -3 (15 XP) packs top out at 75 XP (near); -2 (20 XP) x4 is exactly 80.
    const candidates = [c("near", 2, ["animal"]), c("exact", 3, ["animal"])];
    for (let seed = 1; seed <= 40; seed++) {
      const result = generateThemedEncounter({
        ...party,
        candidates,
        theme: "auto:animal",
        archetype: "pack",
        rng: mulberry32(seed),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.fit).toBe("exact");
      expect(result.entries.map((e) => e.uuid)).toEqual(["exact"]);
    }
  });

  it("auto mode moves on from an under-budget theme to one with an exact fit", () => {
    const candidates = [
      c("u1", 1, ["undead"]),
      c("u2", 1, ["undead"]),
      c("a1", 7, ["animal"]),
      c("a2", 7, ["animal"]),
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const result = generateThemedEncounter({
        ...party,
        candidates,
        theme: "auto",
        archetype: "any",
        maxCount: 2,
        rng: mulberry32(seed),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.fit).toBe("exact");
      expect(result.theme.id).toBe("auto:animal");
      expect(result.themesTried.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns the closest non-exact result when nothing fits exactly", () => {
    // Only under-budget options: the result is the closest one, not whichever came first.
    const candidates = [
      c("u1", 1, ["undead"]),
      c("u2", 1, ["undead"]),
      c("a1", 2, ["animal"]),
      c("a2", 2, ["animal"]),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const result = generateThemedEncounter({
        ...party,
        candidates,
        theme: "auto",
        archetype: "any",
        maxCount: 2,
        duplicateCap: 1,
        rng: mulberry32(seed),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.totalXP).toBe(30);
    }
  });

  it("boss with minions: an outsider boss beats an under-budget in-theme result, never loosening the theme", () => {
    const candidates = [c("u-boss", 3, ["undead"]), c("u-min", 1, ["undead"]), c("outsider", 6, ["animal"])];
    for (let seed = 1; seed <= 20; seed++) {
      const result = generateThemedEncounter({
        ...party,
        candidates,
        theme: "auto:undead",
        archetype: "bossMinions",
        duplicateCap: 2,
        rng: mulberry32(seed),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.fit).toBe("exact");
      expect(result.outsider?.uuid).toBe("outsider");
      // Everything except the outsider boss stays in the theme.
      for (const e of result.entries) if (e.uuid !== "outsider") expect(e.traits).toContain("undead");
    }
    // With the relaxation off, the in-theme under-budget result is returned as-is.
    const strict = generateThemedEncounter({
      ...party,
      candidates,
      theme: "auto:undead",
      archetype: "bossMinions",
      duplicateCap: 2,
      outsiderBoss: false,
      rng: mulberry32(1),
    });
    expect(strict.ok).toBe(true);
    if (strict.ok) {
      expect(strict.fit).toBe("under");
      expect(strict.outsider).toBeNull();
    }
  });
});

describe("lair archetype respects its solo count range", () => {
  it("clamps a user minimum above 1 into the archetype's range instead of failing", () => {
    const candidates = [c("drake", 7, ["dragon"]), c("drake-2", 6, ["dragon"])];
    for (const minCount of [1, 2, 3]) {
      const result = generateThemedEncounter({
        threat: "moderate",
        partySize: 4,
        referenceLevel: 5,
        candidates,
        theme: "auto:dragon",
        archetype: "lair",
        minCount,
        maxCount: 6,
        rng: mulberry32(minCount),
      });
      expect(result.ok, `minCount ${minCount}`).toBe(true);
      if (!result.ok) continue;
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.quantity).toBe(1);
    }
  });

  it("archetypeCountRange: solo wins, other compositions keep the archetype minimum", () => {
    expect(archetypeCountRange(archetypeConstraints("lair", 8), 3, 8)).toEqual({ minCount: 1, maxCount: 1 });
    expect(archetypeCountRange(archetypeConstraints("lair", 8), undefined, 8)).toEqual({
      minCount: 1,
      maxCount: 1,
    });
    expect(archetypeCountRange(archetypeConstraints("warband", 8), 1, 8)).toEqual({
      minCount: 3,
      maxCount: 6,
    });
    expect(archetypeCountRange(archetypeConstraints("any", 2), 4, 2)).toEqual({ minCount: 4, maxCount: 4 });
  });
});
