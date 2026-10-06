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
  #originHandler: ((event: PointerEvent) => void) | null = null;

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
            created: ledger.created.map((c) => `${c.kind}: ${c.name}`),
            reused: ledger.reused.map((r) => `${r.kind}: ${r.name}`),
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

  /** Let the GM click the canvas to choose the placement origin. */
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
    const handler = (event: PointerEvent) => {
      const pos =
        canvas.canvasCoordinatesFromClient?.({ x: event.clientX, y: event.clientY }) ??
        canvas.mousePosition ??
        null;
      if (pos) this.origin = { x: pos.x, y: pos.y };
      this.cancelPick();
      void this.app.render({ parts: ["deploy"] });
    };
    this.#originHandler = handler;
    (canvas.app?.view ?? document.body).addEventListener("pointerdown", handler, {
      once: true,
      capture: true,
    });
    await this.app.render({ parts: ["deploy"] });
  }

  cancelPick(): void {
    if (this.#originHandler) {
      (canvas?.app?.view ?? document.body).removeEventListener("pointerdown", this.#originHandler, {
        capture: true,
      });
      this.#originHandler = null;
    }
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
    const kept = result.kept.map((k) => `${k.kind}: ${k.name} (${t(`deploy.keptReason.${k.reason}`)})`);
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
