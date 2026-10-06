/**
 * Pure deployment planning and operation bookkeeping. The DeploymentService executes a plan
 * through a `DeploymentGateway` (Foundry) and this module tracks what was created so partial
 * failures can be reported exactly and cleaned up safely.
 */
import { FLAGS, MODULE_ID } from "../constants.js";
import type { DraftEntry } from "./draft.js";

export type ImportPolicy = "reuse" | "fresh";

export interface DeploymentOptions {
  sceneId: string;
  importPolicy: ImportPolicy;
  hidden: boolean;
  addToCombat: "none" | "active" | "new";
  numberDuplicates: boolean;
}

export interface PlannedActor {
  sourceUuid: string;
  name: string;
  quantity: number;
  /** World actor to reuse (uuid) or null to import fresh. Resolved by the service before execution. */
  reuseActorUuid: string | null;
}

export interface DeploymentPlan {
  options: DeploymentOptions;
  actors: PlannedActor[];
  totalTokens: number;
}

export function planDeployment(
  entries: DraftEntry[],
  options: DeploymentOptions,
  reuse: (sourceUuid: string) => string | null,
): DeploymentPlan {
  const actors: PlannedActor[] = entries
    .filter((e) => e.quantity > 0)
    .map((e) => ({
      sourceUuid: e.uuid,
      name: e.name,
      quantity: e.quantity,
      reuseActorUuid: options.importPolicy === "reuse" ? reuse(e.uuid) : null,
    }));
  return { options, actors, totalTokens: actors.reduce((n, a) => n + a.quantity, 0) };
}

/* -------------------------------------------- */
/*  Reusable world actors                       */
/* -------------------------------------------- */

/** The plain actor data the reuse matcher reads. Foundry Actor documents satisfy it structurally. */
export interface ReuseCandidateData {
  type: string;
  _stats?: {
    compendiumSource?: string | null;
    duplicateSource?: string | null;
    createdTime?: number | null;
  } | null;
  flags?: Record<string, unknown> | null;
}

