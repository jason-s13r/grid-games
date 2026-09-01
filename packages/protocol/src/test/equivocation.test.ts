// Telling different peers different things is the one attack a signature cannot
// prevent. Because the mesh gossips every move it sees, it is detected rather
// than merely suspected — and the proof is self-contained, so a peer verifies
// an accusation without trusting whoever raised it.

import { beforeAll, describe, expect, it } from "vitest";
import { EquivocationWatch, signMove, verifyEquivocation } from "../records.js";
import type { SignedMove } from "../records.js";
import { claim, fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
let watch: EquivocationWatch;
let first: SignedMove;
let same: SignedMove;
let other: SignedMove;

beforeAll(async () => {
  f = await fixture();
  watch = new EquivocationWatch();
  first = await signMove(f.alice, f.gameId, claim(200, 1, 0, 9, 1, 1));
  same = await signMove(f.alice, f.gameId, claim(200, 1, 0, 9, 1, 1));
  other = await signMove(f.alice, f.gameId, claim(200, 1, 0, 9, 2, 2));
});

// The watch accumulates, so these run in order against one instance: that is
// the behaviour under test, not an accident of how it was written.
describe("a watch on one slot", () => {
  it("a first sighting is not a crime", () => {
    expect(watch.record(first)).toBeNull();
  });

  it("re-hearing the same move is not a crime", () => {
    expect(watch.record(same)).toBeNull();
  });

  it("two different moves in one slot are caught", () => {
    expect(watch.record(other)).not.toBeNull();
  });

  // A reload builds a fresh driver, whose seq counter starts again at zero, so
  // a returning seat honestly re-spends numbers its peers still remember. That
  // is a rejoin, not a contradiction, and it must not cost anyone their seat.
  it("a reused seq at a later step is not a crime", async () => {
    const rejoined = await signMove(f.alice, f.gameId, claim(240, 1, 0, 9, 3, 4));
    expect(watch.record(rejoined)).toBeNull();
  });
});

describe("the proof", () => {
  it("stands on its own", async () => {
    const watched = new EquivocationWatch();
    watched.record(first);
    const caught = watched.record(other);
    expect(caught).not.toBeNull();
    await expect(
      verifyEquivocation(f.roster, f.gameId, { a: caught!, b: other }),
    ).resolves.toBe(true);
  });

  it("is refused when built from identical moves", async () => {
    await expect(
      verifyEquivocation(f.roster, f.gameId, { a: first, b: same }),
    ).resolves.toBe(false);
  });

  it("is refused when a reused seq sits at a different step", async () => {
    const rejoined = await signMove(f.alice, f.gameId, claim(240, 1, 0, 9, 3, 4));
    await expect(
      verifyEquivocation(f.roster, f.gameId, { a: other, b: rejoined }),
    ).resolves.toBe(false);
  });

  it("needs two valid signatures", async () => {
    await expect(
      verifyEquivocation(f.roster, f.gameId, { a: first, b: { ...other, sig: first.sig } }),
    ).resolves.toBe(false);
  });
});
