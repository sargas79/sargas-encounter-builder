/**
 * Theme-first encounter generation.
 *
 * 1. Choose a theme (given, inferred from locked entries, or random among themes that can fit).
 * 2. Map the archetype to generator constraints (composition, counts, distinct stat blocks).
 * 3. Run the exact/near-fit solver inside the theme's pool only. Theme coherence is a hard constraint;
 *    the single relaxation is the "boss with minions" archetype, whose boss may be an outsider.
 *
 * Pure and seeded like the base generator.
 */
import {
  generateEncounter,
  type GeneratedEntry,
  type GeneratorCandidate,
  type GeneratorFailure,
  type GeneratorInput,
  type GeneratorResult,
  type GeneratorSuccess,
  type LockedEntry,
} from "./generator.js";
import { pickWeighted, shuffle, type Rng } from "./rng.js";
import type { ThreatLevel } from "./budget.js";
import {
  customToTheme,
  deriveThemes,
  inferThemeFromLocked,
  themePool,
  type CustomTheme,
  type DerivedTheme,
  type Theme,
  type ThemeCandidate,
} from "./themes.js";

export type Archetype = "any" | "pack" | "warband" | "bossMinions" | "mixedPatrol" | "lair";
export const ARCHETYPES: readonly Archetype[] = [
  "any",
  "pack",
  "warband",
  "bossMinions",
  "mixedPatrol",
  "lair",
];

export type ThemedCandidate = GeneratorCandidate & ThemeCandidate;

export interface ThemedInput {
  threat: ThreatLevel;
  partySize: number;
  referenceLevel: number;
  /** All candidates after pack/trait/tag/rarity filters. */
  candidates: ThemedCandidate[];
  /** "auto" picks a theme; otherwise a theme id from `availableThemes` or a Theme object. */
  theme: "auto" | string | Theme;
  archetype: Archetype;
  customThemes?: CustomTheme[];
  /** Allow the boss slot of "bossMinions" to come from outside the theme (default true). */
  outsiderBoss?: boolean;
  relativeMin?: number;
  relativeMax?: number;
  minCount?: number;
  maxCount?: number;
  duplicateCap?: number;
  excludeUuids?: string[];
  locked?: LockedEntry[];
  rng?: Rng;
  /** How many themes to try in "auto" mode before giving up. */
  maxThemeAttempts?: number;
  /** Themes never chosen in "auto" mode (used by "re-theme"). */
  excludeThemeIds?: string[];
}

export interface ThemedSuccess extends GeneratorSuccess {
  theme: Theme;
  archetype: Archetype;
  /** Outsider boss used (bossMinions only). */
  outsider: GeneratedEntry | null;
  themePoolSize: number;
  themesTried: string[];
}

export interface ThemedFailure {
  ok: false;
  reason: "noThemes" | "themeNotFound" | "themePoolEmpty" | GeneratorFailure;
  detail: Record<string, unknown>;
  theme: Theme | null;
  archetype: Archetype;
  themesTried: string[];
}

export type ThemedResult = ThemedSuccess | ThemedFailure;

/* -------------------------------------------- */
/*  Archetypes                                  */
/* -------------------------------------------- */

interface ArchetypeConstraints {
  composition: GeneratorInput["composition"];
  minCount: number;
  maxCount: number;
  minDistinct?: number;
  maxDistinct?: number;
  relativeMin?: number;
  relativeMax?: number;
  duplicateCap?: number;
}

export function archetypeConstraints(archetype: Archetype, maxCountCap: number): ArchetypeConstraints {
  switch (archetype) {
    case "pack":
      return {
        composition: "unrestricted",
        minCount: 3,
        maxCount: Math.max(3, maxCountCap),
        maxDistinct: 1,
        relativeMax: 0,
        duplicateCap: Math.max(3, maxCountCap),
      };
    case "warband":
      return {
        composition: "warband",
        minCount: 3,
        maxCount: Math.min(6, Math.max(3, maxCountCap)),
        minDistinct: 2,
      };
    case "bossMinions":
      return { composition: "bossWithSupport", minCount: 2, maxCount: Math.min(7, Math.max(2, maxCountCap)) };
    case "mixedPatrol":
      return {
        composition: "mixedPatrol",
        minCount: 2,
        maxCount: Math.min(5, Math.max(2, maxCountCap)),
        minDistinct: 2,
      };
    case "lair":
      return { composition: "solo", minCount: 1, maxCount: 1 };
    case "any":
    default:
      return { composition: "unrestricted", minCount: 1, maxCount: Math.max(1, maxCountCap) };
  }
}

/**
 * Creature count range for the solver. A solo composition (lair) is defined by its count, so the
 * archetype's range wins and the user's min/max are clamped into it. Otherwise the archetype's own
 * minimum wins over a user cap that would make the range empty.
 */
