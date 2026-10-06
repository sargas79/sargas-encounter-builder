/**
 * Deploy tab: preview, origin selection on the canvas, explicit import/placement/combat, and cleanup.
 */
import type { DeploymentOptions } from "../core/deployment.js";
import type { OperationLedger } from "../core/deployment.js";
import { isGM } from "../foundry/compat.js";
import {
  DeploymentService,
  FoundryDeploymentGateway,
  defaultDeploymentOptions,
} from "../foundry/deployment-service.js";
import { t } from "../foundry/i18n.js";
import { confirm } from "./dialogs.js";
import type { EncounterBuilderApp } from "./encounter-builder-app.js";
import { panelActions, type Panel } from "./panel.js";

export class DeployPanel implements Panel {
  readonly actions: ReadonlySet<string> = panelActions<DeployPanel>(
    "pickOrigin",
    "cancelOrigin",
    "clearOrigin",
    "deploy",
    "cleanup",
  );
  readonly service = new DeploymentService(new FoundryDeploymentGateway());
  options: DeploymentOptions | null = null;
  origin: { x: number; y: number } | null = null;
  pickingOrigin = false;
  busy = false;
  lastOutcome: { ledger: OperationLedger; unplaced: number } | null = null;
  cleanupDone: { removed: number; failed: number; kept: string[] } | null = null;
  /** Removes the listeners of an origin pick in progress. */
  #stopPicking: (() => void) | null = null;

  constructor(private readonly app: EncounterBuilderApp) {}

