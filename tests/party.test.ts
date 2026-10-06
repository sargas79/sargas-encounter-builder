import { describe, expect, it } from "vitest";
import { evaluateEncounter } from "../src/core/budget.js";
import {
  addMemberToProfile,
  buildRoster,
  newProfile,
  setMemberActive,
  type ActorSummary,
} from "../src/core/party.js";
import { PartyService, type ProfileStore } from "../src/foundry/party-service.js";
import type { ActorResolver } from "../src/foundry/pf2e-adapter.js";
import type { PartyProfile } from "../src/core/schemas.js";

function summary(
  uuid: string,
  level: number | null,
  type = "character",
  extra: Partial<ActorSummary> = {},
): ActorSummary {
  return { uuid, name: uuid.replace("Actor.", ""), type, level, accessible: true, ...extra };
}

class MemoryStore implements ProfileStore {
  profiles: PartyProfile[] = [];
  active = "";
  load() {
    return structuredClone(this.profiles);
  }
  async save(p: PartyProfile[]) {
    this.profiles = structuredClone(p);
  }
  activeId() {
    return this.active;
  }
  async setActiveId(id: string) {
    this.active = id;
  }
}

class FakeResolver implements ActorResolver {
  constructor(
    public actors: Map<string, ActorSummary>,
    public partyMembers: Map<string, string[]> = new Map(),
  ) {}
  async resolve(uuid: string) {
    return this.actors.get(uuid) ?? { uuid, name: uuid, type: "unknown", level: null, accessible: false };
  }
  async partyMemberUuids(partyUuid: string) {
    return this.partyMembers.get(partyUuid) ?? null;
  }
  listPartyActors() {
    return [...this.partyMembers.keys()].map((uuid) => ({ uuid, name: uuid }));
  }
}

describe("T3: participation toggles and level changes update the evaluation", () => {
  it("recomputes party size, reference level and target when a member is toggled", async () => {
    const actors = new Map([
      ["Actor.a", summary("Actor.a", 4)],
      ["Actor.b", summary("Actor.b", 4)],
      ["Actor.c", summary("Actor.c", 4)],
      ["Actor.d", summary("Actor.d", 4)],
      ["Actor.e", summary("Actor.e", 4)],
    ]);
    const store = new MemoryStore();
    const service = new PartyService(new FakeResolver(actors), store, () => "p1");
    const profile = await service.createProfile("Five", "standalone");
    for (const uuid of actors.keys()) expect((await service.addMember(profile.id, uuid)).ok).toBe(true);

    let resolved = await service.resolve(service.getProfile("p1")!);
    expect(resolved.roster.partySize).toBe(5);
    expect(resolved.roster.reference.level).toBe(4);
    let evaluation = evaluateEncounter({
      partySize: 5,
      referenceLevel: 4,
      selectedThreat: "moderate",
      entries: [],
    });
    expect(evaluation.tier?.target).toBe(100);

    await service.setMemberActive("p1", "Actor.e", false);
    resolved = await service.resolve(service.getProfile("p1")!);
    expect(resolved.roster.partySize).toBe(4);
    expect(resolved.roster.members.find((m) => m.uuid === "Actor.e")?.status).toBe("inactive");
    evaluation = evaluateEncounter({
      partySize: 4,
      referenceLevel: 4,
      selectedThreat: "moderate",
      entries: [],
    });
    expect(evaluation.tier?.target).toBe(80);
  });

  it("picks up a level change after an actor update invalidates the cache", async () => {
    const actors = new Map([
      ["Actor.a", summary("Actor.a", 4)],
      ["Actor.b", summary("Actor.b", 4)],
    ]);
    const resolver = new FakeResolver(actors);
    const store = new MemoryStore();
    const service = new PartyService(resolver, store, () => "p1");
    const profile = await service.createProfile("Duo", "standalone");
    await service.addMember(profile.id, "Actor.a");
    await service.addMember(profile.id, "Actor.b");

    expect((await service.resolve(service.getProfile("p1")!)).roster.reference.level).toBe(4);

    // Level up Actor.b. Without invalidation the cached summary would still say 4.
    actors.set("Actor.b", summary("Actor.b", 5));
    let changes = 0;
    service.onChange(() => changes++);
    service.handleActorChange("Actor.b", { system: { details: { level: { value: 5 } } } });
    expect(changes).toBe(1);

    const resolved = await service.resolve(service.getProfile("p1")!);
    expect(resolved.roster.reference.requiresChoice).toBe(true);
    expect(resolved.roster.reference.distinctLevels).toEqual([4, 5]);
  });

  it("ignores irrelevant actor updates", () => {
    const service = new PartyService(new FakeResolver(new Map()), new MemoryStore());
    let changes = 0;
    service.onChange(() => changes++);
    service.handleActorChange("Actor.x", { flags: { other: true } });
    expect(changes).toBe(0);
  });
});