function flagObject(flags: ReuseCandidateData["flags"], scope: string): Record<string, unknown> | null {
  const value = flags?.[scope];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Compendium source identity of a world actor: `_stats.compendiumSource`, else legacy `flags.core.sourceId`. */
function sourceMatches(actor: ReuseCandidateData, sourceUuid: string): boolean {
  if ((actor._stats?.compendiumSource ?? null) === sourceUuid) return true;
  return flagObject(actor.flags, "core")?.sourceId === sourceUuid;
}

/** True when this module imported the actor (deployment sets `flags[MODULE_ID].importedFrom`). */
function importedByModule(actor: ReuseCandidateData, sourceUuid: string): boolean {
  const imported = flagObject(actor.flags, MODULE_ID)?.[FLAGS.importedFrom];
  if (!imported || typeof imported !== "object") return false;
  const uuid = (imported as { uuid?: unknown }).uuid;
  return uuid === undefined || uuid === sourceUuid;
}

/**
 * World NPC actors that may stand in for a compendium creature, best first. Matches on source identity
 * only (never name): `_stats.compendiumSource` or `flags.core.sourceId`. Sidebar duplicates (which keep
 * the source but carry `_stats.duplicateSource`) are excluded. Actors this module imported come first,
 * then the oldest by `_stats.createdTime`; ties keep collection order.
 */
export function rankReusableActors<T extends ReuseCandidateData>(
  actors: Iterable<T>,
  sourceUuid: string,
): T[] {
  const created = (a: T) => {
    const time = a._stats?.createdTime;
    return typeof time === "number" && Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
  };
  return [...actors]
    .filter((a) => a.type === "npc" && !a._stats?.duplicateSource && sourceMatches(a, sourceUuid))
    .map((actor, index) => ({ actor, index, own: importedByModule(actor, sourceUuid) ? 0 : 1 }))
    .sort((a, b) => a.own - b.own || created(a.actor) - created(b.actor) || a.index - b.index)
    .map((x) => x.actor);
}

/** The single world actor deployment reuses for a compendium source, or null. */
export function pickReusableActor<T extends ReuseCandidateData>(
  actors: Iterable<T>,
  sourceUuid: string,
): T | null {
  return rankReusableActors(actors, sourceUuid)[0] ?? null;
}

/* -------------------------------------------- */
/*  Operation ledger                            */
/* -------------------------------------------- */

export interface CreatedRecord {
  kind: "Actor" | "Token" | "Combat" | "Combatant";
  id: string;
  uuid: string;
  name: string;
}

export interface OperationFailure {
  stage: "import" | "place" | "combat";
  subject: string;
  message: string;
}

/** Delete in dependency order: combatants, tokens, combats, then actors. */
function inCleanupOrder(records: readonly CreatedRecord[]): CreatedRecord[] {
  const order: CreatedRecord["kind"][] = ["Combatant", "Token", "Combat", "Actor"];
  return [...records].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export class OperationLedger {
  readonly created: CreatedRecord[] = [];
  readonly reused: { kind: "Actor" | "Combat"; uuid: string; name: string }[] = [];
  readonly failures: OperationFailure[] = [];
  readonly id: string;
  #finished = false;

  constructor(id: string) {
    this.id = id;
  }

  record(record: CreatedRecord): void {
    this.created.push(record);
  }

  reuse(record: { kind: "Actor" | "Combat"; uuid: string; name: string }): void {
    this.reused.push(record);
  }

  fail(failure: OperationFailure): void {
    this.failures.push(failure);
  }

  finish(): void {
    this.#finished = true;
  }

  get finished(): boolean {
    return this.#finished;
  }

  get partial(): boolean {
    return this.failures.length > 0;
  }

  /** Documents that are safe to delete: only what this operation created. Never reused or pre-existing. */
  cleanupTargets(): CreatedRecord[] {
    return inCleanupOrder(this.created);
  }

  summary(): { created: Record<CreatedRecord["kind"], number>; reused: number; failures: number } {
    const created = { Actor: 0, Token: 0, Combat: 0, Combatant: 0 };
    for (const c of this.created) created[c.kind]++;
    return { created, reused: this.reused.length, failures: this.failures.length };
  }
}

/* -------------------------------------------- */
/*  Cleanup decisions                           */
/* -------------------------------------------- */

/** Snapshot of the world documents a cleanup could affect, taken just before deleting. */
export interface CleanupWorld {
  /** Every token on every scene, with the actor it references. */
  tokens: { uuid: string; actorId: string | null }[];
  /** Combatants of every combat, keyed by combat uuid. */
  combats: Record<string, { uuid: string; tokenId: string | null }[]>;
}

export interface CleanupPlan {
  /** Documents to delete, in dependency order. */
  remove: CreatedRecord[];
  /** Created documents kept because something outside this operation now uses them. */
  kept: { record: CreatedRecord; reason: "actorInUse" | "combatInUse" }[];
}

/**
 * Decide what a cleanup may delete. Created tokens and combatants always go. A created actor is kept
 * when a token outside the operation references it; a created combat is kept (only our combatants are
 * removed) when it holds combatants that are not ours.
 */
export function planCleanup(created: readonly CreatedRecord[], world: CleanupWorld): CleanupPlan {
  const ours = (kind: CreatedRecord["kind"]) => created.filter((c) => c.kind === kind);
  const tokenUuids = new Set(ours("Token").map((c) => c.uuid));
  const tokenIds = new Set(ours("Token").map((c) => c.id));
  const combatantUuids = new Set(ours("Combatant").map((c) => c.uuid));
  const foreignActorIds = new Set(
    world.tokens.filter((tk) => !tokenUuids.has(tk.uuid) && tk.actorId).map((tk) => tk.actorId!),
  );
  const remove: CreatedRecord[] = [];
  const kept: CleanupPlan["kept"] = [];
  for (const record of inCleanupOrder(created)) {
    if (record.kind === "Actor" && foreignActorIds.has(record.id)) {
      kept.push({ record, reason: "actorInUse" });
      continue;
    }
    if (record.kind === "Combat") {
      const combatants = world.combats[record.uuid] ?? [];
      const foreign = combatants.some(
        (cb) => !combatantUuids.has(cb.uuid) && !(cb.tokenId !== null && tokenIds.has(cb.tokenId)),
      );
      if (foreign) {
        kept.push({ record, reason: "combatInUse" });
        continue;
      }
    }
    remove.push(record);
  }
  return { remove, kept };
}
