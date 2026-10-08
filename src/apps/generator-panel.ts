/**
 * Themed random generation panel: theme, archetype, advanced constraints, custom themes.
 */
import type { CatalogFilter } from "../core/catalog.js";
import type { CustomThemeRecord } from "../core/schemas.js";
import {
  entryFromCatalog,
  removeEntry,
  type Draft,
  type DraftEntry,
  type DraftEntrySource,
} from "../core/draft.js";
import { GENERATOR_BOUND_DEFAULTS, setGeneratorBound } from "../core/generator-options.js";
import { hashSeed, rngFromSeed } from "../core/rng.js";
import {
  ARCHETYPES,
  availableThemes,
  generateThemedEncounter,
  type Archetype,
  type ThemedCandidate,
  type ThemedInput,
  type ThemedResult,
} from "../core/themed-generator.js";
import { themePool, type Theme } from "../core/themes.js";
import { escapeHtml, randomHexSeed, splitList } from "../core/util.js";
import { DialogV2, isGM } from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import { services } from "../foundry/services.js";
import { confirm } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import { panelActions, type Panel } from "./panel.js";

export interface GeneratorOptions {
  /** "auto" or a theme id. */
  themeId: string;
  archetype: Archetype;
  outsiderBoss: boolean;
  relativeMin: number;
  relativeMax: number;
  minCount: number;
  maxCount: number;
  duplicateCap: number;
  seed: string;
  excludeUuids: string[];
  showAdvanced: boolean;
}

