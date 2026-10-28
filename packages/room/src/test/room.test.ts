// A room and its clients: the lobby, the clock, and catching up.
//
// The property every test here leans on is the one the whole design rests on:
// clients that apply the same batches reach the same hash as the room.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE, STEPS_PER_SECOND } from "@tessera/sim";
import type { Identity } from "@tessera/protocol";
import type { RoomClient } from "../client.js";
import { SNAPSHOT_EVERY } from "../advance.js";
import { Harness, identities } from "./harness.js";
import type { Linked } from "./harness.js";

let alice: Identity;
let bob: Identity;
let carol: Identity;
let dave: Identity;

beforeAll(async () => {
  [alice, bob, carol, dave] = (await identities(4)) as [Identity, Identity, Identity, Identity];
});

/** A claim this client's seat can make right now, next to its own ground. */
function aClaim(client: RoomClient): { x: number; y: number } | undefined {
  const sim = client.sim!;
  const seat = client.you!.seat!;
  const { width, height } = sim.state;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const move = { step: sim.step, empire: seat.empire, member: seat.member, seq: 0, type: MOVE.CLAIM, x, y };
      if (sim.validate(move)) return { x, y };
    }
  }
  return undefined;
}

async function started(duration?: number): Promise<{ h: Harness; a: Linked; b: Linked }> {
  const h = new Harness({ creator: alice.key, bots: ["easy"], ...(duration ? { duration } : {}) });
  const a = await h.join(alice, "alice");
  const b = await h.join(bob, "bob");
  a.client.pickEmpire(0);
  b.client.pickEmpire(1);
  await h.settle();
  a.client.start();
  await h.settle();
  return { h, a, b };
}

const tilesOf = (client: RoomClient): number =>
  client.sim!.state.empires[client.you!.seat!.empire - 1]!.tilesOwned;

describe("the lobby", () => {
  it("lists who is here and what they picked", async () => {
    const h = new Harness({ creator: alice.key });
    const a = await h.join(alice, "alice");
    const b = await h.join(bob, "bob");
    b.client.pickEmpire(1);
    await h.settle();

    const lobby = a.client.lobby!;
    expect(lobby.creator).toBe(alice.key);
    expect(lobby.players.map((p) => [p.name, p.empire, p.connected])).toEqual([
      ["alice", null, true],
      ["bob", 1, true],
    ]);
  });

  it("refuses an empire that is already full", async () => {
    const h = new Harness({ creator: alice.key, seatsPerEmpire: 1 });
    const a = await h.join(alice);
    const b = await h.join(bob);
    a.client.pickEmpire(0);
    await h.settle();
    b.client.pickEmpire(0);
    await h.settle();
    expect(b.client.lobby!.players.find((p) => p.key === bob.key)!.empire).toBeNull();
  });

  it("lets only the creator start", async () => {
    const h = new Harness({ creator: alice.key, bots: ["easy"] });
    await h.join(alice);
    const b = await h.join(bob);
    b.client.pickEmpire(0);
    await h.settle();
    b.client.start();
    await h.settle();
    expect(b.client.phase).toBe("lobby");
    expect(b.errors).toContain("only the creator can start");
  });

  it("will not start with nobody seated", async () => {
    const h = new Harness({ creator: alice.key, bots: ["easy"] });
    const a = await h.join(alice);
    a.client.start();
    await h.settle();
    expect(a.client.phase).toBe("lobby");
    expect(a.errors).toContain("nobody has picked an empire");
  });

  it("starts with a sealed genesis and a seat for each player", async () => {
    const { a, b } = await started();
    const genesis = a.client.genesis!;
    expect(genesis.gameId).toBeTruthy();
    expect(b.client.genesis!.gameId).toBe(genesis.gameId);
    expect(a.client.you!.seat).toEqual({ empire: 1, member: 0 });
    expect(b.client.you!.seat).toEqual({ empire: 2, member: 0 });
    // Two human empires and one bot.
    expect(genesis.empires).toHaveLength(3);
  });

  it("leaves an empire nobody picked open", async () => {
    const h = new Harness({ creator: alice.key, empires: 3, bots: ["easy"] });
    const a = await h.join(alice);
    a.client.pickEmpire(0);
    await h.settle();
    a.client.start();
    await h.settle();
    const empires = a.client.genesis!.empires;
    expect(empires[1]!.members).toEqual([]);
    expect(empires[2]!.members).toEqual([]);
  });

  it("starts on its own at the scheduled time", async () => {
    const startAt = 1_800_000_000_000 + 60_000;
    const scheduled = new Harness({ creator: alice.key, bots: ["easy"], startAt });
    scheduled.restart(); // the schedule is read back from the store, as after a wake
    const b = await scheduled.join(bob);
    b.client.pickEmpire(1);
    await scheduled.settle();
    expect(scheduled.room.wakeAt()).toBe(startAt);

    await scheduled.run(30_000, 1000);
    expect(b.client.phase).toBe("lobby");
    await scheduled.run(31_000, 1000);
    expect(b.client.phase).toBe("playing");
    expect(b.client.you!.seat).toEqual({ empire: 2, member: 0 });
  });
});

