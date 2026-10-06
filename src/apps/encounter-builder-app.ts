/**
 * EncounterBuilderApp: the GM workspace (ApplicationV2 + Handlebars parts).
 *
 * Flow: the start dialog picks party, threat and mode; the header strip keeps them editable;
 * Build, Tables and Deploy stay disabled until the party resolves to a valid reference level.
 * All write operations re-check `game.user.isGM`. Each tab's data and actions live in a panel
 * (./panel.ts); this class owns the shared state, rendering and event routing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MODULE_ID, SETTINGS } from "../constants.js";
import { THREAT_LEVELS, type ThreatLevel } from "../core/budget.js";
import type { CatalogEntry, CatalogFilter } from "../core/catalog.js";
import { emptyDraft, evaluateDraft, type Draft, type DraftEvaluation } from "../core/draft.js";
import type { RosterState } from "../core/party.js";
import {
  ApplicationV2,
  DragDropClass,
  HandlebarsApplicationMixin,
  debounce,
  getDragEventData,
  isGM,
  loadTemplates,
} from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import type { ResolvedParty } from "../foundry/party-service.js";
import { services } from "../foundry/services.js";
import { getSetting } from "../foundry/settings.js";
import { CatalogPanel } from "./catalog-panel.js";
import { DeployPanel } from "./deploy-panel.js";
import { GeneratorPanel } from "./generator-panel.js";
import { handleKeyboardActivation } from "./keyboard.js";
import { route, type Panel, type PanelAction } from "./panel.js";
import { PartyPanel } from "./party-panel.js";
import { SavedPanel } from "./saved-panel.js";
import { activateStartChoice, askStartChoice, saveUiState, type StartChoice } from "./start-dialog.js";
import { TablesPanel } from "./tables-panel.js";
import { TreasurePanel } from "./treasure-panel.js";
import {
  GATED_TABS,
  TABS,
  draftSummary,
  headerContext,
  partySignature,
  tabsContext,
  type TabId,
} from "./view-models.js";

const TEMPLATES = `modules/${MODULE_ID}/templates/builder`;

type BuildMode = "browse" | "generate";

interface Message {
  id: number;
  level: "info" | "warn" | "error" | "ok";
  text: string;
}

/** Info and success messages clear themselves after this long; warnings and errors stay until dismissed. */
const MESSAGE_TTL_MS = 8000;

export interface BuilderState {
  resolved: ResolvedParty | null;
  evaluation: DraftEvaluation | null;
  draft: Draft;
  filter: CatalogFilter;
  results: CatalogEntry[];
  busy: boolean;
  messages: Message[];
  buildMode: BuildMode;
}

/** A party that can be budgeted against: no roster blockers and a reference level. */
export interface ReadyParty {
  resolved: ResolvedParty;
  roster: RosterState;
  referenceLevel: number;
}

const Base = HandlebarsApplicationMixin()(ApplicationV2()) as any;

export class EncounterBuilderApp extends Base {
  static #instance: EncounterBuilderApp | null = null;

  static DEFAULT_OPTIONS = {
    id: MODULE_ID,
    classes: ["seb", "seb-builder"],
    tag: "div",
    window: { title: `${MODULE_ID}.app.title`, icon: "fa-solid fa-dragon", resizable: true },
    position: { width: 1100, height: 780 },
    actions: {
      selectTab: EncounterBuilderApp.#onSelectTab,
      changeParty: EncounterBuilderApp.#onChangeParty,
      setThreat: EncounterBuilderApp.#onSetThreat,
      setBuildMode: EncounterBuilderApp.#onSetBuildMode,
      dismissMessage: EncounterBuilderApp.#onDismissMessage,
      // party
      createProfile: route("party", "createProfile"),
      linkPartyActor: route("party", "linkPartyActor"),
      renameProfile: route("party", "renameProfile"),
      deleteProfile: route("party", "deleteProfile"),
      selectProfile: route("party", "selectProfile"),
      toggleMember: route("party", "toggleMember"),
      toggleCounts: route("party", "toggleCounts"),
      removeMember: route("party", "removeMember"),
      pickMember: route("party", "pickMember"),
      refreshParty: route("party", "refreshParty"),
      // build
      addCreature: route("catalog", "addCreature"),
      inspectCreature: route("catalog", "inspectCreature"),
      removeCreature: route("catalog", "removeCreature"),
      lockCreature: route("catalog", "lockCreature"),
      clearDraft: route("catalog", "clearDraft"),
      refreshCatalog: route("catalog", "refreshCatalog"),
      editTags: route("catalog", "editTags"),
      setRarity: route("catalog", "setRarity"),
      ext: EncounterBuilderApp.#onPanelAction,
      replaceEntry: EncounterBuilderApp.#onReplaceEntry,
    },
  };

