import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import { afterAll, describe, expect, it, vi } from "vitest";

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

/**
 * Every `data-action` in the markup must name a registered ApplicationV2 action, and every
 * `data-action="ext"` button must name a panel and a method on that panel's whitelist.
 */
interface ActionUse {
  file: string;
  action: string;
  ext?: string;
  method?: string;
}

function actionUses(files: string[]): ActionUse[] {
  const uses: ActionUse[] = [];
  for (const file of files) {
    for (const [tag] of readFileSync(file, "utf8").matchAll(/<[a-zA-Z][^<>]*\bdata-action="[^"]*"[^<>]*>/g)) {
      const attr = (name: string) => new RegExp(`\\bdata-${name}="([^"]*)"`).exec(tag)?.[1];
      uses.push({ file, action: attr("action")!, ext: attr("ext"), method: attr("method") });
    }
  }
  return uses;
}

describe("template actions resolve", () => {
  const builderFiles = readdirSync("templates/builder")
    .filter((f) => f.endsWith(".hbs"))
    .map((f) => join("templates/builder", f));

  async function loadApps() {
    class FakeApplication {}
    vi.stubGlobal("foundry", {
      applications: {
        api: { ApplicationV2: FakeApplication, HandlebarsApplicationMixin: (base: unknown) => base },
      },
    });
    const { EncounterBuilderApp } = await import("../src/apps/encounter-builder-app.js");
    const { EncounterTableEditor } = await import("../src/apps/table-editor-app.js");
    return { EncounterBuilderApp, EncounterTableEditor };
  }

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("builder templates use registered actions and whitelisted panel methods", async () => {
    const { EncounterBuilderApp } = await loadApps();
    const registered = Object.keys(EncounterBuilderApp.DEFAULT_OPTIONS.actions);
    const app = new EncounterBuilderApp() as unknown as {
      panels: Record<string, { actions?: ReadonlySet<string> } & Record<string, unknown>>;
    };
    const uses = actionUses(builderFiles);
    // The tag pattern must not skip any attribute (e.g. a tag with a stray `>` in a helper).
    const raw = builderFiles.reduce(
      (n, f) => n + readFileSync(f, "utf8").split('data-action="').length - 1,
      0,
    );
    expect(uses.length).toBe(raw);
    for (const use of uses) {
      expect(registered, `${use.file}: ${use.action}`).toContain(use.action);
      if (use.action !== "ext") continue;
      const label = `${use.file}: ${use.ext}.${use.method}`;
      expect(use.ext && use.method, label).toBeTruthy();
      const panel = app.panels[use.ext!];
      expect(panel, label).toBeDefined();
      expect(panel!.actions?.has(use.method!), label).toBe(true);
      expect(typeof panel![use.method!], label).toBe("function");
    }
  });

  it("panel whitelists exclude lifecycle members", async () => {
    const { EncounterBuilderApp } = await loadApps();
    const app = new EncounterBuilderApp() as unknown as {
      panels: Record<string, { actions?: ReadonlySet<string> }>;
    };
    const lifecycle = ["prepareContext", "onChange", "onDrop", "onTabShown", "onDraftReplaced", "dispose"];
    for (const panel of Object.values(app.panels))
      for (const name of lifecycle) expect(panel.actions?.has(name) ?? false).toBe(false);
  });

  it("table editor template uses registered actions", async () => {
    const { EncounterTableEditor } = await loadApps();
    const registered = Object.keys(EncounterTableEditor.DEFAULT_OPTIONS.actions);
    for (const use of actionUses(["templates/table-editor.hbs"]))
      expect(registered, `${use.file}: ${use.action}`).toContain(use.action);
  });
});