describe("playing", () => {
  it("keeps every client at the room's step and hash", async () => {
    const { h, a, b } = await started();
    const watcher = await h.join(carol);
    await h.run(10_000);

    expect(a.client.sim!.step).toBe(h.room.step);
    expect(b.client.sim!.step).toBe(h.room.step);
    expect(watcher.client.sim!.step).toBe(h.room.step);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
    expect(b.client.sim!.hash()).toBe(h.room.hash());
    expect(watcher.client.sim!.hash()).toBe(h.room.hash());
    expect(watcher.client.you!.seat).toBeUndefined();
  });

  it("applies a signed move on every client", async () => {
    const { h, a, b } = await started();
    await h.run(5_000);
    const before = tilesOf(a.client);

    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);

    expect(tilesOf(a.client)).toBe(before + 1);
    expect(b.client.sim!.state.owner[at.y * b.client.sim!.state.width + at.x]).toBe(1);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
    expect(b.client.sim!.hash()).toBe(h.room.hash());
  });

  it("refuses a move from a key with no seat", async () => {
    const { h } = await started();
    const watcher = await h.join(carol);
    expect(await watcher.client.submit(MOVE.CLAIM, 1, 1)).toBe(false);
    await h.settle();
  });

  it("refuses a reused sequence number", async () => {
    const { h, a } = await started();
    await h.run(5_000);
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    // Forget the count, as a tab that did not hear back might.
    (a.client as unknown as { nextSeq: number }).nextSeq = 0;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    expect(a.errors).toContain("stale seq");
  });

  it("heartbeats for connected seats only", async () => {
    const { h, a, b } = await started();
    b.drop();
    await h.run(65_000, 1000);
    const members = a.client.sim!.state.empires.map((e) => e.members[0]?.lastBeat ?? -1);
    const step = a.client.sim!.step;
    // Alice is here: beaten within the last interval. Bob left at once.
    expect(step - members[0]!).toBeLessThanOrEqual(a.client.genesis!.rules.heartbeatInterval);
    expect(members[1]).toBe(0);
  });

  it("resyncs a client whose state has drifted", async () => {
    const { h, a } = await started();
    await h.run(2_000);
    // Corrupt one tile the way a bug would.
    a.client.sim!.state.pop[0] = 9999;
    expect(a.client.sim!.hash()).not.toBe(h.room.hash());
    await h.run(6_000);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
  });
});

describe("catching up", () => {
  it("brings a dropped client back to the room's step", async () => {
    const { h, a, b } = await started();
    await h.run(3_000);
    b.drop();
    await h.run(120_000, 1000);
    b.reconnect();
    await h.settle();
    expect(b.client.sim!.step).toBe(h.room.step);
    expect(b.client.sim!.hash()).toBe(h.room.hash());
    await h.run(2_000);
    expect(b.client.sim!.hash()).toBe(a.client.sim!.hash());
  });

  it("starts a late joiner from the snapshot", async () => {
    const { h } = await started();
    await h.run((SNAPSHOT_EVERY / STEPS_PER_SECOND) * 1000 * 2 + 3_000, 1000);
    const late = await h.join(dave);
    expect(late.client.sim!.step).toBe(h.room.step);
    expect(late.client.sim!.hash()).toBe(h.room.hash());
  });

  it("catches the world up after nobody was connected", async () => {
    const { h, a, b } = await started(STEPS_PER_SECOND * 60 * 60 * 24);
    await h.run(2_000);
    a.drop();
    b.drop();
    expect(h.room.wantsTicks()).toBe(false);
    h.clock.advance(6 * 60 * 60 * 1000); // six hours with the room asleep
    a.reconnect();
    await h.settle();
    // Six hours is long enough for a bot to finish off two absent empires, so
    // the room either reached now or stopped where the game ended.
    const now = (6 * 60 * 60 + 2) * STEPS_PER_SECOND;
    expect(h.room.ended || h.room.step === now).toBe(true);
    expect(h.room.step).toBeGreaterThan(STEPS_PER_SECOND * 60 * 20);
    expect(a.client.sim!.step).toBe(h.room.step);
    expect(a.client.sim!.ended).toBe(h.room.ended);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
  });

  it("survives the room being rebuilt from its store", async () => {
    const { h, a, b } = await started();
    await h.run(4_000);
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    const step = h.room.step;
    const hash = h.room.hash();

    a.drop();
    b.drop();
    h.restart();
    expect(h.room.step).toBe(step);
    expect(h.room.hash()).toBe(hash);

    a.reconnect();
    b.reconnect();
    await h.settle();
    await h.run(2_000);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
    expect(b.client.sim!.hash()).toBe(h.room.hash());
    // The seq count came back with the room, so a's next move is accepted.
    const next = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, next.x, next.y);
    await h.settle();
    await h.run(1_000);
    expect(a.errors).toEqual([]);
  });
});

describe("hosting", () => {
  it("takes back authenticated sockets after the room object is rebuilt", async () => {
    const { h, a, b } = await started();
    await h.run(2_000);
    // What a woken Durable Object does: a fresh room, the same sockets.
    h.restart();
    a.reattach(h.room);
    b.reattach(h.room);
    await h.run(2_000);
    expect(a.client.sim!.hash()).toBe(h.room.hash());
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    expect(a.errors).toEqual([]);
    expect(b.client.sim!.hash()).toBe(h.room.hash());
  });
});
