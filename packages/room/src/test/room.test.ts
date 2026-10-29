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

    expect(a.client.sim!.step).toBe(h.roomStep());
    expect(b.client.sim!.step).toBe(h.roomStep());
    expect(watcher.client.sim!.step).toBe(h.roomStep());
    expect(a.client.sim!.hash()).toBe(h.roomHash());
    expect(b.client.sim!.hash()).toBe(h.roomHash());
    expect(watcher.client.sim!.hash()).toBe(h.roomHash());
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
    expect(a.client.sim!.hash()).toBe(h.roomHash());
    expect(b.client.sim!.hash()).toBe(h.roomHash());
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

  it("still refuses a reused sequence number after the room is rebuilt", async () => {
    const { h, a } = await started();
    await h.run(5_000);
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    // Rebuilt before any snapshot holds the count: it comes back from the log.
    h.restart();
    a.reattach(h.room);
    (a.client as unknown as { nextSeq: number }).nextSeq = 0;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    expect(a.errors).toContain("stale seq");
  });

  it("does not beat early for a room that keeps being rebuilt", async () => {
    const { h, a, b } = await started();
    b.drop();
    const log = (): number =>
      h.store.movesFrom(0).filter((s) => s.move.type === MOVE.HEARTBEAT && s.move.empire === 1).length;
    for (let i = 0; i < 6; i++) {
      await h.run(60_000, 1000);
      h.restart();
      a.reattach(h.room);
    }
    // Six minutes, a beat every three: the first, and two more.
    expect(log()).toBeLessThanOrEqual(3);
  });

  it("heartbeats for connected seats only", async () => {
    const { h, a, b } = await started();
    b.drop();
    await h.run(7 * 60_000, 1000);
    const members = a.client.sim!.state.empires.map((e) => e.members[0]?.lastBeat ?? -1);
    const step = a.client.sim!.step;
    const rules = a.client.genesis!.rules;
    // Alice is here: beaten within the last interval, give or take a report,
    // and so live by the sim's own measure. Bob left at once.
    expect(members[0]).toBeGreaterThan(rules.heartbeatInterval);
    expect(step - members[0]!).toBeLessThanOrEqual(rules.livenessWindow);
    expect(members[1]).toBe(0);
  });

  it("resyncs a client whose state has drifted", async () => {
    const { h, a } = await started();
    await h.run(2_000);
    // Corrupt one tile the way a bug would.
    a.client.sim!.state.pop[0] = 9999;
    expect(a.client.sim!.hash()).not.toBe(h.roomHash());
    // The next hash report, every minute of game time, finds it.
    await h.run(65_000, 1000);
    expect(a.client.sim!.hash()).toBe(h.roomHash());
  });
});

describe("late moves", () => {
  it("rewinds and replays a move that arrives after its step", async () => {
    const { h, a, b } = await started();
    await h.run(3_000);
    b.hold();
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    // Two seconds: well past the half-second lead the move was stamped with.
    await h.run(2_000);
    const owner = () => b.client.sim!.state.owner[at.y * b.client.sim!.state.width + at.x];
    expect(owner()).toBe(0);
    b.release();
    await h.settle();
    expect(owner()).toBe(1);
    expect(b.client.sim!.hash()).toBe(h.roomHash());
    expect(a.client.sim!.hash()).toBe(h.roomHash());
  });

  it("asks for the room's state when a move is older than it can rewind", async () => {
    const { h, a, b } = await started();
    await h.run(3_000);
    b.hold();
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(30_000, 1000);
    b.release();
    await h.settle();
    await h.run(1_000);
    expect(b.client.sim!.hash()).toBe(h.roomHash());
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
    expect(b.client.sim!.step).toBe(h.roomStep());
    expect(b.client.sim!.hash()).toBe(h.roomHash());
    await h.run(2_000);
    expect(b.client.sim!.hash()).toBe(a.client.sim!.hash());
  });

  it("starts a late joiner from the snapshot", async () => {
    const { h } = await started();
    await h.run((SNAPSHOT_EVERY / STEPS_PER_SECOND) * 1000 * 2 + 3_000, 1000);
    const late = await h.join(dave);
    expect(late.client.sim!.step).toBe(h.roomStep());
    expect(late.client.sim!.hash()).toBe(h.roomHash());
  });

  it("catches the world up after nobody was connected", async () => {
    const { h, a, b } = await started(STEPS_PER_SECOND * 60 * 60 * 24);
    await h.run(2_000);
    a.drop();
    b.drop();
    h.clock.advance(6 * 60 * 60 * 1000); // six hours with the room asleep
    a.reconnect();
    await h.settle();
    // Six hours is long enough for a bot to finish off two absent empires, so
    // the room either reached now or stopped where the game ended.
    const now = (6 * 60 * 60 + 2) * STEPS_PER_SECOND;
    expect(h.room.ended || h.roomStep() === now).toBe(true);
    expect(h.roomStep()).toBeGreaterThan(STEPS_PER_SECOND * 60 * 20);
    expect(a.client.sim!.step).toBe(h.roomStep());
    expect(a.client.sim!.ended).toBe(h.room.ended);
    expect(a.client.sim!.hash()).toBe(h.roomHash());
  });

  it("survives the room being rebuilt from its store", async () => {
    const { h, a, b } = await started();
    await h.run(4_000);
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    const step = h.roomStep();
    const hash = h.roomHash();

    a.drop();
    b.drop();
    h.restart();
    expect(h.roomStep()).toBe(step);
    expect(h.roomHash()).toBe(hash);

    a.reconnect();
    b.reconnect();
    await h.settle();
    await h.run(2_000);
    expect(a.client.sim!.hash()).toBe(h.roomHash());
    expect(b.client.sim!.hash()).toBe(h.roomHash());
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
    expect(a.client.sim!.hash()).toBe(h.roomHash());
    const at = aClaim(a.client)!;
    await a.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    expect(a.errors).toEqual([]);
    expect(b.client.sim!.hash()).toBe(h.roomHash());
  });
});

