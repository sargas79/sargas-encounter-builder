import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_ID } from "../src/constants.js";

/**
 * Every literal localization key used by the code and the templates must exist in lang/en.json.
 * Keys built at runtime (template literals with `${…}`) are not checked here.
 */
const lang = JSON.parse(readFileSync("lang/en.json", "utf8")) as Record<string, unknown>;

function has(full: string): boolean {
  let node: unknown = lang;
  // The module root is a single key that itself contains dots.
  const rest = full.startsWith(`${MODULE_ID}.`) ? full.slice(MODULE_ID.length + 1) : null;
  if (rest === null) return false;
  node = (node as Record<string, unknown>)[MODULE_ID];
  for (const part of rest.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

const full = (key: string) => (key.startsWith(`${MODULE_ID}.`) ? key : `${MODULE_ID}.${key}`);

function sourceKeys(): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = [];
  const patterns = [
    // t("key"), t('key'), t(`key`) and notify.info/warn/error("key"): module-relative keys.
    /\b(?:t|notify\.(?:info|warn|error))\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g,
    // Full keys handed to Foundry directly: window titles, setting names/hints, i18n calls.
    /(?:\b(?:title|name|hint|label):\s*|i18n\.(?:localize|format)\(\s*)`\$\{MODULE_ID\}\.([\w.]+)`/g,
  ];
  for (const file of files("src", ".ts")) {
    const text = readFileSync(file, "utf8");
    for (const re of patterns)
      for (const m of text.matchAll(re)) {
        const key = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (key) out.push({ file, key: full(key) });
      }
  }
  return out;
}

function templateKeys(): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = [];
  for (const file of files("templates", ".hbs")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\blocalize\s+(?:"([^"]+)"|'([^']+)')/g))
      out.push({ file, key: (m[1] ?? m[2])! });
  }
  return out;
}

describe("localization keys exist in lang/en.json", () => {
  it("finds the keys it checks", () => {
    expect(sourceKeys().length).toBeGreaterThan(50);
    expect(templateKeys().length).toBeGreaterThan(100);
  });

  it("every literal t()/notify key in src exists", () => {
    const missing = sourceKeys().filter(({ key }) => !has(key));
    expect(missing).toEqual([]);
  });

  it("every {{localize}} key in the templates exists", () => {
    const missing = templateKeys().filter(({ key }) => !has(key));
    expect(missing).toEqual([]);
  });
});
