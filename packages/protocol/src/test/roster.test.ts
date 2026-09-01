// Who may act, and how that changes mid-game.
//
// Adding a substitute is a ROSTER_AMEND signed by a quorum of the empire's
// existing members. It travels through the log like any other move, so every
// peer applies it deterministically and nobody has to be asked.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER, Sim } from "@tessera/sim";
import {
  amendmentMove,
  endorseAmendment,
  mergeAmendment,
  signMove,
  tallyAmendment,
  verifyAmendment,
  verifyMove,
} from "../records.js";
import type { Amendment, SignedAmendment } from "../records.js";
import { claim, fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
let amendment: Amendment;

beforeAll(async () => {
  f = await fixture();
  amendment = { empire: 1, step: 500, key: f.mallory.key, kind: MEMBER.HUMAN };
});

describe("the roster as sealed", () => {
  it("a seat resolves to its key", () => expect(f.roster.keyOf(1, 1)).toBe(f.bob.key));
  it("a key resolves to its seat", () => expect(f.roster.seatOf(f.carol.key)?.member).toBe(2));
  it("three seats need two signatures", () => expect(f.roster.quorum(1)).toBe(2));
  it("a SimBot empire has no keyed seats", () => expect(f.roster.membersOf(2)).toHaveLength(0));
});

describe("endorsing an amendment", () => {
  it("one signature is not a quorum", async () => {
    const one: SignedAmendment = {
      amendment,
      signatures: [await endorseAmendment(f.alice, f.gameId, amendment, 0)],
    };
    await expect(verifyAmendment(f.roster, f.gameId, one)).resolves.toBe(false);
  });

  it("one member cannot sign twice for a quorum", async () => {
    const doubled: SignedAmendment = {
      amendment,
      signatures: [
        await endorseAmendment(f.alice, f.gameId, amendment, 0),
        await endorseAmendment(f.alice, f.gameId, amendment, 0),
      ],
    };
    await expect(verifyAmendment(f.roster, f.gameId, doubled)).resolves.toBe(false);
  });

  it("a forged endorsement does not count", async () => {
    const forged: SignedAmendment = {
      amendment,
      signatures: [
        await endorseAmendment(f.alice, f.gameId, amendment, 0),
        // Mallory signing in Bob's seat: the roster looks the key up by seat, so
        // the signature is checked against Bob's key and fails.
        await endorseAmendment(f.mallory, f.gameId, amendment, 1),
      ],
    };
    await expect(verifyAmendment(f.roster, f.gameId, forged)).resolves.toBe(false);
  });
});

// A partial tally is what a peer actually holds most of the time: the driver
// gossips endorsements as they arrive rather than waiting for the whole set.
describe("collecting endorsements", () => {
  let g: Fixture;

  beforeAll(async () => {
    g = await fixture();
  });

  const alone = async (who: "alice" | "bob", at: Fixture) => ({
    amendment,
    signatures: [await endorseAmendment(at[who], at.gameId, amendment, who === "alice" ? 0 : 1)],
  });

  it("merges two partial tallies into a quorum", async () => {
    const merged = mergeAmendment(await alone("alice", g), await alone("bob", g));
    expect(merged.signatures).toHaveLength(2);
    await expect(verifyAmendment(g.roster, g.gameId, merged)).resolves.toBe(true);
  });

  it("counts a seat once however often it signs", async () => {
    const one = await alone("alice", g);
    const merged = mergeAmendment(one, one);
    expect(merged.signatures).toHaveLength(1);
  });

  it("reports how far along a proposal is", async () => {
    await expect(tallyAmendment(g.roster, g.gameId, await alone("alice", g))).resolves.toEqual({
      endorsed: 1,
      needed: 2,
    });
  });

  // One real signature is what tells a peer a proposal is worth holding a step
  // open for. Without that check, anyone at all could stall the game by
  // broadcasting noise.
  it("finds nothing to hold a step open for in an unsigned record", async () => {
    const noise = { amendment, signatures: [{ member: 0, sig: "not-a-signature" }] };
    await expect(tallyAmendment(g.roster, g.gameId, noise)).resolves.toEqual({
      endorsed: 0,
      needed: 2,
    });
  });

  it("reports an empire that does not exist as impossible rather than merely short", async () => {
    const nowhere = { empire: 9, step: 500, key: g.mallory.key, kind: MEMBER.HUMAN };
    const signed = {
      amendment: nowhere,
      signatures: [await endorseAmendment(g.alice, g.gameId, nowhere, 0)],
    };
    await expect(tallyAmendment(g.roster, g.gameId, signed)).resolves.toEqual({
      endorsed: 0,
      needed: 0,
    });
  });
});

// Seating changes the roster, so this runs as one story in order.
describe("seating the newcomer", () => {
  let quorum: SignedAmendment;
  let seated: number;

  beforeAll(async () => {
    quorum = {
      amendment,
      signatures: [
        await endorseAmendment(f.alice, f.gameId, amendment, 0),
        await endorseAmendment(f.bob, f.gameId, amendment, 1),
      ],
    };
  });

  it("a quorum is accepted", async () => {
    await expect(verifyAmendment(f.roster, f.gameId, quorum)).resolves.toBe(true);
  });

  it("the new seat takes the next index", () => {
    seated = f.roster.amend(1, f.mallory.key, MEMBER.HUMAN, 500);
    expect(seated).toBe(3);
  });

  it("an already-seated key cannot be added again", async () => {
    await expect(verifyAmendment(f.roster, f.gameId, quorum)).resolves.toBe(false);
  });

  it("the newcomer can now act", async () => {
    const move = await signMove(f.mallory, f.gameId, claim(501, 1, seated, 0, 4, 4));
    await expect(verifyMove(f.roster, f.gameId, move)).resolves.toBe(true);
  });

  it("four seats need three signatures", () => expect(f.roster.quorum(1)).toBe(3));
});

describe("the amendment reaches the simulation", () => {
  it("seats the new member and keeps its kind", () => {
    const sim = new Sim(f.genesis);
    const before = sim.state.empires[0]!.members.length;
    sim.advance([amendmentMove(amendment, 0, 0)]);
    expect(sim.state.empires[0]!.members).toHaveLength(before + 1);
    expect(sim.state.empires[0]!.members[before]!.kind).toBe(MEMBER.HUMAN);
  });
});
