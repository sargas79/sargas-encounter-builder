import { beforeEach, describe, expect, it } from "vitest";
import { OperationLedger, planCleanup, planDeployment, type CreatedRecord } from "../src/core/deployment.js";
import { footprintCells, placeTokens, spiral, tokenNames } from "../src/core/placement.js";
import { DeploymentService, type DeploymentGateway } from "../src/foundry/deployment-service.js";
import type { DraftEntry } from "../src/core/draft.js";

/* ------------------------------------------------------------------ */
/*  Minimal Foundry globals for the service                            */
/* ------------------------------------------------------------------ */

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.game = { user: { isGM: true }, settings: { get: () => true }, scenes: { viewed: null, active: null } };
  g.Hooks = { callAll: () => true, on: () => 1, off: () => {} };
  g.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 }, DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 } };
});

function entry(uuid: string, name: string, quantity: number, level = 3): DraftEntry {
  return { uuid, name, level, quantity, locked: false, img: null, packLabel: null, traits: [] };
}

interface FakeActor {
  id: string;
  uuid: string;
  name: string;
  type: string;
  _stats: { compendiumSource: string | null };
  prototypeToken: {
    name: string;
    width: number;
    height: number;
    actorLink: boolean;
    toObject(): Record<string, unknown>;
  };
  hp: number;
}

class FakeGateway implements DeploymentGateway {
  worldActors: FakeActor[] = [];
  tokens: Record<string, unknown>[] = [];
  combats: {
    id: string;
    uuid: string;
    name: string;
    combatants: unknown[];
    started: boolean;
    scene: { id: string };
  }[] = [];
  deleted: string[] = [];
  failImportFor = new Set<string>();
  failTokens = false;
  failCombat = false;
  sceneTokens: { x: number; y: number; width: number; height: number; name: string }[] = [];
  scene = {
    id: "scene1",
    name: "Forest",
    grid: { type: 1, size: 100, isSquare: true, isHexagonal: false, isGridless: false },
    dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 1000 },
    tokens: { contents: [] as unknown[] },
  };
  importCount = 0;

  getScene(sceneId: string) {
    this.scene.tokens.contents = this.sceneTokens;
    return sceneId === "scene1" ? (this.scene as unknown as SceneDocument) : null;
  }
  findReusableActor(sourceUuid: string) {
    return (
      (this.worldActors.find((a) => a._stats.compendiumSource === sourceUuid) as unknown as ActorDocument) ??
      null
    );
  }
  async importActor(sourceUuid: string) {
    if (this.failImportFor.has(sourceUuid)) throw new Error("import failed");
    this.importCount++;
    const id = `imp${this.importCount}`;
    const actor: FakeActor = {
      id,
      uuid: `Actor.${id}`,
      name: `Imported ${sourceUuid.split(".").pop()}`,
      type: "npc",
      _stats: { compendiumSource: sourceUuid },
      prototypeToken: {
        name: `Imported ${sourceUuid.split(".").pop()}`,
        width: 1,
        height: 1,
        actorLink: true,
        toObject: () => ({ actorLink: true }),
      },
      hp: 20,
    };
    this.worldActors.push(actor);
    return actor as unknown as ActorDocument;
  }
  async getActor(uuid: string) {
    return (this.worldActors.find((a) => a.uuid === uuid) as unknown as ActorDocument) ?? null;
  }
  async createTokens(_scene: SceneDocument, data: Record<string, unknown>[]) {
    if (this.failTokens) throw new Error("token creation failed");
    const base = this.tokens.length;
    return data.map((d, i) => {
      const token = {
        ...d,
        id: `tok${base + i}`,
        uuid: `Scene.scene1.Token.tok${base + i}`,
        parent: { id: "scene1" },
      };
      this.tokens.push(token);
      return token as unknown as TokenDocument;
    });
  }
  activeCombat() {
    return (this.combats[0] as unknown as CombatDocument) ?? null;
  }
  async createCombat(sceneId: string) {
    const combat = {
      id: `combat${this.combats.length}`,
      uuid: `Combat.combat${this.combats.length}`,
      name: "Combat",
      combatants: [],
      started: false,
      scene: { id: sceneId },
    };
    this.combats.push(combat);
    return combat as unknown as CombatDocument;
  }
  async addCombatants(combat: CombatDocument, tokens: TokenDocument[]) {
    if (this.failCombat) throw new Error("combatant failed");
    const target = this.combats.find((c) => c.id === combat.id)!;
    return tokens.map((tk, i) => {
      const c = { id: `cb${i}`, uuid: `${combat.uuid}.Combatant.cb${i}`, name: tk.name };
      target.combatants.push(c);
      return c;
    });
  }
  async deleteDocument(_kind: string, uuid: string) {
    this.deleted.push(uuid);
  }
  /** Tokens placed outside the operation, e.g. a GM dragging an imported actor onto another scene. */
  foreignTokens: { uuid: string; actorId: string | null }[] = [];
  cleanupWorld() {
    return {
      tokens: [
        ...this.tokens.map((tk) => ({ uuid: tk.uuid as string, actorId: (tk.actorId as string) ?? null })),
        ...this.foreignTokens,
      ],
      combats: Object.fromEntries(
        this.combats.map((c) => [
          c.uuid,
          (c.combatants as { uuid: string; tokenId?: string }[]).map((cb) => ({
            uuid: cb.uuid,
            tokenId: cb.tokenId ?? null,
          })),
        ]),
      ),
    };
  }
}

