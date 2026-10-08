import { describe, expect, it } from "vitest";
import { GENERATOR_BOUND_DEFAULTS, setGeneratorBound } from "../src/core/generator-options.js";

describe("generator panel bounds", () => {
  it("clamps relative levels to -4..+4 and falls back to defaults on junk", () => {
    const options = { ...GENERATOR_BOUND_DEFAULTS };
    expect(setGeneratorBound(options, "relativeMax", "9")).toEqual(["relativeMax"]);
    expect(options.relativeMax).toBe(4);
    setGeneratorBound(options, "relativeMin", "abc");
    expect(options.relativeMin).toBe(-2);
    setGeneratorBound(options, "duplicateCap", "0");
    expect(options.duplicateCap).toBe(4);
  });

  it("drags the other bound along instead of leaving min above max", () => {
    const options = { ...GENERATOR_BOUND_DEFAULTS };
    expect(setGeneratorBound(options, "minCount", "8")).toEqual(["minCount", "maxCount"]);
    expect(options).toMatchObject({ minCount: 8, maxCount: 8 });
    expect(setGeneratorBound(options, "maxCount", "3")).toEqual(["maxCount", "minCount"]);
    expect(options).toMatchObject({ minCount: 3, maxCount: 3 });
    expect(setGeneratorBound(options, "relativeMax", "-2")).toEqual(["relativeMax"]);
    expect(setGeneratorBound(options, "relativeMin", "1")).toEqual(["relativeMin", "relativeMax"]);
    expect(options).toMatchObject({ relativeMin: 1, relativeMax: 1 });
  });
});
