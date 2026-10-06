/**
 * Allowlisted dice grammar for quantity and encounter-check formulas.
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := factor ("*" factor)*
 *   factor := integer | dice | "(" expr ")"
 *   dice   := [integer] "d" integer [("kh" | "kl") [integer]]
 *
 * No `@` data references, no function calls, no flavor text, no other modifiers.
 * Whitespace is allowed between tokens only; it never joins tokens, so "1 2d6" is an error rather
 * than 12d6. Unary minus ("-1d4", "2*-1") is deliberately unsupported: quantities and encounter
 * checks are never negative, and keeping every factor non-negative keeps range computation simple.
 * The same grammar is evaluated by Foundry's Roll at runtime; `evaluateFormula` here is for
 * validation, range computation and tests only.
 */
import type { Rng } from "./rng.js";

export type DiceToken =
  | { type: "int"; value: number }
  | { type: "dice"; count: number; faces: number; keep: "kh" | "kl" | null; keepCount: number }
  | { type: "op"; value: "+" | "-" | "*" }
  | { type: "lparen" }
  | { type: "rparen" };

export interface FormulaValidation {
  ok: boolean;
  error?: string;
  /** Minimum and maximum totals the formula can produce. */
  min?: number;
  max?: number;
}

const MAX_DICE_COUNT = 100;
const MAX_FACES = 1000;

export function tokenizeFormula(formula: string): DiceToken[] {
  const tokens: DiceToken[] = [];
  const src = formula.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*") {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    const dice = /^(\d*)d(\d+)(?:(kh|kl)(\d*))?/.exec(src.slice(i));
    if (dice) {
      const count = dice[1] ? Number.parseInt(dice[1], 10) : 1;
      const faces = Number.parseInt(dice[2]!, 10);
      const keep = (dice[3] as "kh" | "kl" | undefined) ?? null;
      const keepCount = dice[4] ? Number.parseInt(dice[4], 10) : 1;
      if (count < 1 || count > MAX_DICE_COUNT) throw new Error(`dice count out of range: ${dice[0]}`);
      if (faces < 1 || faces > MAX_FACES) throw new Error(`dice faces out of range: ${dice[0]}`);
      if (keep && (keepCount < 1 || keepCount > count))
        throw new Error(`keep count out of range: ${dice[0]}`);
      tokens.push({ type: "dice", count, faces, keep, keepCount });
      i += dice[0].length;
      continue;
    }
    const int = /^\d+/.exec(src.slice(i));
    if (int) {
      tokens.push({ type: "int", value: Number.parseInt(int[0], 10) });
      i += int[0].length;
      continue;
    }
    throw new Error(`unexpected character "${ch}" at ${i}`);
  }
  return tokens;
}

interface Bounds {
  min: number;
  max: number;
}

/** Recursive-descent parser that computes bounds (and optionally evaluates with an RNG). */
class Parser {
  #pos = 0;
  constructor(
    private readonly tokens: DiceToken[],
    private readonly rng: Rng | null,
  ) {}

  parse(): { bounds: Bounds; value: number } {
    const result = this.#expr();
    if (this.#pos !== this.tokens.length) throw new Error("unexpected trailing tokens");
    return result;
  }

  #peek(): DiceToken | undefined {
    return this.tokens[this.#pos];
  }

  #expr(): { bounds: Bounds; value: number } {
    let left = this.#term();
    for (;;) {
      const tok = this.#peek();
      if (tok?.type !== "op" || tok.value === "*") return left;
      this.#pos++;
      const right = this.#term();
      left =
        tok.value === "+"
          ? {
              bounds: { min: left.bounds.min + right.bounds.min, max: left.bounds.max + right.bounds.max },
              value: left.value + right.value,
            }
          : {
              bounds: { min: left.bounds.min - right.bounds.max, max: left.bounds.max - right.bounds.min },
              value: left.value - right.value,
            };
    }
  }

  #term(): { bounds: Bounds; value: number } {
    let left = this.#factor();
    for (;;) {
      const tok = this.#peek();
      if (tok?.type !== "op" || tok.value !== "*") return left;
      this.#pos++;
      const right = this.#factor();
      const products = [
        left.bounds.min * right.bounds.min,
        left.bounds.min * right.bounds.max,
        left.bounds.max * right.bounds.min,
        left.bounds.max * right.bounds.max,
      ];
      left = {
        bounds: { min: Math.min(...products), max: Math.max(...products) },
        value: left.value * right.value,
      };
    }
  }

  #factor(): { bounds: Bounds; value: number } {
    const tok = this.#peek();
    if (!tok) throw new Error("unexpected end of formula");
    this.#pos++;
    if (tok.type === "int") return { bounds: { min: tok.value, max: tok.value }, value: tok.value };
    if (tok.type === "dice") {
      const kept = tok.keep ? tok.keepCount : tok.count;
      let value = 0;
      if (this.rng) {
        const rolls = Array.from({ length: tok.count }, () => 1 + Math.floor(this.rng!() * tok.faces));
        rolls.sort((a, b) => (tok.keep === "kl" ? a - b : b - a));
        value = rolls.slice(0, kept).reduce((a, b) => a + b, 0);
      }
      return { bounds: { min: kept, max: kept * tok.faces }, value };
    }
    if (tok.type === "lparen") {
      const inner = this.#expr();
      if (this.#peek()?.type !== "rparen") throw new Error("missing closing parenthesis");
      this.#pos++;
      return inner;
    }
    throw new Error(`unexpected token ${tok.type}`);
  }
}

export function validateFormula(formula: string): FormulaValidation {
  if (typeof formula !== "string" || formula.trim() === "") return { ok: false, error: "empty formula" };
  if (/@|[a-ce-jm-z]/i.test(formula.replace(/kh|kl/gi, "").replace(/d/gi, ""))) {
    return { ok: false, error: "only integers, dice (NdM, kh/kl), + - * and parentheses are allowed" };
  }
  try {
    const parser = new Parser(tokenizeFormula(formula), null);
    const { bounds } = parser.parse();
    return { ok: true, min: bounds.min, max: bounds.max };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Pure evaluation with an injectable RNG (used by tests and the pure resolver). */
export function evaluateFormula(formula: string, rng: Rng): number {
  const parser = new Parser(tokenizeFormula(formula), rng);
  return parser.parse().value;
}

/** Fixed integer quantities are written as plain integers; everything else must validate. */
export function isFixedQuantity(formula: string): boolean {
  return /^\s*\d+\s*$/.test(formula);
}