export function archetypeCountRange(
  constraints: Pick<ArchetypeConstraints, "composition" | "minCount" | "maxCount">,
  userMinCount: number | undefined,
  maxCountCap: number,
): { minCount: number; maxCount: number } {
  if (constraints.composition === "solo") {
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const minCount = clamp(userMinCount ?? constraints.minCount, constraints.minCount, constraints.maxCount);
    return { minCount, maxCount: clamp(maxCountCap, minCount, constraints.maxCount) };
  }
  const minCount = Math.max(userMinCount ?? 1, constraints.minCount);
  return { minCount, maxCount: Math.max(minCount, Math.min(maxCountCap, constraints.maxCount)) };
}

/* -------------------------------------------- */
/*  Themes available for a candidate set        */
/* -------------------------------------------- */

export function availableThemes(candidates: ThemedCandidate[], customThemes: CustomTheme[] = []): Theme[] {
  const derived: DerivedTheme[] = deriveThemes(candidates);
  const customs = customThemes.map(customToTheme);
  return [...customs, ...derived];
}

/* -------------------------------------------- */
/*  Generation                                  */
/* -------------------------------------------- */

export function generateThemedEncounter(input: ThemedInput): ThemedResult {
  const rng = input.rng ?? Math.random;
  const archetype = input.archetype ?? "any";
  const customs = new Map((input.customThemes ?? []).map((c) => [c.id, c]));
  const maxCountCap = input.maxCount ?? 8;
  const constraints = archetypeConstraints(archetype, maxCountCap);
  const locked = input.locked ?? [];
  const themesTried: string[] = [];
  const counts = archetypeCountRange(constraints, input.minCount, maxCountCap);

  // Resolve candidate themes.
  let themes: Theme[];
  const lockedThemed = locked
    .map(
      (l) =>
        input.candidates.find((c) => c.uuid === l.uuid) ??
        ({ uuid: l.uuid, name: l.name, level: l.level, traits: l.traits ?? [] } as ThemedCandidate),
    )
    .filter((c) => c.traits.length > 0);
  if (typeof input.theme === "object") themes = [input.theme];
  else if (input.theme !== "auto") {
    const found = availableThemes(input.candidates, input.customThemes).find((t) => t.id === input.theme);
    if (!found)
      return {
        ok: false,
        reason: "themeNotFound",
        detail: { theme: input.theme },
        theme: null,
        archetype,
        themesTried,
      };
    themes = [found];
  } else if (
    lockedThemed.length > 0 &&
    inferThemeFromLocked(lockedThemed) &&
    !(input.excludeThemeIds ?? []).includes(inferThemeFromLocked(lockedThemed)!.id)
  ) {
    themes = [inferThemeFromLocked(lockedThemed)!];
  } else {
    const excludedThemes = new Set(input.excludeThemeIds ?? []);
    // With locked creatures, only themes that contain every locked creature keep the result coherent.
    const lockedUuids = new Set(locked.map((l) => l.uuid));
    const all = availableThemes(input.candidates, input.customThemes).filter(
      (th) => !excludedThemes.has(th.id),
    );
    if (all.length === 0)
      return { ok: false, reason: "noThemes", detail: {}, theme: null, archetype, themesTried };
    // Weighted random order by pool size, bounded attempts.
    const sized = all
      .map((t) => {
        const pool = themePool(t, input.candidates, customs);
        const poolUuids = new Set(pool.map((c) => c.uuid));
        const holdsLocked = [...lockedUuids].every((u) => poolUuids.has(u));
        return { t, size: holdsLocked ? pool.length : 0 };
      })
      .filter((x) => x.size > 0);
    const order: Theme[] = [];
    let remaining = [...sized];
    const attempts = Math.min(input.maxThemeAttempts ?? 12, remaining.length);
    for (let i = 0; i < attempts; i++) {
      const picked = pickWeighted(rng, remaining, (x) => Math.sqrt(x.size));
      order.push(picked.t);
      remaining = remaining.filter((x) => x !== picked);
    }
    themes = order;
  }

  let lastFailure: GeneratorResult | null = null;
  let lastTheme: Theme | null = null;
  // Best success so far across creatures, themes and boss choices. Only an exact fit ends the search early;
  // otherwise every attempt is tried and the closest result wins.
  let best: ThemedSuccess | null = null;
  const keep = (candidate: ThemedSuccess): boolean => {
    if (!best || betterFit(candidate, best)) best = candidate;
    return candidate.fit === "exact";
  };
  for (const theme of themes) {
    themesTried.push(theme.id);
    lastTheme = theme;
    const pool = themePool(theme, input.candidates, customs);
    if (pool.length === 0) {
      lastFailure = null;
      continue;
    }
    const base: GeneratorInput = {
      threat: input.threat,
      partySize: input.partySize,
      referenceLevel: input.referenceLevel,
      candidates: pool,
      relativeMin: Math.max(input.relativeMin ?? -4, constraints.relativeMin ?? -4),
      relativeMax: Math.min(input.relativeMax ?? 4, constraints.relativeMax ?? 4),
      minCount: counts.minCount,
      maxCount: counts.maxCount,
      composition: constraints.composition,
      duplicateCap: constraints.duplicateCap ?? input.duplicateCap ?? 4,
      excludeUuids: input.excludeUuids,
      locked,
      minDistinctCreatures: constraints.minDistinct,
      maxDistinctCreatures: constraints.maxDistinct,
      rng,
    };

    // Pack: one stat block, try creatures in random order so the pick is random but exact.
    // A locked creature is the pack's stat block; several distinct locked creatures cannot form a pack.
    if (archetype === "pack") {
      const lockedUuids = [...new Set(locked.map((l) => l.uuid))];
      if (lockedUuids.length > 1) {
        lastFailure = {
          ok: false,
          reason: "lockedViolatesComposition",
          detail: { composition: "pack", lockedCount: lockedUuids.length },
          enumerated: 0,
          capped: false,
        };
        continue;
      }
      const choices =
        lockedUuids.length === 1 ? pool.filter((c) => c.uuid === lockedUuids[0]) : shuffle(rng, pool);
      for (const creature of choices.slice(0, 40)) {
        const result = generateEncounter({ ...base, candidates: [creature] });
        if (result.ok) {
          if (keep(success(result, theme, archetype, null, pool.length, themesTried))) return best!;
        } else lastFailure = result;
      }
      continue;
    }

    // Boss with minions: optionally pick the boss from outside the theme.
    if (archetype === "bossMinions" && (input.outsiderBoss ?? true) && !locked.length) {
      const inTheme = generateEncounter(base);
      if (inTheme.ok) {
        if (keep(success(inTheme, theme, archetype, null, pool.length, themesTried))) return best!;
        // An in-theme near fit is preferred over the outsider relaxation; an under-budget one is not.
        if (inTheme.fit !== "under") continue;
      } else lastFailure = inTheme;
      const poolUuids = new Set(pool.map((c) => c.uuid));
      const excludedUuids = new Set(input.excludeUuids ?? []);
      const outsiders = shuffle(
        rng,
        input.candidates.filter(
          (c) =>
            !poolUuids.has(c.uuid) &&
            !excludedUuids.has(c.uuid) &&
            c.level - input.referenceLevel >= 1 &&
            c.level - input.referenceLevel <= (input.relativeMax ?? 4),
        ),
      );
      for (const boss of outsiders.slice(0, 20)) {
        const result = generateEncounter({
          ...base,
          locked: [
            {
              uuid: boss.uuid,
              name: boss.name,
              level: boss.level,
              quantity: 1,
              traits: boss.traits,
              img: boss.img,
              packLabel: boss.packLabel,
            },
          ],
        });
        if (result.ok) {
          const outsider = result.entries.find((e) => e.uuid === boss.uuid) ?? null;
          // The boss was passed as locked for the solver; present it as generated.
          const entries = result.entries.map((e) => (e.uuid === boss.uuid ? { ...e, locked: false } : e));
          const candidate = success(
            { ...result, entries },
            theme,
            archetype,
            outsider ? { ...outsider, locked: false } : null,
            pool.length,
            themesTried,
          );
          if (keep(candidate)) return best!;
        } else lastFailure = result;
      }
      continue;
    }

    const result = generateEncounter(base);
    if (result.ok) {
      if (keep(success(result, theme, archetype, null, pool.length, themesTried))) return best!;
    } else lastFailure = result;
  }

  if (best) return best;

  if (!lastFailure)
    return {
      ok: false,
      reason: "themePoolEmpty",
      detail: { themesTried },
      theme: lastTheme,
      archetype,
      themesTried,
    };
  return {
    ok: false,
    reason: lastFailure.reason,
    detail: lastFailure.detail,
    theme: lastTheme,
    archetype,
    themesTried,
  };
}

const FIT_RANK: Record<GeneratorSuccess["fit"], number> = { exact: 0, near: 1, under: 2 };

/** exact > near > under, then closest to the budget. Ties keep the earlier result. */
function betterFit(a: GeneratorSuccess, b: GeneratorSuccess): boolean {
  if (FIT_RANK[a.fit] !== FIT_RANK[b.fit]) return FIT_RANK[a.fit] < FIT_RANK[b.fit];
  return Math.abs(a.difference) < Math.abs(b.difference);
}

function success(
  result: GeneratorSuccess,
  theme: Theme,
  archetype: Archetype,
  outsider: GeneratedEntry | null,
  themePoolSize: number,
  themesTried: string[],
): ThemedSuccess {
  return {
    ...result,
    theme,
    archetype,
    outsider,
    themePoolSize,
    themesTried,
    explanation: [
      ...result.explanation,
      `theme:${theme.id}`,
      `archetype:${archetype}`,
      ...(outsider ? [`outsiderBoss:${outsider.name}`] : []),
    ],
  };
}
