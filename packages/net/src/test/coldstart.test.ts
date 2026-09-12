// A game everyone left, started again from what somebody kept.
//
// This is the case a witnessed resume point exists for, and it is worth being
// precise about why it is not the latecomer case. A live peer answers a snapshot
// request from *now* — deliberately, because a peer rebuilding from a desync wants
// a correct state rather than an old one — and `now` is almost never a snapshot
// step, so it has no witnesses and never will. Answering from a stored step
// instead would mean shipping the moves between then and now, and `drain()`
// deletes each step's moves as it applies them.
//
// So: witnesses are for the cold start, where there are no moves after the point
// and nobody left to contradict a forgery. For a latecomer to a running game the
// present state plus its re-sent pending moves is both the existing answer and the
// right one.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim } from "@tessera/sim";
import { Identity, Roster } from "@tessera/protocol";
import { Lockstep } from "../lockstep.js";
import { SNAPSHOT_TAIL } from "../snapshots.js";
import { rosterAt } from "../resume.js";
import type { ResumePoint } from "../resume.js";
import { LoopbackNetwork } from "../transport.js";
import { clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a game that stopped, and a peer that picks it up", () => {
  let t: Table;
  let point: ResumePoint;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], observer: true, snapshotInterval: 24 });
    await run(t, 120, await clickAround(t, 24));
    point = t.peers[0]!.driver.resumePoint()!;
  });

  it("offers a point its own seats signed for", () => {
    expect(point, "a played game should produce a resume point").toBeDefined();
    expect(point.step % 24).toBe(0);
    expect(point.witnesses.length).toBeGreaterThanOrEqual(2);
    // Every witness is for exactly this (step, hash). A witness for anything else
    // is evidence about a different state.
    for (const signed of point.witnesses) {
      expect(signed.checkpoint.step).toBe(point.step);
      expect(signed.checkpoint.hash).toBe(point.hash);
    }
  });

  it("does not offer a point the seats never signed for", () => {
    // Every snapshot in the store is at a step that was also a checkpoint step,
    // which is what the constructor assertion guarantees. So the newest point is
    // the newest snapshot, and there is nothing stored that no seat vouched for.
    expect(point.step).toBe(t.peers[0]!.driver.snapshots.latest()!.step);
  });

  it("keeps no more witnesses than it keeps snapshots", () => {
    // Reaching into the map because the claim is about retention and nothing else
    // observes it. A witness without its snapshot vouches for nothing; a snapshot
    // without its witnesses is only a content address.
    const kept = (t.peers[0]!.driver as unknown as { witnesses: Map<number, unknown> }).witnesses;
    expect(kept.size).toBeLessThanOrEqual(SNAPSHOT_TAIL);
  });

  it("is taken by a peer that was never in the game, to the right state", async () => {
    // An observer with no connection to anybody: the cold start, exactly.
    const fresh = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: new LoopbackNetwork().connect("revenant"),
      now: t.clock.now,
      snapshotInterval: 24,
      checkpointInterval: 12,
    });

    const tally = await fresh.resume(point);
    expect(tally.ok, tally.problems.join("; ")).toBe(true);
    expect(tally.endorsed).toBeGreaterThanOrEqual(tally.needed);
    expect(fresh.step).toBe(point.step);
    expect(fresh.hash()).toBe(point.hash);
  });

  it("refuses a bundle whose bytes were swapped for someone else's", async () => {
    // The tally says a majority signed for this (step, hash). It says nothing
    // about the bytes, which is `adopt`'s question — so both halves have to run,
    // and the rollback is what keeps a peer from holding a state it could not
    // confirm.
    const other = await table({ seats: [2, 1], snapshotInterval: 24, seed: 99 });
    await run(other, 48, await clickAround(other, 24));
    const wrongData = other.peers[0]!.driver.resumePoint()!.data;

    const fresh = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: new LoopbackNetwork().connect("credulous"),
      now: t.clock.now,
      snapshotInterval: 24,
      checkpointInterval: 12,
    });
    const before = fresh.hash();

    const tally = await fresh.resume({ ...point, data: wrongData });
    expect(tally.ok).toBe(false);
    expect(tally.problems.join(" ")).toMatch(/not the state they claim/);
    // Rolled back, not half-applied.
    expect(fresh.hash()).toBe(before);
  });

  it("refuses a point that is behind where we already are", async () => {
    const ahead = t.peers[0]!.driver;
    const tally = await ahead.resume({ ...point, step: point.step - 24 });
    expect(tally.ok).toBe(false);
  });
});

describe("the two intervals", () => {
  it("must divide, or no snapshot lands on a step anyone signed for", async () => {
    const t = await table({ seats: [1, 1] });
    expect(
      () =>
        new Lockstep({
          genesis: t.genesis,
          sim: new Sim(t.genesis),
          roster: Roster.fromGenesis(t.genesis),
          transport: new LoopbackNetwork().connect("misconfigured"),
          snapshotInterval: 100,
          checkpointInterval: 60,
        }),
    ).toThrow(/must be a multiple/);
  });
});

describe("rosterAt and the driver's own walk", () => {
  it("agree about who is seated after an amendment", async () => {
    // Two implementations of one walk, kept honest by a test rather than merged:
    // `catchUpRoster` also does driver work — adopting our own seat, firing
    // onSeated, recording what it applied — so it cannot be called from a pure
    // verifier, and refactoring the one piece of code that decides who may act is
    // a worse trade than this assertion.
    const t = await table({ seats: [2, 1], snapshotInterval: 24 });
    const substitute = await Identity.generate();
    await run(t, 24, await clickAround(t, 12));
    // A proposal is not a seat: empire 1 holds two seats, so its quorum is two
    // and the teammate has to endorse before anybody is seated.
    await t.peers[0]!.driver.amend(substitute.key);
    await run(t, 12);
    await t.peers[1]!.driver.endorse(1, substitute.key);
    await run(t, 48, await clickAround(t, 12));

    const driven = t.peers[0]!.driver;
    expect(driven.roster.has(substitute.key), "the amendment should have carried").toBe(true);

    const point = driven.resumePoint()!;
    const walked = await rosterAt(t.genesis, point.amendments);
    expect(walked.all().map((seat) => `${seat.empire}:${seat.member}:${seat.key}`)).toEqual(
      driven.roster.all().map((seat) => `${seat.empire}:${seat.member}:${seat.key}`),
    );
  });
});
