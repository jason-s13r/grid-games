// Seating a substitute mid-game.
//
// A marathon game outlives its roster: people leave, people are invited in, and
// none of that can be one person's decision — teammates share territory, so
// letting a single key walk somebody onto the team is letting it hand the team
// away. A quorum of the empire's existing seats has to sign the same record.
//
// The hard part is not the signatures. It is that the new seat is *hashed
// state*: every peer has to append it on exactly the same step, or two peers
// that agree about every move still disagree about the world.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER, MOVE, Sim } from "@tessera/sim";
import { Identity, Roster } from "@tessera/protocol";
import type { Amendment } from "@tessera/protocol";
import { Lockstep } from "../index.js";
import { agreed, pickClaim, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** Steps to let a proposal cross the table and land. AMENDMENT_DELAY is three
 *  seconds of game time; this is comfortably past it. */
const ROUND = 48;

describe("a quorum seats a newcomer", () => {
  let t: Table;
  let substitute: Identity;
  const seatedOn: number[] = [];

  beforeAll(async () => {
    // Two people on empire 1, so quorum(1) is 2 and one signature is genuinely
    // not enough. A second empire keeps it a game.
    t = await table({ seats: [2, 1] });
    substitute = await Identity.generate();
    for (const peer of t.peers) {
      peer.driver.onSeated = (seat) => seatedOn.push(seat.member);
    }
    await run(t, 12);
  });

  it("the proposal reaches the empire's other seat", async () => {
    await t.peers[0]!.driver.amend(substitute.key);
    await settleNetwork(t);
    expect(t.peers[1]!.driver.invitation(1, substitute.key)).toBeDefined();
  });

  // Every peer holds and gossips the record — the seat it adds is hashed state,
  // so an opponent has to know the outcome too. What an opponent cannot do is
  // vote on it.
  it("an opposing empire holds the record but cannot sign it", async () => {
    const opponent = t.peers[2]!.driver;
    const before = opponent.invitation(1, substitute.key)!.signatures.length;
    await opponent.endorse(1, substitute.key);
    expect(opponent.invitation(1, substitute.key)!.signatures).toHaveLength(before);
  });

  it("and nobody is seated on one signature", async () => {
    await run(t, ROUND);
    expect(t.peers[0]!.driver.roster.has(substitute.key)).toBe(false);
  });

  // The first proposal is spent by now, so this is a fresh one that both seats
  // sign — which is what the invitation flow does in the app.
  it("a second signature carries it", async () => {
    await t.peers[0]!.driver.amend(substitute.key);
    await settleNetwork(t);
    await t.peers[1]!.driver.endorse(1, substitute.key);
    await run(t, ROUND);
    expect(t.peers[0]!.driver.roster.has(substitute.key)).toBe(true);
  });

  it("every peer seated it, including the empire it is not on", () => {
    expect(t.peers.map((peer) => peer.driver.roster.has(substitute.key))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("at the same index everywhere", () => {
    const seats = t.peers.map((peer) => peer.driver.roster.seatOf(substitute.key)!.member);
    expect(seats).toEqual([2, 2, 2]);
  });

  it("and on the same step, so the state still agrees", () => {
    expect(agreed(t)).toBe(true);
  });

  it("the simulation grew a member to match the roster", () => {
    const sim = t.peers[0]!.driver.sim;
    expect(sim.state.empires[0]!.members).toHaveLength(3);
    expect(t.peers[0]!.driver.roster.membersOf(1)).toHaveLength(3);
  });

  it("everyone was told about it", () => {
    expect(seatedOn).toEqual([2, 2, 2]);
  });

  // Three seats, so a majority is still two — the newcomer joins the vote
  // rather than making the next invitation harder to pass.
  it("and the newcomer counts towards the next quorum", () => {
    expect(t.peers[0]!.driver.roster.quorum(1)).toBe(2);
    expect(t.peers[0]!.driver.roster.membersOf(1).map((seat) => seat.member)).toEqual([0, 1, 2]);
  });
});

describe("the substitute themself", () => {
  let t: Table;
  let substitute: Identity;
  let joining: Lockstep;

  beforeAll(async () => {
    t = await table({ seats: [1, 1] }); // solo empire: its own quorum
    substitute = await Identity.generate();

    // Watching the game with a key and no seat — which is all an observer is.
    joining = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("substitute"),
      identity: substitute,
      now: t.clock.now,
    });
    joining.start();
    await run(t, 12);
    await settleNetwork(t, () => joining.pump());
  });

  it("holds no seat to begin with", () => expect(joining.seat).toBeUndefined());

  it("a one-seat empire is its own quorum", async () => {
    await t.peers[0]!.driver.amend(substitute.key);
    for (let i = 0; i < ROUND; i++) {
      t.clock.advance(1000 / 12);
      await settleNetwork(t, () => joining.pump());
    }
    expect(joining.roster.has(substitute.key)).toBe(true);
  });

  it("takes the seat it was given, without being told", () => {
    expect(joining.seat).toEqual({ empire: 1, member: 1 });
  });

  it("and can then act on it", async () => {
    const move = pickClaim(joining.sim, 1, 1);
    expect(move).not.toBeNull();
    expect(await joining.submit(MOVE.CLAIM, move!.x, move!.y)).toBe(true);
    for (let i = 0; i < 24; i++) {
      t.clock.advance(1000 / 12);
      await settleNetwork(t, () => joining.pump());
    }
    expect(joining.hash()).toBe(t.peers[0]!.driver.hash());
    expect(joining.step).toBe(t.peers[0]!.driver.step);
  });
});

describe("an amendment nobody asked for", () => {
  let t: Table;

  beforeAll(async () => {
    t = await table({ seats: [2, 1] });
    await run(t, 12);
  });

  it("a forged record is not stored", async () => {
    const stranger = await Identity.generate();
    const amendment: Amendment = {
      empire: 1,
      step: t.peers[0]!.driver.step + 36,
      key: stranger.key,
      kind: MEMBER.HUMAN,
    };
    // A signature from nobody at all, which is what anyone who can open a data
    // channel is able to produce.
    t.net.connect("stranger").broadcast({
      t: "amendment",
      signed: { amendment, signatures: [{ member: 0, sig: "forged" }] },
    } as never);
    await run(t, 24);
    expect(t.peers[0]!.driver.invitation(1, stranger.key)).toBeUndefined();
  });

  it("and it did not hold the game open", async () => {
    const before = t.peers[0]!.driver.step;
    await run(t, 24);
    expect(t.peers[0]!.driver.step).toBeGreaterThan(before);
    expect(agreed(t)).toBe(true);
  });
});

describe("a proposal nobody answers", () => {
  let t: Table;

  beforeAll(async () => {
    t = await table({ seats: [2, 1] });
    await run(t, 12);
  });

  it("holds the step it named while the vote is out", async () => {
    const substitute = await Identity.generate();
    await t.peers[0]!.driver.amend(substitute.key);
    await settleNetwork(t);
    const named = t.peers[0]!.driver.invitation(1, substitute.key)!.amendment.step;
    await run(t, 60);
    // The teammate never signed, so the game must have moved on rather than
    // stopped: an invitation nobody answers cannot be a way to freeze a game.
    expect(t.peers[0]!.driver.step).toBeGreaterThan(named);
    expect(t.peers[0]!.driver.roster.has(substitute.key)).toBe(false);
  });

  it("and every peer still agrees", () => expect(agreed(t)).toBe(true));
});

// A snapshot carries the simulation, and the simulation knows members by index
// and nothing about keys. A peer that resumed across an amendment would hold a
// state with a seat in it and no idea whose key sits there — and would then
// reject every move that player made.
describe("a peer that resumes across an amendment", () => {
  let t: Table;
  let substitute: Identity;
  let latecomer: Lockstep;

  beforeAll(async () => {
    t = await table({ seats: [1, 1], snapshotInterval: 24 });
    substitute = await Identity.generate();
    await run(t, 12);
    await t.peers[0]!.driver.amend(substitute.key); // solo empire: its own quorum
    await run(t, ROUND);

    latecomer = new Lockstep({
      genesis: t.genesis,
      sim: new Sim(t.genesis),
      roster: Roster.fromGenesis(t.genesis),
      transport: t.net.connect("latecomer"),
      now: t.clock.now,
    });
    latecomer.start();
    for (let i = 0; i < 60; i++) {
      t.clock.advance(1000 / 12);
      await settleNetwork(t, () => latecomer.pump());
    }
  });

  it("the table seated the substitute", () => {
    expect(t.peers[0]!.driver.roster.has(substitute.key)).toBe(true);
  });

  it("the latecomer resumed to the table's state", () => {
    const source = t.peers[0]!.driver;
    expect([latecomer.step, latecomer.hash()]).toEqual([source.step, source.hash()]);
  });

  it("and knows whose seat the new one is", () => {
    expect(latecomer.roster.seatOf(substitute.key)).toEqual({
      empire: 1,
      member: 1,
      key: substitute.key,
      kind: MEMBER.HUMAN,
      joinedAt: expect.any(Number),
    });
  });

  it("so the simulation and the roster agree on how many seats there are", () => {
    expect(latecomer.roster.membersOf(1)).toHaveLength(
      latecomer.sim.state.empires[0]!.members.length,
    );
  });
});