  static PARTS = {
    header: { template: `${TEMPLATES}/header.hbs` },
    tabs: { template: `${TEMPLATES}/tabs.hbs` },
    party: { template: `${TEMPLATES}/party.hbs`, scrollable: [".seb-scroll"] },
    build: { template: `${TEMPLATES}/build.hbs`, scrollable: [".seb-scroll"] },
    treasure: { template: `${TEMPLATES}/treasure.hbs`, scrollable: [".seb-scroll"] },
    tables: { template: `${TEMPLATES}/tables.hbs`, scrollable: [".seb-scroll"] },
    saved: { template: `${TEMPLATES}/saved.hbs`, scrollable: [".seb-scroll"] },
    deploy: { template: `${TEMPLATES}/deploy.hbs`, scrollable: [".seb-scroll"] },
    footer: { template: `${TEMPLATES}/footer.hbs` },
  };

  state: BuilderState = {
    resolved: null,
    evaluation: null,
    draft: emptyDraft(),
    filter: { relativeMin: -2, relativeMax: 2 },
    results: [],
    busy: false,
    messages: [],
    buildMode: "generate",
  };
  activeTab: TabId = "build";
  #unsubscribe: (() => void)[] = [];
  #listenersAttached = false;
  #nextMessageId = 1;
  #messageTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Serialised party data last rendered, so unrelated actor updates do not repaint the window. */
  #partySignature = "";
  /** Asked in this order for input changes and drops; keys double as `data-ext` values. */
  readonly panels = {
    party: new PartyPanel(this),
    catalog: new CatalogPanel(this),
    generator: new GeneratorPanel(this),
    deploy: new DeployPanel(this),
    tables: new TablesPanel(this),
    saved: new SavedPanel(this),
    treasure: new TreasurePanel(this),
  };