/* ------------------------------------------------------------------ */

describe("placement", () => {
  it("spirals outward from the origin", () => {
    const cells = [...spiral(5, 5, 1)];
    expect(cells[0]).toEqual({ i: 5, j: 5 });
    expect(cells).toHaveLength(9);
    expect(new Set(cells.map((c) => `${c.i},${c.j}`)).size).toBe(9);
  });

  it("places tokens on free cells, avoiding occupied ones and respecting size", () => {
    const result = placeTokens(
      [
        { id: "a", width: 1, height: 1 },
        { id: "big", width: 2, height: 2 },
        { id: "b", width: 1, height: 1 },
      ],
      { i: 5, j: 5 },
      { minI: 0, minJ: 0, maxI: 10, maxJ: 10 },
      footprintCells(5, 5, 1, 1),
    );
    expect(result.unplaced).toEqual([]);
    expect(result.placed).toHaveLength(3);
    const cells = new Set<string>();
    for (const p of result.placed) {
      for (const c of footprintCells(p.i, p.j, p.width, p.height)) {
        expect(cells.has(`${c.i},${c.j}`)).toBe(false);
        cells.add(`${c.i},${c.j}`);
      }
    }
    expect(cells.has("5,5")).toBe(false);
  });

  it("reports tokens that do not fit instead of placing them outside bounds", () => {
    const result = placeTokens(
      Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, width: 1, height: 1 })),
      { i: 0, j: 0 },
      { minI: 0, minJ: 0, maxI: 2, maxJ: 2 },
      [],
      3,
    );
    expect(result.placed).toHaveLength(4);
    expect(result.unplaced).toHaveLength(1);
  });

  it("numbers duplicate tokens and skips names already on the scene", () => {
    expect(tokenNames("Wolf", 3, true, ["Wolf 2"])).toEqual(["Wolf 1", "Wolf 3", "Wolf 4"]);
    expect(tokenNames("Wolf", 3, false)).toEqual(["Wolf", "Wolf", "Wolf"]);
    expect(tokenNames("Wolf", 1, true)).toEqual(["Wolf"]);
  });
});