describe("T4: mixed levels, no active PCs, missing PCs, invalid reference levels are visible", () => {
  const base = newProfile("p", "Test", "standalone");

  it("blocks evaluation until a policy is chosen for mixed levels, then resolves it", () => {
    const summaries = new Map([
      ["Actor.a", summary("Actor.a", 3)],
      ["Actor.b", summary("Actor.b", 5)],
    ]);
    const profile = {
      ...base,
      members: [
        { uuid: "Actor.a", active: true },
        { uuid: "Actor.b", active: true },
      ],
    };
    let roster = buildRoster(profile, summaries);
    expect(roster.blockers).toContain("mixedLevelsNeedPolicy");
    expect(roster.reference.level).toBeNull();
    expect(roster.members.map((m) => m.level)).toEqual([3, 5]);

    roster = buildRoster({ ...profile, referencePolicy: "averageFloor" }, summaries);
    expect(roster.blockers).toEqual([]);
    expect(roster.reference).toMatchObject({ level: 4, isEstimate: true });

    roster = buildRoster({ ...profile, referencePolicy: "manual", manualReferenceLevel: 30 }, summaries);
    expect(roster.blockers).toContain("referenceLevelUnresolved");
  });

  it("reports no active characters when everyone is inactive or non-character", () => {
    const summaries = new Map([
      ["Actor.a", summary("Actor.a", 3)],
      ["Actor.fam", summary("Actor.fam", 3, "familiar")],
      ["Actor.npc", summary("Actor.npc", 3, "npc")],
    ]);
    const profile = {
      ...base,
      members: [
        { uuid: "Actor.a", active: false },
        { uuid: "Actor.fam", active: true },
        { uuid: "Actor.npc", active: true },
      ],
    };
    const roster = buildRoster(profile, summaries);
    expect(roster.partySize).toBe(0);
    expect(roster.blockers).toContain("noActiveCharacters");
    expect(roster.members.map((m) => m.status)).toEqual(["inactive", "notCounted", "notCounted"]);
  });

  it("counts an NPC ally only through an explicit override", () => {
    const summaries = new Map([
      ["Actor.a", summary("Actor.a", 3)],
      ["Actor.npc", summary("Actor.npc", 3, "npc")],
    ]);
    const profile = {
      ...base,
      members: [
        { uuid: "Actor.a", active: true },
        { uuid: "Actor.npc", active: true, countsAsMember: true },
      ],
    };
    const roster = buildRoster(profile, summaries);
    expect(roster.partySize).toBe(2);
    expect(roster.members[1]?.status).toBe("overrideCounted");
  });

  it("flags missing or inaccessible actors without dropping them", () => {
    const summaries = new Map([["Actor.a", summary("Actor.a", 3)]]);
    const profile = {
      ...base,
      members: [
        { uuid: "Actor.a", active: true },
        { uuid: "Actor.gone", active: true },
      ],
    };
    const roster = buildRoster(profile, summaries);
    expect(roster.missing.map((m) => m.uuid)).toEqual(["Actor.gone"]);
    expect(roster.members).toHaveLength(2);
    expect(roster.partySize).toBe(1);
  });

  it("rejects unsupported types and duplicates when adding members", () => {
    const withA = addMemberToProfile(base, summary("Actor.a", 3));
    expect(withA.ok).toBe(true);
    if (!withA.ok) return;
    expect(addMemberToProfile(withA.profile, summary("Actor.a", 3))).toEqual({
      ok: false,
      reason: "duplicateMember",
    });
    expect(addMemberToProfile(withA.profile, summary("Actor.p", null, "party"))).toEqual({
      ok: false,
      reason: "rejectParty",
    });
    expect(addMemberToProfile(withA.profile, summary("Actor.h", 2, "hazard"))).toEqual({
      ok: false,
      reason: "rejectHazard",
    });
    expect(addMemberToProfile(withA.profile, summary("Actor.f", 2, "familiar"))).toEqual({
      ok: false,
      reason: "rejectFamiliar",
    });
    expect(addMemberToProfile(withA.profile, summary("Actor.v", 2, "vehicle"))).toEqual({
      ok: false,
      reason: "rejectUnsupported",
    });
    expect(
      addMemberToProfile({ ...base, kind: "linked", partyActorUuid: "Actor.party" }, summary("Actor.z", 3)),
    ).toEqual({
      ok: false,
      reason: "linkedProfileReadOnly",
    });
  });

  it("reads members live from a linked Party actor and applies participation overrides", async () => {
    const actors = new Map([
      ["Actor.a", summary("Actor.a", 6)],
      ["Actor.b", summary("Actor.b", 6)],
      ["Actor.comp", summary("Actor.comp", 6, "character", { isCompanionLike: true })],
    ]);
    const resolver = new FakeResolver(
      actors,
      new Map([["Actor.party", ["Actor.a", "Actor.b", "Actor.comp"]]]),
    );
    const store = new MemoryStore();
    const service = new PartyService(resolver, store, () => "linked");
    const profile = await service.createProfile("Linked", "linked", "Actor.party");
    let resolved = await service.resolve(profile);
    expect(resolved.roster.partySize).toBe(2);
    expect(resolved.roster.members.find((m) => m.uuid === "Actor.comp")?.status).toBe("notCounted");

    await service.setMemberActive(profile.id, "Actor.b", false);
    resolved = await service.resolve(service.getProfile("linked")!);
    expect(resolved.roster.partySize).toBe(1);

    // The Party actor roster changes live without touching the profile.
    resolver.partyMembers.set("Actor.party", ["Actor.a"]);
    resolved = await service.resolve(service.getProfile("linked")!);
    expect(resolved.roster.members.map((m) => m.uuid)).toEqual(["Actor.a"]);
  });

  it("keeps inactive members in the roster", () => {
    const profile = setMemberActive(
      { ...base, members: [{ uuid: "Actor.a", active: true }] },
      "Actor.a",
      false,
    );
    expect(profile.members).toEqual([{ uuid: "Actor.a", active: false }]);
  });
});

