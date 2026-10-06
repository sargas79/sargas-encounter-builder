/**
 * EncounterBuilderApp: the GM workspace (ApplicationV2 + Handlebars parts).
 *
 * Flow: the start dialog picks party, threat and mode; the header strip keeps them editable;
 * Build, Tables and Deploy stay disabled until the party resolves to a valid reference level.
 * All write operations re-check `game.user.isGM`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MODULE_ID, SETTINGS } from "../constants.js";
import { THREAT_LEVELS, tierBudget, type ReferenceLevelPolicy, type ThreatLevel } from "../core/budget.js";
import type { CatalogEntry, CatalogFilter } from "../core/catalog.js";
import {
  addEntry,
  emptyDraft,
  entryFromCatalog,
  evaluateDraft,
  removeEntry,
  setQuantity,
  toggleLock,
  totalCreatures,
  type Draft,
  type DraftEvaluation,
} from "../core/draft.js";
import type { RosterState } from "../core/party.js";
import { escapeHtml, splitList } from "../core/util.js";
import {
  ApplicationV2,
  DialogV2,
  DragDropClass,
  HandlebarsApplicationMixin,
  debounce,
  getDragEventData,
  isGM,
  loadTemplates,
  renderTemplate,
} from "../foundry/compat.js";
import { t } from "../foundry/i18n.js";
import type { ResolvedParty } from "../foundry/party-service.js";
import { services } from "../foundry/services.js";
import { getSetting, setSetting } from "../foundry/settings.js";
import { DeployPanel } from "./deploy-panel.js";
import { GeneratorPanel } from "./generator-panel.js";
import { SavedPanel } from "./saved-panel.js";
import { showStartDialog, type StartChoice, type StartMode } from "./start-dialog.js";
import { TablesPanel } from "./tables-panel.js";
import { TreasurePanel } from "./treasure-panel.js";

const TEMPLATES = `modules/${MODULE_ID}/templates/builder`;

export type TabId = "party" | "build" | "treasure" | "tables" | "saved" | "deploy";
const TABS: TabId[] = ["party", "build", "treasure", "tables", "saved", "deploy"];
const GATED_TABS: TabId[] = ["build", "treasure", "tables", "deploy"];
type BuildMode = "browse" | "generate";

interface Message {
  level: "info" | "warn" | "error" | "ok";
  text: string;
}

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

interface UiState {
  lastParty?: string;
  lastMode?: StartMode;
  lastThreat?: ThreatLevel;
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
      // party
      createProfile: EncounterBuilderApp.#onCreateProfile,
      linkPartyActor: EncounterBuilderApp.#onLinkPartyActor,
      renameProfile: EncounterBuilderApp.#onRenameProfile,
      deleteProfile: EncounterBuilderApp.#onDeleteProfile,
      selectProfile: EncounterBuilderApp.#onSelectProfile,
      toggleMember: EncounterBuilderApp.#onToggleMember,
      toggleCounts: EncounterBuilderApp.#onToggleCounts,
      removeMember: EncounterBuilderApp.#onRemoveMember,
      pickMember: EncounterBuilderApp.#onPickMember,
      refreshParty: EncounterBuilderApp.#onRefreshParty,
      // build
      addCreature: EncounterBuilderApp.#onAddCreature,
      inspectCreature: EncounterBuilderApp.#onInspectCreature,
      removeCreature: EncounterBuilderApp.#onRemoveCreature,
      lockCreature: EncounterBuilderApp.#onLockCreature,
      clearDraft: EncounterBuilderApp.#onClearDraft,
      refreshCatalog: EncounterBuilderApp.#onRefreshCatalog,
      editTags: EncounterBuilderApp.#onEditTags,
      setRarity: EncounterBuilderApp.#onSetRarity,
      ext: EncounterBuilderApp.#onExtensionAction,
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
  #catalogMuted = 0;
  /** Serialised party data last rendered, so unrelated actor updates do not repaint the window. */
  #partySignature = "";
  #search = debounce(() => void this.#runSearch(), 250);
  extensions: Record<string, unknown> = {
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
    const { party, adapter } = services();
    const ui = this.#uiState();
    const active = party.activeProfile();
    const initialParty =
      ui.lastParty ??
      (active
        ? active.kind === "linked" && active.partyActorUuid
          ? `actor:${active.partyActorUuid}`
          : `profile:${active.id}`
        : undefined);
    const choice = await showStartDialog({
      partyActors: adapter.listPartyActors(),
      profiles: party.profiles(),
      initial: {
        party: initialParty,
        threat: active?.selectedThreat ?? ui.lastThreat,
        mode: ui.lastMode,
        policy: active?.referencePolicy ?? undefined,
        manualLevel: active?.manualReferenceLevel ?? null,
      },
    });
    if (!choice) return null;
    await this.applyStartChoice(choice, { render });
    return choice;
  }

  async applyStartChoice(choice: StartChoice, { render = true }: { render?: boolean } = {}): Promise<void> {
    const { party, adapter } = services();
    let profile = null as import("../core/schemas.js").PartyProfile | null;
    if (choice.party.startsWith("actor:")) {
      const uuid = choice.party.slice("actor:".length);
      profile = party.profiles().find((p) => p.kind === "linked" && p.partyActorUuid === uuid) ?? null;
      if (!profile) {
        const actor = adapter.listPartyActors().find((a) => a.uuid === uuid);
        profile = await party.createProfile(actor?.name ?? t("party.defaultName"), "linked", uuid);
      }
    } else if (choice.party.startsWith("profile:")) {
      profile = party.getProfile(choice.party.slice("profile:".length));
    }
    if (!profile) profile = await party.createProfile(t("party.defaultName"), "standalone");
    await party.updateProfile({
      ...profile,
      selectedThreat: choice.threat,
      referencePolicy: choice.policy,
      manualReferenceLevel: choice.manualLevel,
    });
    await party.setActive(profile.id);
    await this.#saveUiState({ lastParty: choice.party, lastMode: choice.mode, lastThreat: choice.threat });
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

  #uiState(): UiState {
    try {
      return (getSetting<UiState>(SETTINGS.uiState) ?? {}) as UiState;
    } catch {
      return {};
    }
  }

  async #saveUiState(patch: UiState): Promise<void> {
    try {
      await setSetting(SETTINGS.uiState, { ...this.#uiState(), ...patch });
    } catch {
      /* client setting unavailable in tests */
    }
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
    await this.#searchResults();
  }

  async _onFirstRender(context: Record<string, unknown>, options: Record<string, unknown>): Promise<void> {
    await super._onFirstRender?.(context, options);
    const { party, catalog } = services();
    const rerender = debounce(() => void this.refreshParty({ onlyIfChanged: true }), 150);
    // Catalog changes (pack selection, index reloads, tags) re-run the debounced search, which
    // renders Build once. Actions that search right after changing the catalog mute this.
    const onCatalog = () => {
      if (this.#catalogMuted === 0) this.#search();
    };
    this.#unsubscribe.push(party.onChange(rerender), catalog.onChange(onCatalog));
  }

  _onClose(options: Record<string, unknown>): void {
    super._onClose?.(options);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    for (const ext of Object.values(this.extensions)) (ext as { dispose?: () => void }).dispose?.();
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
      root.addEventListener("change", (event) => void this.#onChange(event));
      root.addEventListener("input", (event) => this.#onInput(event));
      root.addEventListener("keydown", (event) => this.#onKeydown(event));
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

  get ready(): boolean {
    const roster = this.state.resolved?.roster;
    return !!roster && roster.blockers.length === 0 && roster.reference.level !== null;
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
    if ((this.state.resolved?.roster.reference.level ?? null) !== previousRef) await this.#searchResults();
    if (!this.rendered) return;
    // Every panel depends on the roster, but hidden tabs re-render when shown (#onSelectTab), so
    // only the visible one is painted now.
    const parts = new Set<string>(["header", "tabs", "party", this.activeTab, "footer"]);
    await this.render({ parts: [...parts] });
  }

  recomputeEvaluation(): void {
    const resolved = this.state.resolved;
    const roster = resolved?.roster;
    if (!resolved || !roster || !this.ready) {
      this.state.evaluation = null;
      return;
    }
    const { adapter } = services();
    const variant = adapter.variantInfo();
    this.state.evaluation = evaluateDraft(this.state.draft, {
      partySize: roster.partySize,
      referenceLevel: roster.reference.level!,
      selectedThreat: resolved.profile.selectedThreat,
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
    if (!sharesCreature) {
      const treasure = this.extensions.treasure as { onDraftReplaced?: () => void } | undefined;
      treasure?.onDraftReplaced?.();
    }
  }

  pushMessage(level: Message["level"], text: string): void {
    this.state.messages = [...this.state.messages.slice(-2), { level, text }];
  }

  /** Query the catalog into `state.results`. Never renders. */
  async #searchResults(): Promise<void> {
    const { catalog } = services();
    const ref = this.state.resolved?.roster.reference.level ?? null;
    try {
      this.state.results = (await catalog.search({ ...this.state.filter, referenceLevel: ref })).slice(
        0,
        200,
      );
    } catch (error) {
      console.error(`${MODULE_ID} | search failed`, error);
      this.state.results = [];
    }
  }

  async #runSearch(): Promise<void> {
    await this.#searchResults();
    if (!this.rendered) return;
    // Re-rendering the part while the GM is typing replaces the search box under the caret, which
    // drops keystrokes and breaks dead-key/IME input. Patch the list in place instead.
    if (this.#searchHasFocus()) {
      await this.#patchCatalogList();
      await this.render({ parts: ["footer"] });
    } else await this.render({ parts: ["build", "footer"] });
  }

  /** Run a catalog mutation without the change event's own search; the caller searches after. */
  async #muteCatalog<T>(fn: () => Promise<T> | T): Promise<T> {
    this.#catalogMuted++;
    try {
      return await fn();
    } finally {
      this.#catalogMuted--;
    }
  }

  #searchHasFocus(): boolean {
    const active = document.activeElement as HTMLInputElement | null;
    return !!active && active.name === "filter.search" && this.element.contains(active);
  }

  /** Swap only the catalog rows and count, leaving the filter inputs (and their focus) untouched. */
  async #patchCatalogList(): Promise<void> {
    const root: HTMLElement = this.element;
    const list = root.querySelector<HTMLElement>(".seb-catalog-list");
    if (!list) return;
    const { catalog } = services();
    const build = {
      noPacks: catalog.selectedPackIds().length === 0,
      results: this.#resultsContext(),
    };
    list.innerHTML = await renderTemplate(`${TEMPLATES}/catalog-list.hbs`, { busy: this.state.busy, build });
    const count = root.querySelector<HTMLElement>(".seb-catalog-count");
    if (count) count.textContent = String(this.state.results.length);
  }

  #resultsContext(): Record<string, unknown>[] {
    const ref = this.state.resolved?.roster.reference.level ?? null;
    return this.state.results.map((entry) => ({
      ...entry,
      relative: ref != null ? signed(entry.level - ref) : "",
      traitsShort: entry.traits.slice(0, 4),
      moreTraits: Math.max(0, entry.traits.length - 4),
      rarityClass: entry.rarity !== "common" ? `is-${entry.rarity}` : "",
    }));
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
        ctx.header = this.#headerContext(
          this.state.resolved,
          this.state.evaluation,
          services().adapter.variantInfo().pwol,
        );
        break;
      case "tabs":
        ctx.tabs = this.#tabsContext();
        break;
      case "party":
        ctx.party = this.#partyContext();
        break;
      case "build":
        ctx.build = this.#buildContext();
        ctx.generator = await this.#extensionContext("generator");
        break;
      case "footer":
        ctx.footer = this.#footerContext();
        break;
      default:
        if (partId in this.extensions) ctx[partId] = await this.#extensionContext(partId);
    }
    return ctx;
  }

  async #extensionContext(key: string): Promise<Record<string, unknown> | undefined> {
    const ext = this.extensions[key] as
      { prepareContext?: () => Promise<Record<string, unknown>> } | undefined;
    return ext?.prepareContext ? await ext.prepareContext() : undefined;
  }

  #tabsContext(): Record<string, unknown>[] {
    const ready = this.ready;
    return TABS.map((id) => ({
      id,
      label: t(`tabs.${id}`),
      icon: TAB_ICONS[id],
      active: id === this.activeTab,
      disabled: GATED_TABS.includes(id) && !ready,
      tooltip: GATED_TABS.includes(id) && !ready ? t("gate.tooltip") : "",
    }));
  }

  #partyContext(): Record<string, unknown> {
    const { party, adapter } = services();
    const resolved = this.state.resolved;
    const roster = resolved?.roster ?? null;
    return {
      profiles: party.profiles().map((p) => ({
        ...p,
        selected: p.id === resolved?.profile.id,
        kindLabel: t(`party.kind.${p.kind}`),
        count: p.members.length,
      })),
      profile: resolved?.profile ?? null,
      isLinked: resolved?.profile.kind === "linked",
      partyActors: adapter.listPartyActors(),
      roster: roster ? this.#rosterContext(roster) : null,
      policies: (["averageFloor", "highest", "lowest", "manual"] as ReferenceLevelPolicy[]).map((value) => ({
        value,
        label: t(`party.policy.${value}`),
        selected: resolved?.profile.referencePolicy === value,
      })),
      showPolicy: !!roster && roster.reference.distinctLevels.length > 1,
      manualLevel: resolved?.profile.manualReferenceLevel ?? "",
      isManual: resolved?.profile.referencePolicy === "manual",
      blockers: roster?.blockers.map((code) => t(`party.blockers.${code}`)) ?? [],
    };
  }

  #buildContext(): Record<string, unknown> {
    const { catalog } = services();
    const evaluation = this.state.evaluation;
    const selectedPacks = new Set(catalog.selectedPackIds());
    const packs = catalog.availablePacks().map((p) => ({
      ...p,
      selected: selectedPacks.has(p.id),
      stateLabel: describePackState(catalog.packState(p.id)),
    }));
    return {
      mode: this.state.buildMode,
      isBrowse: this.state.buildMode === "browse",
      isGenerate: this.state.buildMode === "generate",
      filter: this.state.filter,
      results: this.#resultsContext(),
      resultCount: this.state.results.length,
      draft: this.state.draft.entries.map((entry) => {
        const ev = evaluation?.entries.find((e) => e.id === entry.uuid);
        return {
          ...entry,
          xpEach: ev?.xpEach ?? null,
          subtotal: ev?.subtotal ?? null,
          status: ev?.status ?? "supported",
          relative: ev ? signed(ev.relativeLevel) : "",
          statusLabel: ev && ev.status !== "supported" ? t(`evaluation.status.${ev.status}`) : "",
        };
      }),
      ...this.#draftSummary(),
      meter: evaluation ? meterContext(evaluation) : null,
      packs,
      packCount: selectedPacks.size,
      missingPacks: catalog.missingSelectedPackIds(),
      noPacks: selectedPacks.size === 0,
      traits: this.state.filter.traits?.join(", ") ?? "",
      tags: this.state.filter.tags?.join(", ") ?? "",
      rarity: this.state.filter.rarities?.[0] ?? "",
      rarities: ["", "common", "uncommon", "rare", "unique"].map((value) => ({
        value,
        label: value ? t(`rarity.${value}`) : t("build.anyRarity"),
        active: (this.state.filter.rarities?.[0] ?? "") === value,
      })),
      allTags: services().tags.allTags(),
    };
  }

  #draftSummary(): { draftCount: number; hasDraft: boolean; originLabel: string } {
    return {
      draftCount: totalCreatures(this.state.draft),
      hasDraft: this.state.draft.entries.length > 0,
      originLabel: t(`saved.origin.${this.state.draft.origin}`),
    };
  }

  #footerContext(): Record<string, unknown> {
    const { catalog } = services();
    return {
      packCount: catalog.selectedPackIds().length,
      catalogCount: catalog.entries().length,
      version: game.modules.get(MODULE_ID)?.version ?? "",
      ...this.#draftSummary(),
    };
  }

  #headerContext(
    resolved: ResolvedParty | null,
    evaluation: DraftEvaluation | null,
    pwol: boolean,
  ): Record<string, unknown> {
    const roster = resolved?.roster ?? null;
    const ref = roster?.reference;
    const threats = THREAT_LEVELS.map((threat) => {
      const tier = roster && roster.partySize > 0 ? tierBudget(threat, roster.partySize) : null;
      return {
        value: threat,
        label: t(`threat.${threat}`),
        target: tier ? (tier.available ? `${tier.target} XP` : t("party.unavailable")) : "",
        active: resolved?.profile.selectedThreat === threat,
        disabled: tier ? !tier.available : false,
      };
    });
    return {
      hasParty: !!resolved,
      partyName: resolved?.profile.name ?? t("party.none"),
      sourceLabel: resolved ? t(`party.kind.${resolved.profile.kind}`) : "",
      participating: roster?.partySize ?? 0,
      levels: roster ? roster.counted.map((m) => m.level).join(" · ") || "—" : "—",
      referenceLevel: ref?.level ?? "—",
      policy: ref?.policy ? t(`party.policy.${ref.policy}`) : "",
      isEstimate: !!ref?.isEstimate,
      threats,
      target: evaluation?.tier ? (evaluation.tier.available ? evaluation.tier.target : null) : null,
      pwol,
      variantUnsupported: evaluation?.variantUnsupported ?? false,
      systemCalculation: evaluation?.systemCalculation ?? false,
      blockers: roster?.blockers.map((code) => t(`party.blockers.${code}`)) ?? [],
      missing: roster?.missing.length ?? 0,
    };
  }

  #rosterContext(roster: RosterState): Record<string, unknown> {
    return {
      members: roster.members.map((m) => ({
        ...m,
        statusLabel: t(`party.status.${m.reason}`),
        rowClass:
          m.status === "inactive"
            ? "is-inactive"
            : m.status === "missing"
              ? "is-missing"
              : m.status === "notCounted"
                ? "is-muted"
                : "",
        counted: m.status === "counted" || m.status === "overrideCounted",
        canToggleCounts: m.type === "npc" && m.status !== "missing",
        level: m.level ?? "?",
        typeLabel:
          t(`actorType.${m.type}`) === `${MODULE_ID}.actorType.${m.type}` ? m.type : t(`actorType.${m.type}`),
      })),
      partySize: roster.partySize,
      distinctLevels: roster.reference.distinctLevels.join(", "),
      missingCount: roster.missing.length,
    };
  }

  /* -------------------------------------------- */
  /*  Input handling                              */
  /* -------------------------------------------- */

  #onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target?.name === "filter.search") {
      this.state.filter.search = target.value;
      this.#search();
    }
  }

  #onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLInputElement;
    if (event.key === "Enter" && target?.name === "filter.search") {
      event.preventDefault();
      // The debounced search may not have run yet: query now and add the first fresh match.
      this.state.filter.search = target.value;
      void this.#runSearch().then(() => {
        const first = this.state.results[0];
        if (!first) return;
        this.setDraft(addEntry(this.state.draft, entryFromCatalog(first)));
        return this.render({ parts: ["build", "deploy", "footer"] });
      });
    }
  }

  async #onChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (!target?.name || !isGM()) return;
    const { party, catalog } = services();
    const profile = this.state.resolved?.profile;
    const value = target.value;
    switch (target.name) {
      case "activeProfile":
        await party.setActive(value);
        return;
      case "referencePolicy":
        if (profile)
          await party.setReferencePolicy(
            profile.id,
            (value || null) as ReferenceLevelPolicy | null,
            profile.manualReferenceLevel,
          );
        return;
      case "manualReferenceLevel":
        if (profile) await party.setReferencePolicy(profile.id, "manual", Number.parseInt(value, 10) || null);
        return;
      case "quantity": {
        const uuid = (target.closest("[data-uuid]") as HTMLElement | null)?.dataset.uuid;
        if (uuid) {
          this.setDraft(setQuantity(this.state.draft, uuid, Number.parseInt(value, 10)));
          await this.render({ parts: ["build", "deploy", "footer"] });
        }
        return;
      }
      case "filter.levelMin":
      case "filter.levelMax":
      case "filter.relativeMin":
      case "filter.relativeMax": {
        const key = target.name.slice("filter.".length) as
          "levelMin" | "levelMax" | "relativeMin" | "relativeMax";
        this.state.filter[key] = value === "" ? null : Number.parseInt(value, 10);
        this.#search();
        return;
      }
      case "filter.traits":
        this.state.filter.traits = splitList(value);
        this.#search();
        return;
      case "filter.tags":
        this.state.filter.tags = splitList(value);
        this.#search();
        return;
      case "pack": {
        const id = target.dataset.packId;
        if (!id) return;
        const selected = new Set(catalog.selectedPackIds());
        if ((target as HTMLInputElement).checked) selected.add(id);
        else selected.delete(id);
        // The catalog change event runs the (debounced) search and renders Build once.
        await catalog.setSelectedPacks([...selected]);
        return;
      }
      default: {
        for (const ext of Object.values(this.extensions)) {
          const fn = (
            ext as {
              onChange?: (name: string, value: string, target: HTMLElement) => Promise<boolean> | boolean;
            }
          ).onChange;
          if (fn && (await fn.call(ext, target.name, value, target))) return;
        }
      }
    }
  }

  async #onDrop(event: DragEvent): Promise<void> {
    if (!isGM()) return;
    const data = getDragEventData(event);
    const zone = (event.target as HTMLElement).closest<HTMLElement>(".seb-dropzone");
    const purpose = zone?.dataset.purpose;
    const isActor = data?.type === "Actor" && typeof data.uuid === "string";
    if (purpose === "party" || purpose === "draft") {
      if (!isActor) {
        this.pushMessage("warn", t("messages.dropNotActor"));
        await this.render({ parts: ["header"] });
        return;
      }
      if (purpose === "party") await this.#addPartyMember(data.uuid);
      else await this.#addDraftFromUuid(data.uuid);
      return;
    }
    for (const ext of Object.values(this.extensions)) {
      const fn = (
        ext as {
          onDrop?: (purpose: string | undefined, data: Record<string, unknown>) => Promise<boolean> | boolean;
        }
      ).onDrop;
      if (fn && (await fn.call(ext, purpose, data))) return;
    }
  }

  async #addPartyMember(uuid: string): Promise<void> {
    const { party } = services();
    const profile = this.state.resolved?.profile;
    if (!profile) {
      this.pushMessage("warn", t("party.noProfile"));
      await this.render({ parts: ["header"] });
      return;
    }
    const result = await party.addMember(profile.id, uuid);
    if (!result.ok) {
      this.pushMessage("warn", t(`party.reject.${result.reason}`));
      await this.render({ parts: ["header"] });
    }
  }

  async #addDraftFromUuid(uuid: string): Promise<void> {
    const { catalog } = services();
    const entry = await catalog.locate(uuid);
    if (entry) this.setDraft(addEntry(this.state.draft, entryFromCatalog(entry)));
    else {
      const doc = (await fromUuid(uuid)) as ActorDocument | null;
      if (!doc || doc.type !== "npc" || typeof doc.level !== "number") {
        this.pushMessage("warn", t("messages.dropNotNpc"));
        await this.render({ parts: ["header"] });
        return;
      }
      this.setDraft(
        addEntry(this.state.draft, {
          uuid,
          name: doc.name,
          level: doc.level,
          quantity: 1,
          locked: false,
          img: doc.img ?? null,
          packLabel: doc.pack ?? t("build.worldActor"),
          traits: Array.isArray(doc.system?.traits?.value) ? doc.system.traits.value : [],
        }),
      );
    }
    await this.render({ parts: ["build", "deploy", "footer"] });
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onExtensionAction(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const ext = this.extensions[target.dataset.ext ?? ""] as Record<string, unknown> | undefined;
    const method = target.dataset.method ?? "";
    const fn = ext?.[method];
    if (typeof fn !== "function") return;
    const uuid = target.dataset.uuid ?? target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    try {
      await (fn as (arg?: string, target?: HTMLElement) => Promise<void>).call(ext, uuid, target);
    } catch (error) {
      console.error(`${MODULE_ID} | ${target.dataset.ext}.${method} failed`, error);
      this.pushMessage(
        "error",
        t("errors.generic", { message: error instanceof Error ? error.message : String(error) }),
      );
      await this.render({ parts: ["header"] });
    }
  }

  static async #onReplaceEntry(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    const generator = this.extensions.generator as { replaceEntry(uuid: string): Promise<void> } | undefined;
    if (uuid && generator) await generator.replaceEntry(uuid);
  }

  static async #onSelectTab(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const tab = target.dataset.tab as TabId | undefined;
    if (!tab || !TABS.includes(tab)) return;
    if (GATED_TABS.includes(tab) && !this.ready) {
      this.pushMessage("warn", t("gate.tooltip"));
      await this.render({ parts: ["header"] });
      return;
    }
    this.activeTab = tab;
    for (const ext of Object.values(this.extensions))
      (ext as { onTabShown?: (tab: TabId) => void }).onTabShown?.(tab);
    await this.render({ parts: ["tabs", tab] });
  }

  static async #onChangeParty(this: EncounterBuilderApp): Promise<void> {
    await this.runStartDialog();
  }

  static async #onSetThreat(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const threat = target.dataset.value as ThreatLevel | undefined;
    const profile = this.state.resolved?.profile;
    if (!threat || !profile || !THREAT_LEVELS.includes(threat)) return;
    await services().party.setThreat(profile.id, threat);
    await this.#saveUiState({ lastThreat: threat });
  }

  static async #onSetBuildMode(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const mode = target.dataset.value as BuildMode | undefined;
    if (mode !== "browse" && mode !== "generate") return;
    this.state.buildMode = mode;
    await this.#saveUiState({ lastMode: mode === "browse" ? "manual" : "random" });
    await this.render({ parts: ["build"] });
  }

  static async #onCreateProfile(this: EncounterBuilderApp): Promise<void> {
    if (!isGM()) return;
    const name = await promptText(
      t("party.newProfileTitle"),
      t("party.newProfileLabel"),
      t("party.defaultName"),
    );
    if (name === null) return;
    await services().party.createProfile(name, "standalone");
  }

  static async #onLinkPartyActor(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    if (!isGM()) return;
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    const existing = services()
      .party.profiles()
      .find((p) => p.kind === "linked" && p.partyActorUuid === uuid);
    if (existing) {
      await services().party.setActive(existing.id);
      return;
    }
    const actor = services()
      .adapter.listPartyActors()
      .find((p) => p.uuid === uuid);
    await services().party.createProfile(actor?.name ?? t("party.defaultName"), "linked", uuid);
  }

  static async #onSelectProfile(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const id = target.dataset.id;
    if (id) await services().party.setActive(id);
  }

  static async #onRenameProfile(this: EncounterBuilderApp): Promise<void> {
    const profile = this.state.resolved?.profile;
    if (!profile || !isGM()) return;
    const name = await promptText(t("party.renameTitle"), t("party.newProfileLabel"), profile.name);
    if (name !== null) await services().party.renameProfile(profile.id, name);
  }

  static async #onDeleteProfile(this: EncounterBuilderApp): Promise<void> {
    const profile = this.state.resolved?.profile;
    if (!profile || !isGM()) return;
    const ok = await confirm(
      t("party.deleteTitle"),
      t("party.deleteConfirm", { name: escapeHtml(profile.name) }),
      "fa-solid fa-trash",
    );
    if (ok) await services().party.deleteProfile(profile.id);
  }

  static async #onToggleMember(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const profile = this.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    const member = this.state.resolved?.roster.members.find((m) => m.uuid === uuid);
    await services().party.setMemberActive(profile.id, uuid, !(member?.active ?? true));
  }

  static async #onToggleCounts(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const profile = this.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    const member = this.state.resolved?.roster.members.find((m) => m.uuid === uuid);
    await services().party.setMemberCounts(profile.id, uuid, !(member?.countsAsMember ?? false));
  }

  static async #onRemoveMember(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const profile = this.state.resolved?.profile;
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!profile || !uuid || !isGM()) return;
    await services().party.removeMember(profile.id, uuid);
  }

  static async #onPickMember(this: EncounterBuilderApp): Promise<void> {
    if (!isGM()) return;
    const candidates = game.actors
      .filter((a) => a.type === "character" || a.type === "npc")
      .map((a) => ({ uuid: a.uuid, name: `${a.name} (${a.type}, ${t("party.level")} ${a.level ?? "?"})` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const uuid = await promptSelect(t("party.pickTitle"), t("party.pickLabel"), candidates);
    if (uuid) await this.#addPartyMember(uuid);
  }

  static async #onRefreshParty(this: EncounterBuilderApp): Promise<void> {
    services().party.invalidate();
    await this.refreshParty();
  }

  static async #onAddCreature(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    const entry = this.state.results.find((e) => e.uuid === uuid) ?? services().catalog.get(uuid);
    if (!entry) return;
    this.setDraft(addEntry(this.state.draft, entryFromCatalog(entry)));
    await this.render({ parts: ["build", "deploy", "footer"] });
  }

  static async #onInspectCreature(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    const doc = await services().catalog.loadDocument(uuid);
    if (!doc) {
      this.pushMessage("warn", t("messages.sourceMissing", { uuid }));
      await this.render({ parts: ["header"] });
      return;
    }
    doc.sheet?.render(true);
  }

  static async #onRemoveCreature(
    this: EncounterBuilderApp,
    _event: Event,
    target: HTMLElement,
  ): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    this.setDraft(removeEntry(this.state.draft, uuid));
    await this.render({ parts: ["build", "deploy", "footer"] });
  }

  static async #onLockCreature(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    this.setDraft(toggleLock(this.state.draft, uuid));
    await this.render({ parts: ["build"] });
  }

  static async #onClearDraft(this: EncounterBuilderApp): Promise<void> {
    this.setDraft(emptyDraft());
    await this.render({ parts: ["build", "deploy", "footer"] });
  }

  static async #onRefreshCatalog(this: EncounterBuilderApp): Promise<void> {
    this.state.busy = true;
    await this.render({ parts: ["build"] });
    try {
      services().tags.invalidate();
      services().themes.invalidate();
      await this.#muteCatalog(async () => {
        await services().catalog.refresh();
        services().catalog.retag();
      });
    } finally {
      this.state.busy = false;
    }
    await this.#runSearch();
  }

  static async #onSetRarity(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const value = target.dataset.value ?? "";
    this.state.filter.rarities = value ? [value] : [];
    this.#search();
  }

  static async #onEditTags(this: EncounterBuilderApp, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>("[data-uuid]")?.dataset.uuid;
    if (!uuid || !isGM()) return;
    const { tags, catalog } = services();
    const current = tags.tagsFor(uuid).join(", ");
    const text = await promptText(t("build.tagsTitle"), t("build.tagsLabel"), current);
    if (text === null) return;
    const { parseTagText } = await import("../core/catalog.js");
    // Writing the tag store also fires the data-journal hook, which retags and emits.
    await this.#muteCatalog(async () => {
      await tags.setTags(uuid, parseTagText(text));
      catalog.retag();
    });
    await this.#runSearch();
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const TAB_ICONS: Record<TabId, string> = {
  party: "fa-solid fa-users",
  build: "fa-solid fa-hammer",
  treasure: "fa-solid fa-gem",
  tables: "fa-solid fa-table-list",
  saved: "fa-solid fa-folder-open",
  deploy: "fa-solid fa-chess-knight",
};

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

