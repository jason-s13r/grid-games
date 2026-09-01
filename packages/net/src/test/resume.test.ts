// Coming back to a game that carried on without you.
//
// A snapshot is content-addressed by its hash, so one from an untrusted peer is
// safe to accept: restore it, hash it, and put the old state back if the number
// disagrees. That is exactly what lets an archive peer be useful without being
// an authority.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE, Sim } from "@tessera/sim";
import { Roster } from "@tessera/protocol";
import { Lockstep } from "../index.js";
import { MS_PER_STEP, agreed, clickAround, pickClaim, run, settle, settleNetwork, table } from "./harness.js";
import type { Peer, Table } from "./harness.js";

describe("a returning peer rebuilds from an untrusted snapshot", () => {
  let t: Table;
  let latecomer: Lockstep;
  let entry: { step: number; hash: number; data: ArrayBuffer };

  beforeAll(async () => {
    t = await table({ seats: [2, 1], observer: true, snapshotInterval: 12 });
    await run(t, 96, await clickAround(t, 24));
    entry = t.peers[0]!.driver.snapshots.latest()!;

    latecomer = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("latecomer"),
      now: t.clock.now,
    });
    latecomer.start();
  });

  it("snapshots are being kept", () => expect(entry).toBeDefined());

  it("more than one is retained", () => {
    expect(t.peers[0]!.driver.snapshots.size).toBeGreaterThan(1);
  });

  it("it starts at the beginning", () => expect(latecomer.step).toBe(0));

  it("a snapshot with the wrong hash is refused", () => {
    expect(latecomer.adopt(entry.data, entry.hash ^ 1)).toBe(false);
  });

  it("and refusing it left the state alone", () => expect(latecomer.step).toBe(0));

  it("the real one is accepted", () => {
    expect(latecomer.adopt(entry.data, entry.hash)).toBe(true);
  });

  it("it lands on the snapshot's step and state", () => {
    expect([latecomer.step, latecomer.hash()]).toEqual([entry.step, entry.hash]);
  });

  // It holds no seat, so nobody was waiting for it; it simply catches up.
  it("and it catches up to the table", async () => {
    await run(t, 24);
    await settleNetwork(t, () => latecomer.pump());
    const source = t.peers[0]!.driver;
    expect([latecomer.step, latecomer.hash()]).toEqual([source.step, source.hash()]);
  });
});

describe("a peer arriving late resumes without being told to", () => {
  let t: Table;
  let latecomer: Lockstep;
  let storedStep: number;
  let stepAfterOneRound: number;

  // The world, with the latecomer pumped alongside the table.
  const spin = async (rounds: number): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      t.clock.advance(MS_PER_STEP);
      await settleNetwork(t, () => latecomer.pump());
    }
    await settleNetwork(t, () => latecomer.pump());
  };

  beforeAll(async () => {
    // Snapshots every 24 steps and clicks every 30, so by the time the
    // latecomer arrives the newest snapshot is a few steps behind the table
    // with moves in the gap — the case a stored snapshot alone cannot answer,
    // and the reason a request is served from the present.
    t = await table({ seats: [2, 1], snapshotInterval: 24 });
    await run(t, 180, await clickAround(t, 30));
    storedStep = t.peers[0]!.driver.snapshots.latest()!.step;

    // No seat: an observer is the honest shape here, because it isolates the
    // resume from the question of whether the table waited for it.
    latecomer = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("latecomer"),
      now: t.clock.now,
      snapshotInterval: 24,
    });
    latecomer.start();

    // One round is enough for the request to go out and the answer to come back.
    await spin(1);
    stepAfterOneRound = latecomer.step;
    await spin(24);
  });

  it("the newest stored snapshot was already behind the table", () => {
    expect(storedStep).toBeLessThan(t.peers[0]!.driver.step);
  });

  it("it did not grind up from the beginning", () => {
    expect(stepAfterOneRound).toBeGreaterThan(storedStep);
  });

  it("it is on the table's state", () => {
    const source = t.peers[0]!.driver;
    expect([latecomer.step, latecomer.hash()]).toEqual([source.step, source.hash()]);
  });

  // The moves in flight when it arrived were re-sent to it alone, so they must
  // have applied exactly once. A double application shows up here as a hash
  // that agrees with nobody.
  it("and the table still agrees with itself", () => expect(agreed(t)).toBe(true));
});