  /** Open the workspace. With `withDialog`, run the start dialog first (the launcher does). */
  static async open({
    withDialog = true,
  }: { withDialog?: boolean } = {}): Promise<EncounterBuilderApp | null> {
    if (!isGM()) {
      ui.notifications.warn(t("errors.gmOnly"));
      return null;
    }
    await ensurePartials();
    const existing = EncounterBuilderApp.#instance;
    if (existing?.rendered && !withDialog) {
      await existing.render({ force: true });
      return existing;
    }
    const app = (EncounterBuilderApp.#instance ??= new EncounterBuilderApp());
    if (withDialog) {
      // The render below covers the choice; letting the dialog render too paints the window twice.
      const choice = await app.runStartDialog({ render: false });
      if (!choice) return app.rendered ? app : null;
    }
    // All data work happens before render(): ApplicationV2 serialises render/close through a
    // semaphore, so a render awaited from inside _onFirstRender/_onRender deadlocks the window.
    await app.prepare();
    await app.render({ force: true });
    return app;
  }

  static get instance(): EncounterBuilderApp | null {
    return EncounterBuilderApp.#instance;
  }

  /* -------------------------------------------- */
  /*  Start dialog                                */
  /* -------------------------------------------- */

  async runStartDialog({ render = true }: { render?: boolean } = {}): Promise<StartChoice | null> {
    const choice = await askStartChoice();
    if (!choice) return null;
    await this.applyStartChoice(choice, { render });
    return choice;
  }

  async applyStartChoice(choice: StartChoice, { render = true }: { render?: boolean } = {}): Promise<void> {
    const profile = await activateStartChoice(choice);
    switch (choice.mode) {
      case "manual":
        this.activeTab = "build";
        this.state.buildMode = "browse";
        break;
      case "random":
        this.activeTab = "build";
        this.state.buildMode = "generate";
        break;
      case "table":
        this.activeTab = "tables";
        break;
      case "saved":
        this.activeTab = "saved";
        break;
    }
    if (profile.kind === "standalone" && profile.members.length === 0) this.activeTab = "party";
    if (render) await this.refreshParty();
    else await this.#resolveParty();
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** Select default packs and resolve the party. Never renders; safe to call before the first render. */
  async prepare(): Promise<void> {
    const { catalog } = services();
    try {
      await catalog.ensureDefaultSelection();
    } catch (error) {
      console.error(`${MODULE_ID} | default pack selection failed`, error);
    }
    await this.#resolveParty();
    // Search now so the first render already lists results instead of re-rendering Build after it.
    await this.panels.catalog.searchResults();
  }

  async _onFirstRender(context: Record<string, unknown>, options: Record<string, unknown>): Promise<void> {
    await super._onFirstRender?.(context, options);
    const { party, catalog } = services();
    const rerender = debounce(() => void this.refreshParty({ onlyIfChanged: true }), 150);
    this.#unsubscribe.push(
      party.onChange(rerender),
      catalog.onChange(() => this.panels.catalog.onCatalogChanged()),
    );
  }

  _onClose(options: Record<string, unknown>): void {
    super._onClose?.(options);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    for (const panel of this.#panelList()) panel.dispose?.();
    for (const timer of this.#messageTimers.values()) clearTimeout(timer);
    this.#messageTimers.clear();
    this.state.messages = [];
    this.#listenersAttached = false;
    EncounterBuilderApp.#instance = null;
  }

  async _onRender(context: Record<string, unknown>, options: Record<string, unknown>): Promise<void> {
    await super._onRender?.(context, options);
    const root: HTMLElement = this.element;
    for (const section of root.querySelectorAll<HTMLElement>("section.seb-tab")) {
      section.classList.toggle("is-active", section.dataset.tab === this.activeTab);
    }
    if (!this.#listenersAttached) {
      const catalog = this.panels.catalog;
      root.addEventListener("change", (event) => void this.#onChange(event));
      root.addEventListener("input", (event) => catalog.onInput(event));
      root.addEventListener("keydown", (event) => {
        if (!handleKeyboardActivation(event)) catalog.onKeydown(event);
      });
      // Drop-zone highlight, delegated once. Capture phase: the DragDrop drop handler may stop
      // propagation. Moving between a zone's children fires dragleave on the zone, so only clear
      // the highlight when the pointer really left it.
      root.addEventListener("dragenter", (event) => dropzoneOf(event)?.classList.add("is-over"), true);
      root.addEventListener(
        "dragleave",
        (event) => {
          const zone = dropzoneOf(event);
          const next = event.relatedTarget as Node | null;
          if (zone && !(next && zone.contains(next))) zone.classList.remove("is-over");
        },
        true,
      );
      root.addEventListener("drop", (event) => dropzoneOf(event)?.classList.remove("is-over"), true);
      this.#listenersAttached = true;
    }
    try {
      const DragDrop = DragDropClass();
      if (DragDrop) {
        new DragDrop({
          dropSelector: ".seb-dropzone",
          permissions: { dragstart: () => false, drop: () => isGM() },
          callbacks: { drop: (event: DragEvent) => void this.#onDrop(event) },
        }).bind(root);
      }
    } catch (error) {
      console.error(`${MODULE_ID} | drag-drop binding failed`, error);
    }
  }

  /* -------------------------------------------- */
  /*  Data refresh                                */
  /* -------------------------------------------- */

  /** The party when it can be budgeted against, else null (see `ready`). */
  get readyParty(): ReadyParty | null {
    const resolved = this.state.resolved;
    const roster = resolved?.roster;
    if (!resolved || !roster || roster.blockers.length > 0 || roster.reference.level === null) return null;
    return { resolved, roster, referenceLevel: roster.reference.level };
  }

  get ready(): boolean {
    return this.readyParty !== null;
  }

  async #resolveParty(): Promise<void> {
    const { party, adapter } = services();
    this.state.resolved = await party.resolveActive();
    this.#partySignature = partySignature(this.state.resolved, party.profiles(), adapter.listPartyActors());
    this.recomputeEvaluation();
    if (!this.ready && GATED_TABS.includes(this.activeTab)) this.activeTab = "party";
  }

  /**
   * Re-resolve the active party and repaint what depends on it. With `onlyIfChanged` (actor and
   * profile change events) nothing renders when the party data is the same as last time.
   */
  async refreshParty({ onlyIfChanged = false }: { onlyIfChanged?: boolean } = {}): Promise<void> {
    const previousRef = this.state.resolved?.roster.reference.level ?? null;
    const previous = this.#partySignature;
    await this.#resolveParty();
    if (onlyIfChanged && this.#partySignature === previous) return;
    // Relative-level filters are applied against the reference level.
    if ((this.state.resolved?.roster.reference.level ?? null) !== previousRef)
      await this.panels.catalog.searchResults();
    if (!this.rendered) return;
    // Every panel depends on the roster, but hidden tabs re-render when shown (#onSelectTab), so
    // only the visible one is painted now.
    const parts = new Set<string>(["header", "tabs", "party", this.activeTab, "footer"]);
    await this.render({ parts: [...parts] });
  }

  recomputeEvaluation(): void {
    const party = this.readyParty;
    if (!party) {
      this.state.evaluation = null;
      return;
    }
    const { adapter } = services();
    const variant = adapter.variantInfo();
    this.state.evaluation = evaluateDraft(this.state.draft, {
      partySize: party.roster.partySize,
      referenceLevel: party.referenceLevel,
      selectedThreat: party.resolved.profile.selectedThreat,
      pwol: variant.pwol,
      pwolCreatureXP: (ref, lvl) => adapter.pwolCreatureXP(ref, lvl),
    });
    this.#crossCheck();
    Hooks.callAll(`${MODULE_ID}.evaluationChanged`, this.state.evaluation);
  }

  #crossCheck(): void {
    const evaluation = this.state.evaluation;
    if (
      !evaluation ||
      !getSetting<boolean>(SETTINGS.debugMode) ||
      evaluation.systemCalculation ||
      !evaluation.complete
    )
      return;
    const helper = services().adapter.systemXPHelper();
    if (!helper.available) return;
    const levels = evaluation.entries.flatMap((e) => Array<number>(e.quantity).fill(e.level));
    const systemTotal = helper.total(evaluation.referenceLevel, evaluation.partySize, levels, false);
    if (systemTotal !== null && systemTotal !== evaluation.supportedXP) {
      console.warn(
        `${MODULE_ID} | XP cross-check mismatch: module ${evaluation.supportedXP}, system ${systemTotal}`,
      );
      this.pushMessage(
        "warn",
        t("messages.crossCheckMismatch", { module: evaluation.supportedXP, system: systemTotal }),
      );
    }
  }

  setDraft(draft: Draft, { origin }: { origin?: Draft["origin"] } = {}): void {
    const before = new Set(this.state.draft.entries.map((e) => e.uuid));
    this.state.draft = origin ? { ...draft, origin } : draft;
    this.recomputeEvaluation();
    // A wholly different encounter (cleared, generated anew, opened from Saved) must not carry the
    // hoard rolled for the previous one; edits that keep at least one creature keep it.
    const sharesCreature = draft.entries.some((e) => before.has(e.uuid));
    if (!sharesCreature) for (const panel of this.#panelList()) panel.onDraftReplaced?.();
  }

  /** Queue a header message (the newest three are kept); the caller renders. */
  pushMessage(level: Message["level"], text: string): void {
    const id = this.#nextMessageId++;
    const kept = this.state.messages.slice(-2);
    for (const dropped of this.state.messages.slice(0, -2)) this.#clearMessageTimer(dropped.id);
    this.state.messages = [...kept, { id, level, text }];
    if (level === "info" || level === "ok") {
      this.#messageTimers.set(
        id,
        setTimeout(() => void this.dismissMessage(id), MESSAGE_TTL_MS),
      );
    }
  }

  /** Remove a header message and repaint the header if it was showing. */
  async dismissMessage(id: number): Promise<void> {
    this.#clearMessageTimer(id);
    const before = this.state.messages.length;
    this.state.messages = this.state.messages.filter((m) => m.id !== id);
    if (this.state.messages.length !== before && this.rendered) await this.render({ parts: ["header"] });
  }

  #clearMessageTimer(id: number): void {
    const timer = this.#messageTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#messageTimers.delete(id);
  }

  /** Queue the generic error message for `error`; the caller renders. */
  reportError(error: unknown): void {
    this.pushMessage(
      "error",
      t("errors.generic", { message: error instanceof Error ? error.message : String(error) }),
    );
  }

  #panelList(): Panel[] {
    return Object.values(this.panels);
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** Context every part may use. Panel data is built per part in `_preparePartContext`. */
  async _prepareContext(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = (await super._prepareContext?.(options)) ?? {};
    const roster = this.state.resolved?.roster ?? null;
    return {
      ...base,
      activeTab: this.activeTab,
      isGM: isGM(),
      ready: this.ready,
      busy: this.state.busy,
      messages: this.state.messages,
      gate: {
        title: t("gate.title"),
        hint: roster
          ? roster.blockers.map((code) => t(`party.blockers.${code}`)).join(" ")
          : t("gate.noParty"),
      },
    };
  }

  /**
   * Build only the data the part being rendered uses: a render of ["header"] must not run the
   * generator's theme derivation, the deploy preview or the saved-encounter list.
   */
  async _preparePartContext(
    partId: string,
    context: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ctx: Record<string, unknown> =
      (await super._preparePartContext?.(partId, context, options)) ?? context;
    switch (partId) {
      case "header":
        ctx.header = headerContext(
          this.state.resolved,
          this.state.evaluation,
          services().adapter.variantInfo().pwol,
        );
        break;
      case "tabs":
        ctx.tabs = tabsContext(this.activeTab, this.ready);
        break;
      case "build":
        ctx.build = await this.panels.catalog.prepareContext();
        ctx.generator = await this.panels.generator.prepareContext();
        break;
      case "footer":
        ctx.footer = this.#footerContext();
        break;
      default:
        if (Object.hasOwn(this.panels, partId)) {
          const panel: Panel = this.panels[partId as keyof typeof this.panels];
          ctx[partId] = panel.prepareContext ? await panel.prepareContext() : undefined;
        }
    }
    return ctx;
  }

  #footerContext(): Record<string, unknown> {
    const { catalog } = services();
    return {
      packCount: catalog.selectedPackIds().length,
      catalogCount: catalog.entries().length,
      version: game.modules.get(MODULE_ID)?.version ?? "",
      ...draftSummary(this.state.draft),
    };
  }

  /* -------------------------------------------- */
  /*  Input handling                              */
  /* -------------------------------------------- */

  async #onChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (!target?.name || !isGM()) return;
    for (const panel of this.#panelList()) {
      if (panel.onChange && (await panel.onChange(target.name, target.value, target))) return;
    }
  }

  async #onDrop(event: DragEvent): Promise<void> {
    if (!isGM()) return;
    const data = getDragEventData(event);
    const zone = (event.target as HTMLElement).closest<HTMLElement>(".seb-dropzone");
    const purpose = zone?.dataset.purpose;
    for (const panel of this.#panelList()) {
      if (panel.onDrop && (await panel.onDrop(purpose, data))) return;
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** `data-action="ext"`: call a whitelisted panel method (`data-ext`, `data-method`). */
  static async #onPanelAction(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const key = target.dataset.ext ?? "";
    const method = target.dataset.method ?? "";
    const panel: Panel | undefined = Object.hasOwn(this.panels, key)
      ? this.panels[key as keyof typeof this.panels]
      : undefined;
    if (!panel?.actions?.has(method)) return;
    const fn = (panel as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") return;
    const uuid = target.dataset.uuid ?? target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    try {
      await (fn as PanelAction).call(panel, uuid, target);
    } catch (error) {
      console.error(`${MODULE_ID} | ${key}.${method} failed`, error);
      this.reportError(error);
      await this.render({ parts: ["header"] });
    }
  }

  static async #onReplaceEntry(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (uuid) await this.panels.generator.replaceEntry(uuid);
  }

  static async #onSelectTab(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const tab = target.dataset.tab as TabId | undefined;
    if (!tab || !TABS.includes(tab)) return;
    // Gated tab buttons are disabled until the party is ready; this only guards stale markup.
    if (GATED_TABS.includes(tab) && !this.ready) return;
    this.activeTab = tab;
    for (const panel of this.#panelList()) panel.onTabShown?.(tab);
    // Re-rendering the tab strip replaces the focused button; keep keyboard focus on the new tab.
    const hadFocus = target.closest('[role="tablist"]')?.contains(document.activeElement) ?? false;
    await this.render({ parts: ["tabs", tab] });
    if (hadFocus) (this.element as HTMLElement).querySelector<HTMLElement>(`#seb-tab-${tab}`)?.focus();
  }

  static async #onDismissMessage(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const id = Number(target.dataset.id);
    if (Number.isFinite(id)) await this.dismissMessage(id);
  }