  #options(): DeploymentOptions {
    if (!this.options) this.options = defaultDeploymentOptions();
    if (!this.options.sceneId) this.options.sceneId = game.scenes.viewed?.id ?? game.scenes.active?.id ?? "";
    return this.options;
  }

  async prepareContext(): Promise<Record<string, unknown>> {
    const options = this.#options();
    const entries = this.app.state.draft.entries;
    const preview = this.service.preview(entries, options);
    const ledger = this.lastOutcome?.ledger ?? null;
    return {
      options,
      scenes: game.scenes.contents.map((s) => ({
        id: s.id,
        name: s.name,
        selected: s.id === options.sceneId,
      })),
      preview: {
        actors: preview.plan.actors.map((a) => ({
          ...a,
          policyLabel: a.reuseActorUuid
            ? t("deploy.reuseExisting")
            : a.sourceUuid.startsWith("Actor.")
              ? t("deploy.worldActor")
              : t("deploy.freshImport"),
        })),
        totalTokens: preview.plan.totalTokens,
        scene: preview.scene,
        warnings: preview.warnings.map((w) => t(`deploy.warnings.${w}`)),
        blockers: preview.blockers.map((b) => t(`deploy.blockers.${b}`)),
      },
      origin: this.origin
        ? `${Math.round(this.origin.x)}, ${Math.round(this.origin.y)}`
        : t("deploy.originCenter"),
      pickingOrigin: this.pickingOrigin,
      busy: this.busy || this.service.busy,
      canDeploy: !this.busy && !this.service.busy && preview.blockers.length === 0 && isGM(),
      outcome: ledger
        ? {
            summary: ledger.summary(),
            partial: ledger.partial,
            failures: ledger.failures.map(
              (f) => `${t(`deploy.stage.${f.stage}`)}: ${f.subject} — ${f.message}`,
            ),
            created: ledger.created.map((c) => `${kindLabel(c.kind)}: ${c.name}`),
            reused: ledger.reused.map((r) => `${kindLabel(r.kind)}: ${r.name}`),
            unplaced: this.lastOutcome?.unplaced ?? 0,
            canCleanup: ledger.created.length > 0 && !this.cleanupDone,
            cleanupDone: this.cleanupDone,
          }
        : null,
    };
  }

  async onChange(name: string, value: string, target: HTMLElement): Promise<boolean> {
    if (!name.startsWith("deploy.")) return false;
    const options = this.#options();
    switch (name.slice("deploy.".length)) {
      case "sceneId":
        options.sceneId = value;
        this.origin = null;
        break;
      case "importPolicy":
        options.importPolicy = value === "fresh" ? "fresh" : "reuse";
        break;
      case "hidden":
        options.hidden = (target as HTMLInputElement).checked;
        break;
      case "addToCombat":
        options.addToCombat = value === "active" || value === "new" ? value : "none";
        break;
      case "numberDuplicates":
        options.numberDuplicates = (target as HTMLInputElement).checked;
        break;
      default:
        return false;
    }
    await this.app.render({ parts: ["deploy"] });
    return true;
  }

  /**
   * Let the GM click the canvas to choose the placement origin. The click is swallowed so it does
   * not also select or deselect tokens; Escape or the Cancel button abort the pick.
   */
  async pickOrigin(): Promise<void> {
    if (!canvas?.ready || !canvas.stage) {
      this.app.pushMessage("warn", t("deploy.noCanvas"));
      await this.app.render({ parts: ["header", "deploy"] });
      return;
    }
    const options = this.#options();
    if (canvas.scene?.id !== options.sceneId) {
      this.app.pushMessage("warn", t("deploy.viewScene"));
      await this.app.render({ parts: ["header", "deploy"] });
      return;
    }
    this.cancelPick();
    this.pickingOrigin = true;
    const view: EventTarget | null = canvas.app?.view ?? null;
    const onPointer = (event: PointerEvent) => {
      // Only clicks on the canvas pick; clicks on windows (e.g. the Cancel button) pass through.
      if (view ? event.target !== view : !(event.target instanceof HTMLCanvasElement)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.cancelPick();
      // The viewed scene or the selected one may have changed since the pick started.
      if (canvas?.scene?.id !== this.#options().sceneId) {
        this.app.pushMessage("warn", t("deploy.viewScene"));
        void this.app.render({ parts: ["header", "deploy"] });
        return;
      }
      const pos =
        canvas.canvasCoordinatesFromClient?.({ x: event.clientX, y: event.clientY }) ??
        canvas.mousePosition ??
        null;
      if (pos) this.origin = { x: pos.x, y: pos.y };
      void this.app.render({ parts: ["deploy"] });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Keep Foundry from also closing windows or releasing tokens on this Escape.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void this.cancelOrigin();
    };
    // Window-level capture runs before the canvas's own listeners, so stopping the event here keeps
    // it from reaching the token layer at all.
    window.addEventListener("pointerdown", onPointer, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    this.#stopPicking = () => {
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
    await this.app.render({ parts: ["deploy"] });
  }

  /** Abort an origin pick in progress (Cancel button, Escape). */
  async cancelOrigin(): Promise<void> {
    if (!this.pickingOrigin) return;
    this.cancelPick();
    await this.app.render({ parts: ["deploy"] });
  }

  /** Remove the pick listeners without rendering. Safe to call when no pick is running. */
  cancelPick(): void {
    this.#stopPicking?.();
    this.#stopPicking = null;
    this.pickingOrigin = false;
  }

  async clearOrigin(): Promise<void> {
    this.origin = null;
    await this.app.render({ parts: ["deploy"] });
  }

  async deploy(): Promise<void> {
    if (!isGM() || this.busy || this.service.busy) return;
    const options = this.#options();
    this.cleanupDone = null;
    this.busy = true;
    await this.app.render({ parts: ["deploy"] });
    try {
      const outcome = await this.service.deploy(this.app.state.draft.entries, options, this.origin);
      this.lastOutcome = { ledger: outcome.ledger, unplaced: outcome.unplaced };
      const summary = outcome.ledger.summary();
      if (outcome.ledger.partial)
        this.app.pushMessage("warn", t("deploy.partial", { failures: summary.failures }));
      else
        this.app.pushMessage(
          "ok",
          t("deploy.done", {
            tokens: summary.created.Token,
            actors: summary.created.Actor,
            reused: summary.reused,
          }),
        );
    } catch (error) {
      this.app.reportError(error);
    } finally {
      this.busy = false;
    }
    await this.app.render({ parts: ["header", "deploy"] });
  }

  async cleanup(): Promise<void> {
    if (!isGM() || !this.lastOutcome) return;
    const ok = await confirm(
      t("deploy.cleanupTitle"),
      t("deploy.cleanupConfirm", { count: this.lastOutcome.ledger.created.length }),
      "fa-solid fa-broom",
    );
    if (!ok) return;
    const result = await this.service.cleanup(this.lastOutcome.ledger);
    const kept = result.kept.map(
      (k) => `${kindLabel(k.kind)}: ${k.name} (${t(`deploy.keptReason.${k.reason}`)})`,
    );
    this.cleanupDone = { removed: result.removed, failed: result.failed.length, kept };
    let message = t("deploy.cleanupDone", { removed: result.removed, failed: result.failed.length });
    if (kept.length) message += ` ${t("deploy.cleanupKept", { count: kept.length, names: kept.join(", ") })}`;
    this.app.pushMessage(result.failed.length || kept.length ? "warn" : "ok", message);
    await this.app.render({ parts: ["header", "deploy"] });
  }

  dispose(): void {
    this.cancelPick();
  }
}

/** Localized document type of a ledger line (Actor, Token, Combat, Combatant). */
function kindLabel(kind: "Actor" | "Token" | "Combat" | "Combatant"): string {
  return t(`deploy.kind.${kind}`);
}