describe("a reload rejoins with its own seat intact", () => {
  // The seq counter lives in a Lockstep instance, so a reload starts it again
  // at zero and the returning seat honestly re-spends numbers its peers still
  // remember. Nothing about that is a contradiction, and treating it as one
  // costs an innocent player their seat and desyncs everyone who saw it.
  let t: Table;
  let back: Peer;
  let goneSeq: number;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], snapshotInterval: 24, stallTimeout: 60_000 });
    await run(t, 120, await clickAround(t, 20));

    const gone = t.peers[2]!;
    const seat = gone.seat!;
    goneSeq = gone.driver.nextSeq;
    t.awake.delete(gone.name);
    t.net.disconnect(gone.name);

    const driver = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("e2m0-again"),
      identity: gone.identity,
      seat,
      now: t.clock.now,
      stallTimeout: 60_000,
      snapshotInterval: 24,
    });
    back = {
      name: "e2m0-again",
      driver,
      seat,
      identity: gone.identity,
      chat: [],
      heard: [],
      desyncs: [],
      ejections: [],
      violations: [],
    };
    driver.onDesync = (step, _ours, _theirs, from) => back.desyncs.push({ step, seat: from });
    driver.onEjection = (from, atStep, reason, late) =>
      back.ejections.push({ seat: from, atStep, reason, late });
    driver.onViolation = (_from, what) => back.violations.push(what);
    driver.start();
    t.peers.push(back);
    t.awake.add(back.name);

    await run(t, 24);
  });

  it("it is back on the table's step", () => {
    expect(back.driver.step).toBe(t.peers[0]!.driver.step);
  });

  // The move that used to be the trap: a seq this seat has already spent, for a
  // slot its peers still hold under the old driver's numbering.
  it("and its move numbering restarted", () => {
    expect(back.driver.nextSeq).toBeLessThan(goneSeq);
  });

  it("nobody was accused of anything", async () => {
    const claim = pickClaim(back.driver.sim, back.seat!.empire, back.seat!.member);
    expect(claim).not.toBeNull();
    await back.driver.submit(MOVE.CLAIM, claim!.x, claim!.y);
    await run(t, 24, await clickAround(t, 8));

    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });

  it("and the table still agrees with itself", () => {
    expect(agreed(t, [...t.awake])).toBe(true);
  });
});

// The first request is the one most likely to go out to nobody: a mesh takes a
// moment to form, and two peers that joined at the same instant can be playing
// before their channel to each other opens. Giving up and replaying from step
// zero would derive a state that agrees with nobody, because the moves that
// built the real one were broadcast before this peer was listening.
describe("a resume request that goes unanswered", () => {
  let t: Table;
  let latecomer: Lockstep;
  /** Snapshots to this peer are lost until the clock passes this. */
  let deafUntil = 0;
  let stepWhileDeaf = 0;

  const spin = async (rounds: number): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      t.clock.advance(MS_PER_STEP);
      await settleNetwork(t, () => latecomer.pump());
    }
    await settleNetwork(t, () => latecomer.pump());
  };

  beforeAll(async () => {
    t = await table({
      seats: [2, 1],
      snapshotInterval: 24,
      loopback: {
        drop: (_from, to, frame) =>
          to === "deaf" && frame.t === "snapshot" && t.clock.ms < deafUntil,
      },
    });
    await run(t, 120, await clickAround(t, 30));
    // Past one whole SNAPSHOT_WAIT_MS window, so the first request and the
    // first retry both go unanswered.
    deafUntil = t.clock.ms + 12_000;

    latecomer = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("deaf"),
      now: t.clock.now,
      snapshotInterval: 24,
    });
    latecomer.start();

    await spin(130); // ~10.8 s: two requests made, both lost
    stepWhileDeaf = latecomer.step;
    await spin(170); // the next try lands
  });

  it("it did not start replaying the game from the beginning", () => {
    expect(stepWhileDeaf).toBe(0);
  });

  it("and it catches up as soon as an answer gets through", () => {
    const source = t.peers[0]!.driver;
    expect([latecomer.step, latecomer.hash()]).toEqual([source.step, source.hash()]);
  });
});