describe("T19: reuse matches on compendium source only; fresh copies preserve provenance", () => {
  it("reuses a world actor with the same compendium source and never one with only the same name", async () => {
    const gateway = new FakeGateway();
    gateway.worldActors.push({
      id: "w1",
      uuid: "Actor.w1",
      name: "Wolf",
      type: "npc",
      _stats: { compendiumSource: "Compendium.p.Actor.wolf" },
      prototypeToken: { name: "Wolf", width: 1, height: 1, actorLink: false, toObject: () => ({}) },
      hp: 1,
    });
    gateway.worldActors.push({
      id: "w2",
      uuid: "Actor.w2",
      name: "Bear",
      type: "npc",
      _stats: { compendiumSource: null },
      prototypeToken: { name: "Bear", width: 1, height: 1, actorLink: false, toObject: () => ({}) },
      hp: 1,
    });
    const service = new DeploymentService(gateway);
    const options = {
      sceneId: "scene1",
      importPolicy: "reuse" as const,
      hidden: true,
      addToCombat: "none" as const,
      numberDuplicates: true,
    };
    const preview = service.preview(
      [entry("Compendium.p.Actor.wolf", "Wolf", 2), entry("Compendium.p.Actor.bear", "Bear", 1)],
      options,
    );
    expect(preview.plan.actors[0]?.reuseActorUuid).toBe("Actor.w1");
    expect(preview.plan.actors[1]?.reuseActorUuid).toBeNull();
    expect(preview.warnings).toContain("someFresh");

    const outcome = await service.deploy(
      preview.plan.actors.map((a) => entry(a.sourceUuid, a.name, a.quantity)),
      options,
      { x: 500, y: 500 },
    );
    expect(outcome.ledger.reused.map((r) => r.uuid)).toEqual(["Actor.w1"]);
    expect(outcome.ledger.created.filter((c) => c.kind === "Actor")).toHaveLength(1);
    expect(gateway.importCount).toBe(1);
    const imported = gateway.worldActors.find((a) => a.id === "imp1")!;
    expect(imported._stats.compendiumSource).toBe("Compendium.p.Actor.bear");
  });

  it("fresh policy always imports and never reuses", async () => {
    const gateway = new FakeGateway();
    gateway.worldActors.push({
      id: "w1",
      uuid: "Actor.w1",
      name: "Wolf",
      type: "npc",
      _stats: { compendiumSource: "Compendium.p.Actor.wolf" },
      prototypeToken: { name: "Wolf", width: 1, height: 1, actorLink: false, toObject: () => ({}) },
      hp: 1,
    });
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.wolf", "Wolf", 3)],
      { sceneId: "scene1", importPolicy: "fresh", hidden: true, addToCombat: "none", numberDuplicates: true },
      null,
    );
    expect(outcome.ledger.reused).toEqual([]);
    expect(gateway.importCount).toBe(1);
    expect(outcome.ledger.created.filter((c) => c.kind === "Token")).toHaveLength(3);
  });
});

describe("deployment semantics", () => {
  it("creates unlinked, hidden, numbered tokens with the deployment flag", async () => {
    const gateway = new FakeGateway();
    const service = new DeploymentService(gateway);
    await service.deploy(
      [entry("Compendium.p.Actor.wolf", "Wolf", 3)],
      { sceneId: "scene1", importPolicy: "reuse", hidden: true, addToCombat: "none", numberDuplicates: true },
      { x: 500, y: 500 },
    );
    expect(gateway.tokens).toHaveLength(3);
    for (const tk of gateway.tokens) {
      expect(tk.actorLink).toBe(false);
      expect(tk.hidden).toBe(true);
      expect(
        (tk.flags as Record<string, Record<string, string>>)["sargas-encounter-builder"]?.deployment,
      ).toBeTruthy();
    }
    expect(gateway.tokens.map((t) => t.name)).toEqual([
      "Imported wolf 1",
      "Imported wolf 2",
      "Imported wolf 3",
    ]);
    const positions = new Set(gateway.tokens.map((t) => `${t.x},${t.y}`));
    expect(positions.size).toBe(3);
  });

  it("T21: adding to combat creates combatants but never starts combat or rolls initiative", async () => {
    const gateway = new FakeGateway();
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.wolf", "Wolf", 2)],
      { sceneId: "scene1", importPolicy: "reuse", hidden: true, addToCombat: "new", numberDuplicates: true },
      null,
    );
    expect(gateway.combats).toHaveLength(1);
    expect(gateway.combats[0]?.started).toBe(false);
    expect(gateway.combats[0]?.combatants).toHaveLength(2);
    expect(outcome.ledger.created.filter((c) => c.kind === "Combatant")).toHaveLength(2);
  });

  it("rejects concurrent deployments and non-GM callers", async () => {
    const gateway = new FakeGateway();
    const service = new DeploymentService(gateway);
    const options = {
      sceneId: "scene1",
      importPolicy: "reuse" as const,
      hidden: true,
      addToCombat: "none" as const,
      numberDuplicates: true,
    };
    const first = service.deploy([entry("Compendium.p.Actor.wolf", "Wolf", 1)], options, null);
    await expect(
      service.deploy([entry("Compendium.p.Actor.wolf", "Wolf", 1)], options, null),
    ).rejects.toThrow(/in progress/);
    await first;
    (g.game as { user: { isGM: boolean } }).user.isGM = false;
    await expect(
      service.deploy([entry("Compendium.p.Actor.wolf", "Wolf", 1)], options, null),
    ).rejects.toThrow(/GM only/);
  });

  it("blocks deployment when the scene is missing or nothing is selected", async () => {
    const service = new DeploymentService(new FakeGateway());
    const options = {
      sceneId: "nope",
      importPolicy: "reuse" as const,
      hidden: true,
      addToCombat: "none" as const,
      numberDuplicates: true,
    };
    expect(service.preview([entry("Compendium.p.Actor.wolf", "Wolf", 1)], options).blockers).toContain(
      "noScene",
    );
    expect(service.preview([], { ...options, sceneId: "scene1" }).blockers).toContain("nothingToDeploy");
  });
});