describe("actor change notifications are limited to the party", () => {
  it("ignores updates to actors outside every profile (combat HP changes)", async () => {
    const actors = new Map([["Actor.a", summary("Actor.a", 4)]]);
    const service = new PartyService(new FakeResolver(actors), new MemoryStore(), () => "p1");
    const profile = await service.createProfile("Solo", "standalone");
    await service.addMember(profile.id, "Actor.a");
    let changes = 0;
    service.onChange(() => changes++);

    service.handleActorChange("Actor.goblin", { system: { attributes: { hp: { value: 3 } } } });
    service.handleActorChange("Scene.s.Token.t.Actor.goblin", {
      system: { attributes: { hp: { value: 2 } } },
    });
    service.handleActorChange("Actor.goblin", undefined, { actorType: "npc" });
    expect(changes).toBe(0);

    service.handleActorChange("Actor.a", { system: { attributes: { hp: { value: 3 } } } });
    expect(changes).toBe(1);
    service.handleActorChange("Actor.a", undefined, { actorType: "character" });
    expect(changes).toBe(2);
  });

  it("emits for the linked Party actor and the members read from it", async () => {
    const actors = new Map([
      ["Actor.a", summary("Actor.a", 6)],
      ["Actor.b", summary("Actor.b", 6)],
    ]);
    const resolver = new FakeResolver(actors, new Map([["Actor.party", ["Actor.a"]]]));
    const service = new PartyService(resolver, new MemoryStore(), () => "linked");
    const profile = await service.createProfile("Linked", "linked", "Actor.party");
    await service.resolve(profile);
    let changes = 0;
    service.onChange(() => changes++);

    service.handleActorChange("Actor.b", { system: {} });
    expect(changes).toBe(0);
    service.handleActorChange("Actor.a", { system: {} });
    expect(changes).toBe(1);
    // A member joins the Party actor: its update is relevant, and so is the new member afterwards.
    resolver.partyMembers.set("Actor.party", ["Actor.a", "Actor.b"]);
    service.handleActorChange("Actor.party", { system: { details: { members: [] } } });
    expect(changes).toBe(2);
    await service.resolve(service.getProfile("linked")!);
    service.handleActorChange("Actor.b", { system: {} });
    expect(changes).toBe(3);
  });

  it("emits when a Party actor is created or deleted (the linkable list changes)", () => {
    const service = new PartyService(new FakeResolver(new Map()), new MemoryStore());
    let changes = 0;
    service.onChange(() => changes++);
    service.handleActorChange("Actor.newParty", undefined, { actorType: "party" });
    expect(changes).toBe(1);
    service.handleActorChange("Actor.newParty", { system: {} });
    expect(changes).toBe(1);
  });
});
