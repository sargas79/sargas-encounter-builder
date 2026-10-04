import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";

/**
 * ApplicationV2 renders each PART into exactly one root element and throws otherwise. Every part
 * template is rendered with an "everything on" context (all conditionals true, every list one
 * item) and an empty one, and the result must be a single element either way.
 */
const PARTIALS = ["generator", "meter", "snapshot", "creature-row", "catalog-list"];
const PARTS = [
  ...readdirSync("templates/builder")
    .filter((f) => f.endsWith(".hbs") && !PARTIALS.includes(f.replace(/\.hbs$/, "")))
    .map((f) => join("templates/builder", f)),
  "templates/table-editor.hbs",
];
const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source", "wbr"]);

const hb = Handlebars.create();
for (const name of ["localize", "eq", "ne", "lt", "gt", "lte", "gte", "not", "and", "or"])
  hb.registerHelper(name, () => "x");
for (const p of PARTIALS)
  hb.registerPartial(
    `modules/sargas-encounter-builder/templates/builder/${p}.hbs`,
    readFileSync(`templates/builder/${p}.hbs`, "utf8"),
  );

/** Every property is truthy, every list has one item, every string is "x". */
function everything(): unknown {
  const handler: ProxyHandler<object> = {
    get: (_t, key) => {
      if (typeof key === "symbol") return key === Symbol.toPrimitive ? () => "x" : undefined;
      if (key === "toString" || key === "toHTML" || key === "valueOf") return () => "x";
      return everything();
    },
    ownKeys: () => ["item"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: everything() }),
    has: () => true,
  };
  return new Proxy({}, handler);
}

function rootCount(html: string): number {
  let depth = 0;
  let roots = 0;
  const re = /<\/?([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;
  for (const m of html.matchAll(re)) {
    const closing = m[0].startsWith("</");
    const name = m[1]!.toLowerCase();
    if (closing) depth--;
    else {
      if (depth === 0) roots++;
      if (!VOID.has(name) && !m[2]) depth++;
    }
  }
  return roots;
}

describe("ApplicationV2 parts render a single root element", () => {
  for (const file of PARTS) {
    const template = hb.compile(readFileSync(file, "utf8"));
    it(`${file} (everything on)`, () => {
      expect(rootCount(template(everything()))).toBe(1);
    });
    it(`${file} (empty context)`, () => {
      expect(rootCount(template({}))).toBe(1);
    });
  }
});
