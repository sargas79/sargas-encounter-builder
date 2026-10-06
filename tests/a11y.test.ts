import { describe, expect, it } from "vitest";
import { MODULE_ID } from "../src/constants.js";
import { nextTabIndex } from "../src/apps/keyboard.js";
import { findModuleFolder } from "../src/foundry/module-folders.js";

describe("tablist arrow-key navigation", () => {
  const disabled = [false, true, false, false, true, false];

  it("moves to the next or previous enabled tab, wrapping around", () => {
    expect(nextTabIndex(disabled, 0, "ArrowRight")).toBe(2);
    expect(nextTabIndex(disabled, 5, "ArrowRight")).toBe(0);
    expect(nextTabIndex(disabled, 2, "ArrowLeft")).toBe(0);
    expect(nextTabIndex(disabled, 0, "ArrowLeft")).toBe(5);
  });

  it("jumps to the first and last enabled tab", () => {
    expect(nextTabIndex([true, false, false, true], 1, "Home")).toBe(1);
    expect(nextTabIndex([true, false, false, true], 1, "End")).toBe(2);
  });

  it("ignores other keys and lists without another enabled tab", () => {
    expect(nextTabIndex(disabled, 0, "ArrowDown")).toBeNull();
    expect(nextTabIndex([true, true], 0, "ArrowRight")).toBeNull();
    expect(nextTabIndex([false, true], 0, "ArrowRight")).toBe(0);
  });
});

describe("module folder lookup", () => {
  const folder = (name: string, type: string, role?: string) => ({
    name,
    type,
    flags: role ? { [MODULE_ID]: { folder: role } } : {},
  });

  it("prefers the role flag over the name", () => {
    const flagged = folder("Rencontres", "JournalEntry", "recipes");
    const legacy = folder("Encounter Builder: Saved Encounters", "JournalEntry");
    expect(findModuleFolder([legacy, flagged], "recipes")).toBe(flagged);
  });

  it("still finds a folder created before the flag by its English name", () => {
    const legacy = folder("Encounter Builder: Treasure", "Actor");
    expect(findModuleFolder([folder("Other", "Actor"), legacy], "loot")).toBe(legacy);
  });

  it("matches the document type and nothing else", () => {
    expect(findModuleFolder([folder("Encounter Builder: Treasure", "JournalEntry")], "loot")).toBeNull();
    expect(findModuleFolder([folder("Loot", "Actor", "recipes")], "loot")).toBeNull();
  });
});