  static async #onChangeParty(this: EncounterBuilderApp): Promise<void> {
    await this.runStartDialog();
  }

  static async #onSetThreat(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const threat = target.dataset.value as ThreatLevel | undefined;
    const profile = this.state.resolved?.profile;
    if (!threat || !profile || !THREAT_LEVELS.includes(threat)) return;
    await services().party.setThreat(profile.id, threat);
    await saveUiState({ lastThreat: threat });
  }

  static async #onSetBuildMode(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const mode = target.dataset.value as BuildMode | undefined;
    if (mode !== "browse" && mode !== "generate") return;
    this.state.buildMode = mode;
    await saveUiState({ lastMode: mode === "browse" ? "manual" : "random" });
    await this.render({ parts: ["build"] });
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

export const PARTIALS = [
  `${TEMPLATES}/generator.hbs`,
  `${TEMPLATES}/meter.hbs`,
  `${TEMPLATES}/snapshot.hbs`,
  `${TEMPLATES}/creature-row.hbs`,
  `${TEMPLATES}/catalog-list.hbs`,
];
let partialsLoaded = false;
export async function ensurePartials(): Promise<void> {
  if (partialsLoaded) return;
  await loadTemplates([...PARTIALS, `modules/${MODULE_ID}/templates/start-dialog.hbs`]);
  partialsLoaded = true;
}

/** The drop zone a drag event is over, if any (events are delegated from the app root). */
function dropzoneOf(event: Event): HTMLElement | null {
  const target = event.target;
  return target instanceof Element ? target.closest<HTMLElement>(".seb-dropzone") : null;
}
