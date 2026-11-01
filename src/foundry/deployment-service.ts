/**
 * DeploymentService: explicit imports, token placement and optional combat creation,
 * with an operation ledger for exact partial-failure reporting and safe cleanup.
 *
 * Guarantees:
 *  - compendium documents are never modified
 *  - reuse matches on compendium source identity, never on name (see `pickReusableActor`)
 *  - square grids are supported; gridless scenes deploy in pixel units with a warning; hex scenes block
 *  - deployed NPC tokens are always unlinked (independent HP/conditions)
 *  - combat is never started, initiative never rolled, tokens hidden by default
 *  - one in-flight operation at a time
 */
import { FLAGS, MODULE_ID, SETTINGS } from "../constants.js";
import {
  OperationLedger,
  pickReusableActor,
  planCleanup,
  planDeployment,
  type CleanupWorld,
  type CreatedRecord,
  type DeploymentOptions,
  type DeploymentPlan,
} from "../core/deployment.js";
import type { CreatureAdjustment, DraftEntry } from "../core/draft.js";
import { footprintCells, placeTokens, tokenNames, type PlacementRequest } from "../core/placement.js";
import { documentClass, gridTypes, isGM, randomID } from "./compat.js";
import { t } from "./i18n.js";
import { getSetting } from "./settings.js";

/** Port over Foundry so the service can be tested with a mock. */
export interface DeploymentGateway {
  getScene(sceneId: string): SceneDocument | null;
  findReusableActor(sourceUuid: string): ActorDocument | null;
  importActor(sourceUuid: string): Promise<ActorDocument>;
  getActor(uuid: string): Promise<ActorDocument | null>;
  createTokens(scene: SceneDocument, data: Record<string, unknown>[]): Promise<TokenDocument[]>;
  /** Make a deployed (unlinked) token's creature elite or weak. */
  applyAdjustment(token: TokenDocument, adjustment: CreatureAdjustment): Promise<void>;
  activeCombat(sceneId: string): CombatDocument | null;
  createCombat(sceneId: string): Promise<CombatDocument>;
  addCombatants(
    combat: CombatDocument,
    tokens: TokenDocument[],
  ): Promise<{ id: string; uuid: string; name: string }[]>;
  deleteDocument(kind: "Actor" | "Token" | "Combat" | "Combatant", uuid: string): Promise<void>;
  /** Current tokens and combatants, so cleanup can keep documents that are now in use elsewhere. */
  cleanupWorld(): CleanupWorld;
}

export interface CleanupResult {
  removed: number;
  failed: { uuid: string; message: string }[];
  /** Created documents left in place because something outside the operation uses them. */
  kept: { kind: CreatedRecord["kind"]; name: string; reason: "actorInUse" | "combatInUse" }[];
}

export interface DeploymentPreview {
  plan: DeploymentPlan;
  scene: { id: string; name: string; gridLabel: string; supported: boolean } | null;
  warnings: string[];
  blockers: string[];
}

export interface DeploymentOutcome {
  ledger: OperationLedger;
  placedTokens: TokenDocument[];
  unplaced: number;
}

export class DeploymentService {
  #inFlight: Promise<DeploymentOutcome> | null = null;
  #lastLedger: OperationLedger | null = null;

  constructor(private readonly gateway: DeploymentGateway) {}

  get busy(): boolean {
    return this.#inFlight !== null;
  }

  get lastLedger(): OperationLedger | null {
    return this.#lastLedger;
  }

  preview(entries: DraftEntry[], options: DeploymentOptions): DeploymentPreview {
    const plan = planDeployment(
      entries,
      options,
      (uuid) => this.gateway.findReusableActor(uuid)?.uuid ?? null,
    );
    const warnings: string[] = [];
    const blockers: string[] = [];
    const sceneDoc = options.sceneId ? this.gateway.getScene(options.sceneId) : null;
    let scene: DeploymentPreview["scene"] = null;
    if (!sceneDoc) blockers.push("noScene");
    else {
      const types = gridTypes();
      const type = sceneDoc.grid.type;
      const gridless = type === types.GRIDLESS;
      const supported = type === types.SQUARE;
      const gridLabel = gridless ? "gridless" : supported ? "square" : "hex";
      // Placement uses square-cell maths: harmless in pixel units on a gridless scene, wrong on hex cells.
      if (gridless) warnings.push("unsupportedGrid");
      else if (!supported) blockers.push("unsupportedGrid");
      scene = { id: sceneDoc.id, name: sceneDoc.name, gridLabel, supported };
    }
    if (plan.totalTokens === 0) blockers.push("nothingToDeploy");
    for (const actor of plan.actors) {
      if (!actor.sourceUuid.startsWith("Compendium.") && !actor.sourceUuid.startsWith("Actor."))
        warnings.push("unknownSource");
    }
    if (options.importPolicy === "reuse" && plan.actors.some((a) => !a.reuseActorUuid))
      warnings.push("someFresh");
    return { plan, scene, warnings, blockers };
  }