export class GeneratorPanel implements Panel {
  readonly actions: ReadonlySet<string> = panelActions<GeneratorPanel>(
    "setArchetype",
    "toggleAdvanced",
    "generate",
    "regenerate",
    "retheme",
    "exclude",
    "unexclude",
    "newTheme",
    "editTheme",
    "deleteTheme",
  );
  options: GeneratorOptions = {
    themeId: "auto",
    archetype: "any",
    outsiderBoss: true,
    ...GENERATOR_BOUND_DEFAULTS,
    seed: "",
    excludeUuids: [],
    showAdvanced: false,
  };
  lastResult: ThemedResult | null = null;
  lastSeed: string | null = null;
  busy = false;
  #themeCache: {
    key: string;
    themes: Theme[];
    candidates: ThemedCandidate[];
    sizes: Map<string, number>;
  } | null = null;

  constructor(private readonly app: EncounterBuilderApp) {}

  /* ---------------------------- data -------------------------------- */

  #candidateFilter(): CatalogFilter {
    const ref = this.app.state.resolved?.roster.reference.level ?? null;
    return {
      ...this.app.state.filter,
      referenceLevel: ref,
      relativeMin: null,
      relativeMax: null,
      levelMin: null,
      levelMax: null,
      search: "",
    };
  }

  async #candidates(filter: CatalogFilter): Promise<ThemedCandidate[]> {
    const entries = await services().catalog.search(filter);
    return entries.map((c) => ({
      uuid: c.uuid,
      name: c.name,
      level: c.level,
      traits: c.traits,
      tags: c.tags,
      img: c.img,
      packLabel: c.packLabel,
    }));
  }

  async themes(): Promise<{ themes: Theme[]; candidates: ThemedCandidate[]; sizes: Map<string, number> }> {
    const { catalog } = services();
    const customs = services().themes.list();
    const filter = this.#candidateFilter();
    // The catalog's version moves whenever its entries, tags or selection change, so a cache hit
    // needs no search; the selection is keyed too since another GM can change the setting.
    const stamp = (version: number) =>
      `${version}:${catalog.selectedPackIds().join(",")}:${JSON.stringify(filter)}:${hashSeed(JSON.stringify(customs))}`;
    const cached = this.#themeCache;
    if (cached && cached.key === stamp(catalog.version)) {
      return { themes: cached.themes, candidates: cached.candidates, sizes: cached.sizes };
    }
    const candidates = await this.#candidates(filter);
    const themes = availableThemes(candidates, customs);
    const customMap = new Map(customs.map((c) => [c.id, c]));
    const sizes = new Map(themes.map((th) => [th.id, themePool(th, candidates, customMap).length]));
    // Keyed after the search: loading a pack's index bumps the version.
    this.#themeCache = { key: stamp(catalog.version), themes, candidates, sizes };
    return { themes, candidates, sizes };
  }

  /* ---------------------------- context ----------------------------- */

  async prepareContext(): Promise<Record<string, unknown>> {
    const ready = this.app.ready;
    let themeOptions: { value: string; label: string; selected: boolean; group: string; size: number }[] = [];
    if (ready) {
      try {
        const { themes, sizes } = await this.themes();
        themeOptions = themes.map((theme) => ({
          value: theme.id,
          label: theme.name,
          selected: theme.id === this.options.themeId,
          group: theme.kind === "custom" ? "custom" : theme.kind === "environment" ? "environment" : "auto",
          size: sizes.get(theme.id) ?? 0,
        }));
      } catch (error) {
        console.error("sargas-encounter-builder | theme derivation failed", error);
      }
    }
    const result = this.lastResult;
    return {
      options: this.options,
      themeOptions,
      autoSelected: this.options.themeId === "auto",
      customThemes: services()
        .themes.list()
        .map((c) => ({ ...c, summary: describeCustom(c) })),
      archetypes: ARCHETYPES.map((value) => ({
        value,
        label: t(`generator.archetype.${value}`),
        hint: t(`generator.archetypeHint.${value}`),
        active: value === this.options.archetype,
      })),
      isBossMinions: this.options.archetype === "bossMinions",
      excluded: this.options.excludeUuids.map((uuid) => ({
        uuid,
        name: services().catalog.get(uuid)?.name ?? uuid,
      })),
      last: result
        ? result.ok
          ? {
              ok: true,
              themeName: result.theme.name,
              archetypeLabel: t(`generator.archetype.${result.archetype}`),
              fitLabel: t(`generator.fit.${result.fit}`),
              totalXP: result.totalXP,
              target: result.target,
              difference: result.difference,
              outsider: result.outsider?.name ?? null,
              poolSize: result.themePoolSize,
              capped: result.capped,
            }
          : {
              ok: false,
              reason: t(`generator.failure.${result.reason}`, result.detail),
              themeName: result.theme?.name ?? null,
              tried: result.themesTried.length,
            }
        : null,
      lastSeed: this.lastSeed,
      busy: this.busy,
      canGenerate: ready && !this.busy,
      hasResult: !!(result && result.ok),
      lockedCount: this.app.state.draft.entries.filter((e) => e.locked).length,
    };
  }

  /* ---------------------------- inputs ------------------------------ */

  async onChange(name: string, value: string, target: HTMLElement): Promise<boolean> {
    if (!name.startsWith("gen.")) return false;
    const key = name.slice(4) as keyof GeneratorOptions;
    switch (key) {
      case "themeId":
        this.options.themeId = value || "auto";
        break;
      case "seed":
        this.options.seed = value.trim();
        break;
      case "outsiderBoss":
        this.options.outsiderBoss = (target as HTMLInputElement).checked;
        break;
      case "relativeMin":
      case "relativeMax":
      case "minCount":
      case "maxCount":
      case "duplicateCap": {
        // Show the stored (clamped, reordered) values without re-rendering the build part, which
        // would drop focus while the GM tabs through the advanced fields.
        const touched = setGeneratorBound(this.options, key, value);
        const form = target.closest(".seb-generator");
        for (const k of touched) {
          const input =
            k === key
              ? (target as HTMLInputElement)
              : form?.querySelector<HTMLInputElement>(`[name="gen.${k}"]`);
          if (input) input.value = String(this.options[k]);
        }
        break;
      }
      default:
        return false;
    }
    return true;
  }

  /* ---------------------------- actions ----------------------------- */

  async setArchetype(_uuid: string | undefined, target?: HTMLElement): Promise<void> {
    const value = target?.dataset.value as Archetype | undefined;
    if (value && ARCHETYPES.includes(value)) this.options.archetype = value;
    await this.app.render({ parts: ["build"] });
  }

  async toggleAdvanced(): Promise<void> {
    this.options.showAdvanced = !this.options.showAdvanced;
    await this.app.render({ parts: ["build"] });
  }

  async generate(): Promise<void> {
    await this.#run({});
  }

  async regenerate(): Promise<void> {
    await this.#run({ freshSeed: true });
  }

  /** Keep the archetype, pick a different theme. */
  async retheme(): Promise<void> {
    const current = this.lastResult?.ok ? this.lastResult.theme.id : null;
    await this.#run({ freshSeed: true, excludeThemeIds: current ? [current] : [], forceAuto: true });
  }

  async replaceEntry(uuid: string): Promise<void> {
    await this.#run({ replaceUuid: uuid });
  }

  async exclude(uuid: string): Promise<void> {
    if (!this.options.excludeUuids.includes(uuid)) this.options.excludeUuids.push(uuid);
    if (this.app.state.draft.entries.some((e) => e.uuid === uuid)) {
      this.app.setDraft(removeEntry(this.app.state.draft, uuid));
    }
    await this.app.render({ parts: ["build", "deploy", "footer"] });
  }

  async unexclude(uuid: string): Promise<void> {
    this.options.excludeUuids = this.options.excludeUuids.filter((u) => u !== uuid);
    await this.app.render({ parts: ["build"] });
  }

  /* ---------------------------- custom themes ----------------------- */

  async newTheme(): Promise<void> {
    await this.#editThemeDialog(null);
  }

  async editTheme(id?: string): Promise<void> {
    const record = id ? services().themes.get(id) : null;
    if (record) await this.#editThemeDialog(record);
  }

  async deleteTheme(id?: string): Promise<void> {
    const record = id ? services().themes.get(id) : null;
    if (!record || !isGM()) return;
    const ok = await confirm(
      t("generator.themes.deleteTitle"),
      t("generator.themes.deleteConfirm", { name: escapeHtml(record.name) }),
      "fa-solid fa-trash",
    );
    if (!ok) return;
    await services().themes.delete(record.id);
    if (this.options.themeId === `custom:${record.id}`) this.options.themeId = "auto";
    this.#themeCache = null;
    await this.app.render({ parts: ["build"] });
  }

  async #editThemeDialog(record: CustomThemeRecord | null): Promise<void> {
    if (!isGM()) return;
    const v = (s: string) => escapeHtml(s);
    const field = (name: string, label: string, control: string) =>
      `<div class="seb-field"><label for="seb-theme-${name}">${label}</label>${control}</div>`;
    const content = `
      <div class="seb-form">
        ${field("name", t("generator.themes.name"), `<input id="seb-theme-name" type="text" name="name" value="${v(record?.name ?? "")}" autofocus>`)}
        ${field("required", t("generator.themes.required"), `<input id="seb-theme-required" type="text" name="required" value="${v(record?.requiredTraits.join(", ") ?? "")}" placeholder="undead, ghoul">`)}
        ${field("any", t("generator.themes.any"), `<input id="seb-theme-any" type="text" name="any" value="${v(record?.anyTraits.join(", ") ?? "")}" placeholder="goblin, hobgoblin">`)}
        ${field("environment", t("generator.themes.environment"), `<input id="seb-theme-environment" type="text" name="environment" value="${v(record?.environment ?? "")}" placeholder="forest">`)}
        ${field("uuids", t("generator.themes.uuids"), `<textarea id="seb-theme-uuids" name="uuids" rows="3" placeholder="Compendium.pf2e.pathfinder-bestiary.Actor.…">${v(record?.candidateUuids.join("\n") ?? "")}</textarea>`)}
        ${field("notes", t("generator.themes.notes"), `<input id="seb-theme-notes" type="text" name="notes" value="${v(record?.notes ?? "")}">`)}
        <p class="seb-hint">${t("generator.themes.hint")}</p>
      </div>`;
    const saved = (await DialogV2().wait({
      window: {
        title: record ? t("generator.themes.editTitle") : t("generator.themes.newTitle"),
        icon: "fa-solid fa-palette",
      },
      classes: ["seb-dialog"],
      position: { width: 480 },
      content,
      modal: true,
      rejectClose: false,
      buttons: [
        {
          action: "save",
          label: t("generator.themes.save"),
          icon: "fa-solid fa-floppy-disk",
          default: true,
          callback: (_e: Event, _b: HTMLButtonElement, dialog: { element: HTMLElement }) => {
            const read = (name: string) =>
              dialog.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`)
                ?.value ?? "";
            return {
              id: record?.id,
              name: read("name").trim() || t("generator.themes.untitled"),
              requiredTraits: splitList(read("required")),
              anyTraits: splitList(read("any")),
              environment: read("environment").trim().toLowerCase() || null,
              candidateUuids: splitList(read("uuids"), false),
              notes: read("notes").trim(),
            };
          },
        },
        { action: "cancel", label: t("start.cancel"), callback: () => null },
      ],
    })) as (Omit<CustomThemeRecord, "id"> & { id?: string }) | null | string;
    if (!saved || typeof saved !== "object") return;
    const stored = await services().themes.save(saved);
    this.options.themeId = `custom:${stored.id}`;
    this.#themeCache = null;
    await this.app.render({ parts: ["build"] });
  }

  /* ---------------------------- run --------------------------------- */

  async #run({
    freshSeed = false,
    replaceUuid,
    excludeThemeIds = [],
    forceAuto = false,
  }: {
    freshSeed?: boolean;
    replaceUuid?: string;
    excludeThemeIds?: string[];
    forceAuto?: boolean;
  }): Promise<void> {
    if (!isGM() || this.busy) return;
    const resolved = this.app.state.resolved;
    const roster = resolved?.roster;
    if (!resolved || !roster || !this.app.ready) {
      this.app.pushMessage("warn", t("gate.tooltip"));
      await this.app.render({ parts: ["header"] });
      return;
    }
    this.busy = true;
    await this.app.render({ parts: ["build"] });
    try {
      const referenceLevel = roster.reference.level!;
      const { candidates } = await this.themes();
      const draft = this.app.state.draft;
      const locked = draft.entries
        .filter((e) => (replaceUuid ? e.uuid !== replaceUuid : e.locked))
        .map((e) => ({
          uuid: e.uuid,
          name: e.name,
          level: e.level,
          quantity: e.quantity,
          traits: e.traits,
          img: e.img,
          packLabel: e.packLabel,
        }));
      const seed = this.options.seed || (freshSeed || !this.lastSeed ? randomHexSeed() : this.lastSeed);
      const excludeUuids = [...this.options.excludeUuids, ...(replaceUuid ? [replaceUuid] : [])];
      const input: ThemedInput = {
        threat: resolved.profile.selectedThreat,
        partySize: roster.partySize,
        referenceLevel,
        candidates,
        theme: forceAuto ? "auto" : this.options.themeId,
        archetype: this.options.archetype,
        customThemes: services().themes.list(),
        outsiderBoss: this.options.outsiderBoss,
        relativeMin: this.options.relativeMin,
        relativeMax: this.options.relativeMax,
        minCount: this.options.minCount,
        maxCount: this.options.maxCount,
        duplicateCap: this.options.duplicateCap,
        excludeUuids,
        excludeThemeIds,
        locked,
        rng: rngFromSeed(seed),
      };
      const result = generateThemedEncounter(input);
      this.lastResult = result;
      this.lastSeed = seed;
      if (result.ok) {
        const previousLocks = new Map(draft.entries.map((e) => [e.uuid, e.locked] as const));
        const entries = mergeEntries(result.entries, previousLocks);
        const newDraft: Draft = {
          entries,
          origin: "generated",
          generation: {
            seed,
            inputs: {
              threat: input.threat,
              partySize: input.partySize,
              referenceLevel,
              theme: result.theme.id,
              themeName: result.theme.name,
              archetype: result.archetype,
              outsiderBoss: result.outsider?.uuid ?? null,
              relativeMin: input.relativeMin,
              relativeMax: input.relativeMax,
              minCount: input.minCount,
              maxCount: input.maxCount,
              duplicateCap: input.duplicateCap,
              excludeUuids,
              packIds: services().catalog.selectedPackIds(),
              traits: this.app.state.filter.traits ?? [],
              tags: this.app.state.filter.tags ?? [],
              rarities: this.app.state.filter.rarities ?? [],
              candidateCount: candidates.length,
            },
          },
        };
        this.app.setDraft(newDraft);
        this.app.pushMessage(
          result.fit === "exact" ? "ok" : "info",
          t(`generator.resultMessage.${result.fit}`, {
            theme: result.theme.name,
            total: result.totalXP,
            target: result.target,
            difference: result.difference,
          }),
        );
      } else {
        this.app.pushMessage("warn", t(`generator.failure.${result.reason}`, result.detail));
      }
    } catch (error) {
      console.error("sargas-encounter-builder | generation failed", error);
      this.app.reportError(error);
    } finally {
      this.busy = false;
    }
    await this.app.render({ parts: ["header", "build", "deploy", "footer"] });
  }
}

function mergeEntries(
  entries: (DraftEntrySource & { quantity: number })[],
  previousLocks: Map<string, boolean>,
): DraftEntry[] {
  const map = new Map<string, DraftEntry>();
  for (const e of entries) {
    const existing = map.get(e.uuid);
    if (existing) existing.quantity += e.quantity;
    else map.set(e.uuid, { ...entryFromCatalog(e, e.quantity), locked: previousLocks.get(e.uuid) ?? false });
  }
  return [...map.values()];
}

function describeCustom(c: CustomThemeRecord): string {
  const parts: string[] = [];
  if (c.requiredTraits.length)
    parts.push(`${t("generator.themes.required")}: ${c.requiredTraits.join(", ")}`);
  if (c.anyTraits.length) parts.push(`${t("generator.themes.any")}: ${c.anyTraits.join(", ")}`);
  if (c.environment) parts.push(`${t("generator.themes.environment")}: ${c.environment}`);
  if (c.candidateUuids.length)
    parts.push(t("generator.themes.uuidCount", { count: c.candidateUuids.length }));
  return parts.join(" · ");
}