/**
 * Everything party-related the workspace displays: the resolved roster, the profile list and the
 * linkable Party actors. Equal signatures mean a re-render would paint the same party data.
 */
export function partySignature(
  resolved: ResolvedParty | null,
  profiles: unknown[],
  partyActors: { uuid: string; name: string }[],
): string {
  return JSON.stringify([resolved, profiles, partyActors]);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Context for the threat meter: five tiers with the target tick and the actual marker. */
export function meterContext(evaluation: DraftEvaluation): Record<string, unknown> {
  const { tierBudget: tb } = { tierBudget };
  const extreme = tb("extreme", evaluation.partySize).target;
  const scaleMax = Math.max(extreme * 1.15, evaluation.supportedXP * 1.05, 1);
  const pct = (xp: number) => Math.min(100, Math.max(0, (xp / scaleMax) * 100));
  const tiers = THREAT_LEVELS.map((threat) => {
    const tier = tb(threat, evaluation.partySize);
    return {
      threat,
      label: t(`threat.${threat}`),
      target: tier.target,
      available: tier.available,
      left: pct(tier.target),
      selected: evaluation.selectedThreat === threat,
    };
  });
  // Adjacent tier labels can sit ~11% apart, which is less than a label's width in a narrow
  // panel. Drop a label onto a second row when it would collide with the previous one on its row.
  const MIN_GAP = 16;
  let lastRow0: number | null = null;
  const tiersStaggered = tiers.map((tier) => {
    const row = lastRow0 === null || tier.left - lastRow0 >= MIN_GAP ? 0 : 1;
    if (row === 0) lastRow0 = tier.left;
    return { ...tier, row };
  });
  const inferred = evaluation.inferred;
  let inferredLabel =
    inferred.label === "beyondExtreme" ? t("evaluation.beyondExtreme") : t(`threat.${inferred.label}`);
  if (inferred.unquantified) inferredLabel += ` ${t("evaluation.unquantified")}`;
  const over = evaluation.difference !== null && evaluation.difference > 0;
  return {
    tiers: tiersStaggered,
    staggered: tiersStaggered.some((tier) => tier.row === 1),
    fill: pct(evaluation.supportedXP),
    supportedXP: evaluation.supportedXP,
    target: evaluation.tier?.available ? evaluation.tier.target : null,
    targetLeft: evaluation.tier?.available ? pct(evaluation.tier.target) : null,
    difference: evaluation.difference,
    differenceLabel:
      evaluation.difference === null
        ? ""
        : evaluation.difference > 0
          ? `+${evaluation.difference}`
          : String(evaluation.difference),
    over,
    complete: evaluation.complete,
    inferredLabel,
    selectedLabel: evaluation.selectedThreat ? t(`threat.${evaluation.selectedThreat}`) : "—",
    creatureCount: evaluation.creatureCount,
    warnings: evaluation.warnings
      .filter((w) => w.code !== "underBudget")
      .map((w) => ({
        level: w.code === "overBudget" || w.code.startsWith("incomplete") ? "warn" : "info",
        text: t(`evaluation.warnings.${w.code}`, w.data),
      })),
    systemCalculation: evaluation.systemCalculation,
    variantUnsupported: evaluation.variantUnsupported,
    stateClass: inferred.unquantified
      ? "is-unquantified"
      : over
        ? "is-over"
        : evaluation.difference === 0
          ? "is-exact"
          : "",
  };
}

function describePackState(
  state: ReturnType<import("../foundry/creature-catalog.js").CreatureCatalog["packState"]>,
): string {
  if (!state) return t("build.packState.notLoaded");
  switch (state.state) {
    case "loaded":
      return t("build.packState.loaded", { count: state.count, skipped: state.skipped });
    case "inaccessible":
      return t("build.packState.inaccessible");
    case "missing":
      return t("build.packState.missing");
    case "error":
      return t("build.packState.error", { message: state.message });
  }
}

export async function confirm(
  title: string,
  html: string,
  icon = "fa-solid fa-triangle-exclamation",
): Promise<boolean> {
  const ok = await DialogV2().confirm({
    window: { title, icon },
    classes: ["seb-dialog"],
    content: `<p>${html}</p>`,
    modal: true,
    rejectClose: false,
  });
  return ok === true;
}

export async function promptText(title: string, label: string, initial = ""): Promise<string | null> {
  const result = await DialogV2().prompt({
    window: { title },
    classes: ["seb-dialog"],
    content: `<div class="seb-field"><label>${escapeHtml(label)}</label><input type="text" name="value" value="${escapeHtml(initial)}" autofocus></div>`,
    ok: {
      callback: (_event: Event, button: HTMLButtonElement) =>
        (button.form?.elements.namedItem("value") as HTMLInputElement | null)?.value ?? "",
    },
    rejectClose: false,
  });
  return typeof result === "string" ? result : null;
}

export async function promptSelect(
  title: string,
  label: string,
  options: { uuid: string; name: string }[],
): Promise<string | null> {
  if (options.length === 0) {
    ui.notifications.warn(t("party.noCandidates"));
    return null;
  }
  const opts = options
    .map((o) => `<option value="${escapeHtml(o.uuid)}">${escapeHtml(o.name)}</option>`)
    .join("");
  const result = await DialogV2().prompt({
    window: { title },
    classes: ["seb-dialog"],
    content: `<div class="seb-field"><label>${escapeHtml(label)}</label><select name="value">${opts}</select></div>`,
    ok: {
      callback: (_event: Event, button: HTMLButtonElement) =>
        (button.form?.elements.namedItem("value") as HTMLSelectElement | null)?.value ?? "",
    },
    rejectClose: false,
  });
  return typeof result === "string" && result ? result : null;
}