describe("joining a game that has started", () => {
  async function withOpenEmpire(joinShare?: number) {
    const h = new Harness({
      creator: alice.key,
      empires: 3,
      bots: ["easy"],
      ...(joinShare !== undefined ? { joinShare } : {}),
    });
    const a = await h.join(alice, "alice");
    a.client.pickEmpire(0);
    await h.settle();
    a.client.start();
    await h.settle();
    await h.run(2_000);
    return { h, a };
  }

  it("seats somebody who takes an open empire", async () => {
    const { h, a } = await withOpenEmpire();
    const c = await h.join(carol, "carol");
    expect(c.client.you!.seat).toBeUndefined();
    c.client.claim(2);
    await h.settle();
    await h.run(1_000);
    expect(c.client.you!.seat).toEqual({ empire: 2, member: 0 });
    expect(a.client.sim!.state.empires[1]!.members).toHaveLength(1);
    expect(c.client.sim!.hash()).toBe(h.roomHash());
    // And the new seat can play.
    await h.run(1_000);
    const at = aClaim(c.client)!;
    await c.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    expect(c.errors).toEqual([]);
    expect(a.client.sim!.state.owner[at.y * a.client.sim!.state.width + at.x]).toBe(2);
  });

  it("refuses an empire somebody already holds", async () => {
    const { h } = await withOpenEmpire();
    const c = await h.join(carol);
    c.client.claim(1);
    await h.settle();
    expect(c.errors).toContain("that empire cannot be taken");
  });

  it("seats somebody an empire's member approves", async () => {
    const { h, a } = await withOpenEmpire();
    const c = await h.join(carol, "carol");
    c.client.ask(1);
    await h.settle();
    expect(a.client.people.requests).toEqual([{ key: carol.key, name: "carol", empire: 1 }]);

    a.client.approve(carol.key);
    await h.settle();
    await h.run(1_000);
    expect(c.client.you!.seat).toEqual({ empire: 1, member: 1 });
    expect(a.client.people.requests).toEqual([]);
    expect(a.client.people.people.find((p) => p.key === carol.key)!.seat).toEqual({ empire: 1, member: 1 });
    expect(c.client.sim!.hash()).toBe(h.roomHash());
  });

  it("lets only that empire answer a request", async () => {
    const { h } = await withOpenEmpire();
    const c = await h.join(carol);
    c.client.claim(2);
    await h.settle();
    await h.run(1_000);
    const d = await h.join(dave);
    d.client.ask(1);
    await h.settle();
    c.client.approve(dave.key);
    await h.settle();
    await h.run(1_000);
    expect(d.client.you!.seat).toBeUndefined();
    expect(c.errors).toContain("only that empire can answer");
  });

  it("seats somebody holding a member's invite, once", async () => {
    const { h, a } = await withOpenEmpire();
    // The harness clock runs ahead of the real one; give the invite room.
    const invite = (await a.client.invite(365 * 24 * 3600 * 1000))!;
    const c = await h.join(carol);
    c.client.redeem(invite);
    await h.settle();
    await h.run(1_000);
    expect(c.client.you!.seat).toEqual({ empire: 1, member: 1 });

    const d = await h.join(dave);
    d.client.redeem(invite);
    await h.settle();
    expect(d.errors).toContain("that invite has been used");
  });

  it("refuses a forged invite", async () => {
    const { h, a } = await withOpenEmpire();
    // The harness clock runs ahead of the real one; give the invite room.
    const invite = (await a.client.invite(365 * 24 * 3600 * 1000))!;
    const c = await h.join(carol);
    c.client.redeem({ ...invite, invite: { ...invite.invite, empire: 2 } });
    await h.settle();
    expect(c.errors).toContain("that invite did not verify");
  });

  it("closes the door when the join window does", async () => {
    const { h } = await withOpenEmpire(0);
    const c = await h.join(carol);
    c.client.claim(2);
    await h.settle();
    await h.run(1_000);
    expect(c.client.you!.seat).toBeUndefined();
  });

  it("keeps late seats when the room is rebuilt", async () => {
    const { h, a } = await withOpenEmpire();
    const c = await h.join(carol);
    c.client.claim(2);
    await h.settle();
    await h.run(1_000);
    const hash = h.roomHash();
    a.drop();
    c.drop();
    h.restart();
    expect(h.roomHash()).toBe(hash);
    c.reconnect();
    await h.settle();
    expect(c.client.you!.seat).toEqual({ empire: 2, member: 0 });
    await h.run(1_000);
    const at = aClaim(c.client)!;
    await c.client.submit(MOVE.CLAIM, at.x, at.y);
    await h.settle();
    await h.run(1_000);
    expect(c.errors).toEqual([]);
  });
});

