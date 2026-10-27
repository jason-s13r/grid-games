// Who may act, and how that changes mid-game.
//
// A signed move names a seat, and the roster says which key sits there. Adding
// a member appends a seat; from then on that key's moves verify.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER } from "@tessera/sim";
import { signMove, verifyMove } from "../records.js";
import { claim, fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;

beforeAll(async () => {
  f = await fixture();
});

describe("the roster as sealed", () => {
  it("a seat resolves to its key", () => expect(f.roster.keyOf(1, 1)).toBe(f.bob.key));
  it("a key resolves to its seat", () => expect(f.roster.seatOf(f.carol.key)?.member).toBe(2));
  it("a SimBot empire has no keyed seats", () => expect(f.roster.membersOf(2)).toHaveLength(0));
});

describe("seating a newcomer", () => {
  it("cannot act before it is seated", async () => {
    const move = await signMove(f.mallory, f.gameId, claim(501, 1, 3, 0, 4, 4));
    await expect(verifyMove(f.roster, f.gameId, move)).resolves.toBe(false);
  });

  it("takes the next index and can then act", async () => {
    const seated = f.roster.amend(1, f.mallory.key, MEMBER.HUMAN, 500);
    expect(seated).toBe(3);
    const move = await signMove(f.mallory, f.gameId, claim(501, 1, seated, 0, 4, 4));
    await expect(verifyMove(f.roster, f.gameId, move)).resolves.toBe(true);
  });
});
