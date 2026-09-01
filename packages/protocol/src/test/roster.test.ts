// Who may act, and how that changes mid-game.
//
// Adding a substitute is a ROSTER_AMEND signed by a quorum of the empire's
// existing members. It travels through the log like any other move, so every
// peer applies it deterministically and nobody has to be asked.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER, Sim } from "@tessera/sim";
import { amendmentMove, endorseAmendment, signMove, verifyAmendment, verifyMove } from "../records.js";
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