describe("chat", () => {
  it("carries a line to everybody, and keeps it for latecomers", async () => {
    const { h, a, b } = await started();
    a.client.say("hello all");
    await h.settle();
    expect(b.client.chat.map((l) => [l.name, l.text, l.channel])).toEqual([["alice", "hello all", "all"]]);
    const c = await h.join(carol);
    expect(c.client.chat.map((l) => l.text)).toEqual(["hello all"]);
  });

  it("keeps a team line inside the empire", async () => {
    const h = new Harness({ creator: alice.key, bots: ["easy"] });
    const a = await h.join(alice, "alice");
    const b = await h.join(bob, "bob");
    const c = await h.join(carol, "carol");
    a.client.pickEmpire(0);
    b.client.pickEmpire(0);
    c.client.pickEmpire(1);
    await h.settle();
    a.client.start();
    await h.settle();

    a.client.say("flank them", "team");
    await h.settle();
    expect(b.client.chat.map((l) => l.text)).toEqual(["flank them"]);
    expect(c.client.chat).toEqual([]);
    const watcher = await h.join(dave);
    expect(watcher.client.chat).toEqual([]);
  });

  it("strips what should not be in a line, and refuses a flood", async () => {
    const { h, a, b } = await started();
    a.client.say("  look‮right   here ");
    a.client.say("again");
    await h.settle();
    expect(b.client.chat.map((l) => l.text)).toEqual(["lookright here"]);
  });
});

describe("bots", () => {
  it("are seated as bot seats, by invite, even after the join window", async () => {
    const h = new Harness({ creator: alice.key, empires: 2, bots: ["easy"], joinShare: 0 });
    const a = await h.join(alice, "alice");
    a.client.pickEmpire(0);
    await h.settle();
    a.client.start();
    await h.settle();
    await h.run(2_000);

    const invite = (await a.client.invite(365 * 24 * 3600 * 1000))!;
    const bot = await h.join(dave, "night watch", { bot: true });
    bot.client.redeem(invite);
    await h.settle();
    await h.run(1_000);
    expect(bot.client.you!.seat).toEqual({ empire: 1, member: 1 });
    expect(a.client.sim!.state.empires[0]!.members[1]!.kind).toBe(1); // MEMBER.BOT
    expect(a.client.people.people.find((p) => p.key === dave.key)!.bot).toBe(true);
  });

  it("cannot take an empire nobody holds", async () => {
    const h = new Harness({ creator: alice.key, empires: 3, bots: ["easy"] });
    const a = await h.join(alice);
    a.client.pickEmpire(0);
    await h.settle();
    a.client.start();
    await h.settle();
    const bot = await h.join(dave, "bot", { bot: true });
    bot.client.claim(2);
    await h.settle();
    expect(bot.errors).toContain("a bot joins by invite or approval");
  });
});