  /** Execute a deployment. Rejects while another deployment is in flight. */
  deploy(
    entries: DraftEntry[],
    options: DeploymentOptions,
    origin: { x: number; y: number } | null,
  ): Promise<DeploymentOutcome> {
    if (!isGM()) return Promise.reject(new Error("GM only"));
    if (this.#inFlight) return Promise.reject(new Error("deployment already in progress"));
    this.#inFlight = this.#execute(entries, options, origin).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #execute(
    entries: DraftEntry[],
    options: DeploymentOptions,
    origin: { x: number; y: number } | null,
  ): Promise<DeploymentOutcome> {
    const ledger = new OperationLedger(randomID());
    this.#lastLedger = ledger;
    const preview = this.preview(entries, options);
    if (preview.blockers.length > 0) {
      ledger.fail({
        stage: "place",
        subject: "preflight",
        message: preview.blockers.map((code) => t(`deploy.blockers.${code}`)).join(" "),
      });
      ledger.finish();
      return { ledger, placedTokens: [], unplaced: preview.plan.totalTokens };
    }
    const scene = this.gateway.getScene(options.sceneId)!;

    // 1. Resolve actors (import or reuse). Elite/weak rows of one creature share its world actor;
    // the adjustment goes on each unlinked token's actor, never on the world actor.
    const resolvedActors: {
      actor: ActorDocument;
      quantity: number;
      name: string;
      adjustment: CreatureAdjustment | null;
    }[] = [];
    const resolvedBySource = new Map<string, ActorDocument>();
    for (const planned of preview.plan.actors) {
      const adjustment = planned.adjustment;
      const known = resolvedBySource.get(planned.sourceUuid);
      if (known) {
        resolvedActors.push({ actor: known, quantity: planned.quantity, name: planned.name, adjustment });
        continue;
      }
      try {
        let actor: ActorDocument | null = null;
        if (planned.reuseActorUuid) {
          actor = await this.gateway.getActor(planned.reuseActorUuid);
          if (actor) ledger.reuse({ kind: "Actor", uuid: actor.uuid, name: actor.name });
        }
        if (!actor && planned.sourceUuid.startsWith("Actor.")) {
          actor = await this.gateway.getActor(planned.sourceUuid);
          if (actor) ledger.reuse({ kind: "Actor", uuid: actor.uuid, name: actor.name });
        }
        if (!actor) {
          actor = await this.gateway.importActor(planned.sourceUuid);
          ledger.record({ kind: "Actor", id: actor.id, uuid: actor.uuid, name: actor.name });
        }
        resolvedBySource.set(planned.sourceUuid, actor);
        resolvedActors.push({ actor, quantity: planned.quantity, name: planned.name, adjustment });
      } catch (error) {
        ledger.fail({
          stage: "import",
          subject: planned.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. Place tokens.
    const placedTokens: TokenDocument[] = [];
    let unplaced = 0;
    if (resolvedActors.length > 0) {
      const grid = scene.grid;
      const cell = grid.size;
      const dims = scene.dimensions;
      const bounds = {
        minI: Math.floor(dims.sceneY / cell),
        minJ: Math.floor(dims.sceneX / cell),
        maxI: Math.ceil((dims.sceneY + dims.sceneHeight) / cell),
        maxJ: Math.ceil((dims.sceneX + dims.sceneWidth) / cell),
      };
      const originPoint = origin ?? {
        x: dims.sceneX + dims.sceneWidth / 2,
        y: dims.sceneY + dims.sceneHeight / 2,
      };
      const originCell = { i: Math.floor(originPoint.y / cell), j: Math.floor(originPoint.x / cell) };
      const occupied = scene.tokens.contents.flatMap((tk) =>
        footprintCells(Math.floor(tk.y / cell), Math.floor(tk.x / cell), tk.width, tk.height),
      );

      const requests: PlacementRequest[] = [];
      const byId = new Map<
        string,
        { actor: ActorDocument; name: string; adjustment: CreatureAdjustment | null }
      >();
      const existingNames = scene.tokens.contents.map((tk) => tk.name);
      resolvedActors.forEach(({ actor, quantity, adjustment }, group) => {
        const baseName = actor.prototypeToken?.name || actor.name;
        const names = tokenNames(
          adjustment ? t(`build.adjustment.tokenName.${adjustment}`, { name: baseName }) : baseName,
          quantity,
          options.numberDuplicates,
          existingNames,
        );
        // Later groups of the same creature (another adjustment) number on from these.
        existingNames.push(...names);
        for (let k = 0; k < quantity; k++) {
          const id = `${group}:${k}`;
          requests.push({
            id,
            width: actor.prototypeToken?.width ?? 1,
            height: actor.prototypeToken?.height ?? 1,
          });
          byId.set(id, { actor, name: names[k]!, adjustment });
        }
      });
      const placement = placeTokens(requests, originCell, bounds, occupied);
      unplaced = placement.unplaced.length;
      if (unplaced > 0) {
        ledger.fail({
          stage: "place",
          subject: "placement",
          message: t("deploy.unplaced", { count: unplaced }),
        });
      } else {
        try {
          const data: Record<string, unknown>[] = [];
          const adjustments: (CreatureAdjustment | null)[] = [];
          for (const p of placement.placed) {
            const { actor, name, adjustment } = byId.get(p.id)!;
            adjustments.push(adjustment);
            data.push(
              await tokenData(actor, {
                name,
                actorLink: false,
                hidden: options.hidden,
                x: p.j * cell,
                y: p.i * cell,
                flags: { [MODULE_ID]: { [FLAGS.deployment]: ledger.id } },
              }),
            );
          }
          const tokens = await this.gateway.createTokens(scene, data);
          for (const tk of tokens) {
            ledger.record({ kind: "Token", id: tk.id, uuid: tk.uuid, name: tk.name });
            placedTokens.push(tk);
          }
          // Tokens come back in request order. A failed adjustment leaves the token deployed unmodified.
          for (const [i, tk] of tokens.entries()) {
            const adjustment = adjustments[i];
            if (!adjustment) continue;
            try {
              await this.gateway.applyAdjustment(tk, adjustment);
            } catch (error) {
              ledger.fail({
                stage: "place",
                subject: tk.name,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          ledger.fail({
            stage: "place",
            subject: "tokens",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // 3. Optional combat.
    if (options.addToCombat !== "none" && placedTokens.length > 0) {
      try {
        let combat = options.addToCombat === "active" ? this.gateway.activeCombat(scene.id) : null;
        if (!combat) {
          combat = await this.gateway.createCombat(scene.id);
          ledger.record({ kind: "Combat", id: combat.id, uuid: combat.uuid, name: combat.name ?? "Combat" });
        } else {
          ledger.reuse({ kind: "Combat", uuid: combat.uuid, name: combat.name ?? "Combat" });
        }
        const combatants = await this.gateway.addCombatants(combat, placedTokens);
        for (const c of combatants)
          ledger.record({ kind: "Combatant", id: c.id, uuid: c.uuid, name: c.name });
      } catch (error) {
        ledger.fail({
          stage: "combat",
          subject: "combat",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ledger.finish();
    Hooks.callAll(`${MODULE_ID}.deploymentComplete`, ledger.summary());
    return { ledger, placedTokens, unplaced };
  }

  /**
   * Delete only what the given operation created, keeping created actors and combats that something outside
   * the operation now uses. Returns what was removed, what failed and what was kept.
   */
  async cleanup(ledger: OperationLedger): Promise<CleanupResult> {
    if (!isGM()) throw new Error("GM only");
    let removed = 0;
    const failed: { uuid: string; message: string }[] = [];
    const plan = planCleanup(ledger.cleanupTargets(), this.gateway.cleanupWorld());
    const kept = plan.kept.map((k) => ({ kind: k.record.kind, name: k.record.name, reason: k.reason }));
    for (const target of plan.remove) {
      try {
        await this.gateway.deleteDocument(target.kind, target.uuid);
        removed++;
      } catch (error) {
        failed.push({ uuid: target.uuid, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { removed, failed, kept };
  }
}

/**
 * Token creation data for one deployed token. Uses `actor.getTokenDocument` when available so the
 * system and core resolve the prototype (e.g. a random wildcard image per token); otherwise spreads the
 * prototype token. The overrides (name, position, visibility, unlinked, deployment flag) always win, and
 * the module's flag scope is replaced by the deployment marker.
 */
async function tokenData(
  actor: ActorDocument,
  overrides: Record<string, unknown> & { flags: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  let base: Record<string, unknown> | null = null;
  if (typeof actor.getTokenDocument === "function") {
    try {
      base = (await actor.getTokenDocument(overrides)).toObject();
    } catch (error) {
      console.warn(`${MODULE_ID} | getTokenDocument failed; using the prototype token`, error);
    }
  }
  base ??= actor.prototypeToken?.toObject?.() ?? {};
  const baseFlags = (base.flags as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    ...overrides,
    actorId: actor.id,
    flags: { ...baseFlags, ...overrides.flags },
  };
}

/* -------------------------------------------- */
/*  Foundry gateway                             */
/* -------------------------------------------- */

export class FoundryDeploymentGateway implements DeploymentGateway {
  getScene(sceneId: string): SceneDocument | null {
    return game.scenes.get(sceneId) ?? null;
  }

  findReusableActor(sourceUuid: string): ActorDocument | null {
    if (sourceUuid.startsWith("Actor.")) return game.actors.get(sourceUuid.slice("Actor.".length)) ?? null;
    // Match on compendium source identity only (never name); see pickReusableActor for the preference order.
    return pickReusableActor(game.actors.contents, sourceUuid);
  }

  async importActor(sourceUuid: string): Promise<ActorDocument> {
    const source = (await fromUuid(sourceUuid)) as ActorDocument | null;
    if (!source) throw new Error(`source ${sourceUuid} not found`);
    if (source.type !== "npc") throw new Error(`source ${sourceUuid} is not an NPC`);
    const data = source.toObject();
    delete data._id;
    delete data.folder;
    data.ownership = { default: 0 };
    data._stats = { ...(data._stats ?? {}), compendiumSource: sourceUuid };
    data.flags = {
      ...(data.flags ?? {}),
      [MODULE_ID]: { [FLAGS.importedFrom]: { uuid: sourceUuid, at: Date.now() } },
    };
    // Actor.create with a compendium source; Foundry also records _stats.compendiumSource for compendium imports.
    const ActorClass = documentClass("Actor");
    const created: ActorDocument = await ActorClass.create(data, {
      fromCompendium: sourceUuid.startsWith("Compendium."),
    });
    if (!created) throw new Error(`failed to import ${sourceUuid}`);
    return created;
  }

  async getActor(uuid: string): Promise<ActorDocument | null> {
    const doc = (await fromUuid(uuid)) as ActorDocument | null;
    return doc && doc.documentName === "Actor" ? doc : null;
  }

  async createTokens(scene: SceneDocument, data: Record<string, unknown>[]): Promise<TokenDocument[]> {
    return scene.createEmbeddedDocuments("Token", data) as Promise<TokenDocument[]>;
  }

  async applyAdjustment(token: TokenDocument, adjustment: CreatureAdjustment): Promise<void> {
    // PF2e's NPC#applyAdjustment sets system.attributes.adjustment and rescales current HP; on an
    // unlinked token it writes the token's actor delta, leaving the world actor untouched.
    const actor = token.actor;
    if (typeof actor?.applyAdjustment !== "function")
      throw new Error(t("deploy.adjustmentUnsupported", { adjustment }));
    await actor.applyAdjustment(adjustment);
  }

  activeCombat(sceneId: string): CombatDocument | null {
    const combat = game.combats.active ?? game.combat;
    if (!combat) return null;
    return !combat.scene || combat.scene.id === sceneId ? combat : null;
  }

  async createCombat(sceneId: string): Promise<CombatDocument> {
    // Never started here; the GM starts it from the tracker.
    return documentClass("Combat").create({ scene: sceneId, active: true });
  }

  async addCombatants(
    combat: CombatDocument,
    tokens: TokenDocument[],
  ): Promise<{ id: string; uuid: string; name: string }[]> {
    const data = tokens.map((tk) => ({
      tokenId: tk.id,
      sceneId: tk.parent?.id ?? combat.scene?.id,
      actorId: tk.actorId,
      hidden: tk.hidden,
    }));
    const created = await combat.createEmbeddedDocuments("Combatant", data);
    return created.map((c: { id: string; uuid: string; name: string }) => ({
      id: c.id,
      uuid: c.uuid,
      name: c.name,
    }));
  }

  async deleteDocument(_kind: "Actor" | "Token" | "Combat" | "Combatant", uuid: string): Promise<void> {
    const doc = await fromUuid(uuid);
    if (doc) await doc.delete();
  }

  cleanupWorld(): CleanupWorld {
    const tokens = game.scenes.contents.flatMap((scene) =>
      scene.tokens.contents.map((tk) => ({ uuid: tk.uuid, actorId: tk.actorId ?? null })),
    );
    const combats: CleanupWorld["combats"] = {};
    for (const combat of game.combats.contents) {
      combats[combat.uuid] = combat.combatants.contents.map((cb) => ({
        uuid: cb.uuid ?? "",
        tokenId: cb.tokenId ?? null,
      }));
    }
    return { tokens, combats };
  }
}

export function defaultDeploymentOptions(): DeploymentOptions {
  return {
    sceneId: game.scenes.viewed?.id ?? game.scenes.active?.id ?? "",
    importPolicy: "reuse",
    hidden: true,
    addToCombat: "none",
    numberDuplicates: !!getSetting<boolean>(SETTINGS.numberDuplicateTokens),
  };
}
