/** Numeric bounds of the themed generator panel: clamping and keeping min/max pairs ordered. */

export interface GeneratorBounds {
  relativeMin: number;
  relativeMax: number;
  minCount: number;
  maxCount: number;
  duplicateCap: number;
}

export type GeneratorBoundKey = keyof GeneratorBounds;

export const GENERATOR_BOUND_DEFAULTS: GeneratorBounds = {
  relativeMin: -4,
  relativeMax: 4,
  minCount: 1,
  maxCount: 6,
  duplicateCap: 4,
};

const PAIRS: Partial<Record<GeneratorBoundKey, { other: GeneratorBoundKey; isMin: boolean }>> = {
  relativeMin: { other: "relativeMax", isMin: true },
  relativeMax: { other: "relativeMin", isMin: false },
  minCount: { other: "maxCount", isMin: true },
  maxCount: { other: "minCount", isMin: false },
};

/**
 * Parse and clamp one bound typed by the GM, then drag its partner along when the pair would
 * invert (raising the minimum above the maximum raises the maximum, and vice versa). Mutates
 * `options` and returns the edited key plus the partner when it moved, so the caller can write
 * the stored values back into those inputs.
 */
export function setGeneratorBound(
  options: GeneratorBounds,
  key: GeneratorBoundKey,
  raw: string,
): GeneratorBoundKey[] {
  const n = Number.parseInt(raw, 10);
  let value: number;
  if (key === "relativeMin" || key === "relativeMax") {
    value = Number.isInteger(n) ? Math.max(-4, Math.min(4, n)) : GENERATOR_BOUND_DEFAULTS[key];
  } else {
    value = Number.isInteger(n) && n >= 1 ? n : GENERATOR_BOUND_DEFAULTS[key];
  }
  options[key] = value;
  const touched: GeneratorBoundKey[] = [key];
  const pair = PAIRS[key];
  if (pair) {
    const other = options[pair.other];
    if (pair.isMin ? value > other : value < other) {
      options[pair.other] = value;
      touched.push(pair.other);
    }
  }
  return touched;
}