describe("T23: partial failures are reported exactly and cleanup removes only operation-created documents", () => {
  it("reports an import failure and still places the rest", async () => {
    const gateway = new FakeGateway();
    gateway.failImportFor.add("Compendium.p.Actor.bear");
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.wolf", "Wolf", 2), entry("Compendium.p.Actor.bear", "Bear", 1)],
      { sceneId: "scene1", importPolicy: "reuse", hidden: true, addToCombat: "none", numberDuplicates: true },
      null,
    );
    expect(outcome.ledger.partial).toBe(true);
    expect(outcome.ledger.failures).toEqual([{ stage: "import", subject: "Bear", message: "import failed" }]);
    expect(outcome.ledger.summary()).toEqual({
      created: { Actor: 1, Token: 2, Combat: 0, Combatant: 0 },
      reused: 0,
      failures: 1,
    });
  });

  it("cleanup deletes created tokens/actors/combat but never reused actors or pre-existing tokens", async () => {
    const gateway = new FakeGateway();
    gateway.worldActors.push({
      id: "w1",
      uuid: "Actor.w1",
      name: "Wolf",
      type: "npc",
      _stats: { compendiumSource: "Compendium.p.Actor.wolf" },
      prototypeToken: { name: "Wolf", width: 1, height: 1, actorLink: false, toObject: () => ({}) },
      hp: 1,
    });
    gateway.sceneTokens.push({ x: 500, y: 500, width: 1, height: 1, name: "Pre-existing" });
    gateway.failCombat = true;
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.wolf", "Wolf", 1), entry("Compendium.p.Actor.bear", "Bear", 1)],
      { sceneId: "scene1", importPolicy: "reuse", hidden: true, addToCombat: "new", numberDuplicates: true },
      { x: 500, y: 500 },
    );
    expect(outcome.ledger.failures.map((f) => f.stage)).toEqual(["combat"]);
    const result = await service.cleanup(outcome.ledger);
    expect(result.failed).toEqual([]);
    expect(gateway.deleted).toEqual(
      expect.arrayContaining([
        "Scene.scene1.Token.tok0",
        "Scene.scene1.Token.tok1",
        "Combat.combat0",
        "Actor.imp1",
      ]),
    );
    expect(gateway.deleted).not.toContain("Actor.w1");
    expect(gateway.deleted.filter((d) => d.includes("Token"))).toHaveLength(2);
    // Deletion order: tokens before actors.
    expect(gateway.deleted.indexOf("Scene.scene1.Token.tok0")).toBeLessThan(
      gateway.deleted.indexOf("Actor.imp1"),
    );
  });

  it("cleanup keeps an imported actor that a token outside the operation uses, and reports it", async () => {
    const gateway = new FakeGateway();
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.bear", "Bear", 1)],
      { sceneId: "scene1", importPolicy: "fresh", hidden: true, addToCombat: "none", numberDuplicates: true },
      null,
    );
    gateway.foreignTokens.push({ uuid: "Scene.other.Token.x", actorId: "imp1" });
    const result = await service.cleanup(outcome.ledger);
    expect(gateway.deleted).toEqual(["Scene.scene1.Token.tok0"]);
    expect(result.removed).toBe(1);
    expect(result.kept).toEqual([{ kind: "Actor", name: "Imported bear", reason: "actorInUse" }]);
  });

  it("cleanup keeps a created combat that gained other combatants, removing only ours", async () => {
    const gateway = new FakeGateway();
    const service = new DeploymentService(gateway);
    const outcome = await service.deploy(
      [entry("Compendium.p.Actor.bear", "Bear", 1)],
      { sceneId: "scene1", importPolicy: "fresh", hidden: true, addToCombat: "new", numberDuplicates: true },
      null,
    );
    gateway.combats[0]!.combatants.push({ uuid: "Combat.combat0.Combatant.pc", tokenId: "pcToken" });
    const result = await service.cleanup(outcome.ledger);
    expect(gateway.deleted).toContain("Combat.combat0.Combatant.cb0");
    expect(gateway.deleted).not.toContain("Combat.combat0");
    expect(result.kept).toEqual([{ kind: "Combat", name: "Combat", reason: "combatInUse" }]);
  });

  it("planCleanup: pure decisions for actors and combats", () => {
    const created: CreatedRecord[] = [
      { kind: "Actor", id: "a1", uuid: "Actor.a1", name: "A1" },
      { kind: "Actor", id: "a2", uuid: "Actor.a2", name: "A2" },
      { kind: "Token", id: "t1", uuid: "Scene.s.Token.t1", name: "T1" },
      { kind: "Combat", id: "c1", uuid: "Combat.c1", name: "C1" },
      { kind: "Combatant", id: "cb1", uuid: "Combat.c1.Combatant.cb1", name: "CB1" },
    ];
    // Our own token referencing a1 does not keep it; a foreign token referencing a2 does.
    // A combatant matched by our token id (but not recorded) still counts as ours.
    const plan = planCleanup(created, {
      tokens: [
        { uuid: "Scene.s.Token.t1", actorId: "a1" },
        { uuid: "Scene.s2.Token.z", actorId: "a2" },
        { uuid: "Scene.s2.Token.y", actorId: null },
      ],
      combats: {
        "Combat.c1": [
          { uuid: "Combat.c1.Combatant.cb1", tokenId: "t1" },
          { uuid: "Combat.c1.Combatant.cb2", tokenId: "t1" },
        ],
      },
    });
    expect(plan.remove.map((r) => r.uuid)).toEqual([
      "Combat.c1.Combatant.cb1",
      "Scene.s.Token.t1",
      "Combat.c1",
      "Actor.a1",
    ]);
    expect(plan.kept).toEqual([{ record: created[1], reason: "actorInUse" }]);

    const busy = planCleanup(created, {
      tokens: [],
      combats: { "Combat.c1": [{ uuid: "Combat.c1.Combatant.other", tokenId: "pc" }] },
    });
    expect(busy.remove.map((r) => r.uuid)).toEqual([
      "Combat.c1.Combatant.cb1",
      "Scene.s.Token.t1",
      "Actor.a1",
      "Actor.a2",
    ]);
    expect(busy.kept.map((k) => k.reason)).toEqual(["combatInUse"]);
    // A combat that no longer exists is still targeted (deleting a missing document is a no-op).
    expect(planCleanup(created, { tokens: [], combats: {} }).remove.map((r) => r.kind)).toContain("Combat");
  });

  it("ledger cleanup targets exclude reused documents", () => {
    const ledger = new OperationLedger("op");
    ledger.reuse({ kind: "Actor", uuid: "Actor.keep", name: "Keep" });
    ledger.record({ kind: "Actor", id: "a", uuid: "Actor.a", name: "A" });
    ledger.record({ kind: "Token", id: "t", uuid: "Scene.s.Token.t", name: "T" });
    expect(ledger.cleanupTargets().map((c) => c.uuid)).toEqual(["Scene.s.Token.t", "Actor.a"]);
  });

  it("plans quantities and totals", () => {
    const plan = planDeployment(
      [entry("a", "A", 2), entry("b", "B", 0), entry("c", "C", 3)],
      { sceneId: "s", importPolicy: "fresh", hidden: true, addToCombat: "none", numberDuplicates: true },
      () => null,
    );
    expect(plan.totalTokens).toBe(5);
    expect(plan.actors).toHaveLength(2);
  });
});
