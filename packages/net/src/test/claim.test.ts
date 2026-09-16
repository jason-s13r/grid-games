// Two strangers arriving at the same empty empire.
//
// This is the test the plan was written around, because the body's tidiest
// paragraph was the wrong one. "The lower key seats; the second claim then fails
// `validate` because the empire is no longer vacant" — it does not, and the
// reason is the reason a claim record has to exist at all.
//
// **A claim and an amendment produce the same move.** `amendmentMove` builds
// `{ type: ROSTER_AMEND, x: kind }` and the only thing the simulation reads out
// of it is the new member's kind, because the sim addresses members by index and
// knows nothing about keys. That is the property the whole design rests on — and
// it means the sim's ROSTER_AMEND branch, asked about a second claim, sees an
// empire with one member and a seat cap of four and answers **true**. The second
// claimant would seat as member 1 of the empire the first claimant took thirty
// milliseconds ago: sharing their territory and their capital, no quorum, nobody
// asked. Not a lost race. The exact failure `amend` spends forty lines of
// comment preventing.
//
// So the guard lives where authorisation already lives — in the driver, against
// the roster as it stands at that point in the seating loop, over a list every
// peer sorted the same way. Deterministic for the same reason the sort is, and
// needing no new tie-break.
//
// What this file asserts is that every peer reaches the same answer about *who*
// arrived, and that the worlds stay bit-identical afterwards. A divergence here
// would not be a wrong winner; it would be two rosters, two member indices, and
// every later move by that seat unattributable.

import { describe, expect, it } from "vitest";
import { MEMBER, isVacant } from "@tessera/sim";
import { FRAME, signClaim, verifyClaim } from "@tessera/protocol";
import type { SignedAmendment, SignedClaim } from "@tessera/protocol";
import { verifyArchive } from "../index.js";
import { Archive } from "../archive.js";
import { mergeSeatings, seatingOrder } from "../seating.js";
import { agreed, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** Two seated humans, one unclaimed empire, and however many strangers holding
 *  keys. The vacancy is empire 3: two human empires, then the vacancies, then
 *  the SimBot. */
const VACANT = 3;

const seated = (t: Table, name: string) => t.peers.find((peer) => peer.name === name)!;

/** Put a record on the wire from somebody who is not at the table.
 *
 *  The point of most of these cases is what a peer does with a claim it did not
 *  compose — the sender's own guards are not the ones under test, and a stranger
 *  with a socket is exactly who a hostile record arrives from. */
async function deliver(t: Table, signed: SignedClaim): Promise<void> {
  t.net.connect("stranger").broadcast({ t: FRAME.CLAIM, signed });
  await settleNetwork(t);
}

/** How many peers ended up with a seat in the vacancy. */
const booked = (t: Table): number =>
  t.peers.filter((peer) => peer.driver.roster.size(VACANT) > 0).length;

describe("one stranger claims an empty empire", () => {
  it("seats them on every peer, at member 0, with the same hash everywhere", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const claimant = seated(t, "c1");
    expect(isVacant(claimant.driver.sim.state.empires[VACANT - 1]!)).toBe(true);

    expect(await claimant.driver.claim(VACANT)).toBe(true);
    await settleNetwork(t);
    // Past the step the claim named: `AMENDMENT_DELAY` is three seconds of game
    // time, so every peer has heard it before anybody simulates it.
    await run(t, 60);

    for (const peer of t.peers) {
      const empire = peer.driver.sim.state.empires[VACANT - 1]!;
      expect(isVacant(empire)).toBe(false);
      expect(empire.members).toHaveLength(1);
      expect(peer.driver.roster.keyOf(VACANT, 0)).toBe(claimant.identity!.key);
    }

    // Step and hash together: a hash comparison across peers standing on
    // different steps is comparing two different worlds and would pass or fail
    // for reasons that have nothing to do with the claim.
    expect(agreed(t)).toBe(true);
  });

  it("gives the claimant the seat to play, without being told twice", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const claimant = seated(t, "c1");
    await claimant.driver.claim(VACANT);
    await settleNetwork(t);
    await run(t, 60);
    expect(claimant.driver.seat).toEqual({ empire: VACANT, member: 0 });
  });

  it("refuses to claim an empire somebody is already playing", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    expect(await seated(t, "c1").driver.claim(1)).toBe(false);
  });

  it("refuses to claim at all from a peer that already holds a seat", async () => {
    // A seat is not a thing you accumulate. An empire wanting more hands votes
    // them in; a player wanting a second empire is one player playing two.
    const t = await table({ seats: [1, 1], vacancies: 1 });
    expect(await seated(t, "e1m0").driver.claim(VACANT)).toBe(false);
  });
});

describe("two strangers claim the same empire on the same step", () => {
  it("seats exactly one of them, and the same one on every peer", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 2 });
    const one = seated(t, "c1");
    const two = seated(t, "c2");

    // Both fired before either is delivered, which is what puts them on the
    // same step: each computes `sim.step + AMENDMENT_DELAY` from the same clock.
    await Promise.all([one.driver.claim(VACANT), two.driver.claim(VACANT)]);
    await settleNetwork(t);
    await run(t, 60);

    const winners = new Set(t.peers.map((peer) => peer.driver.roster.keyOf(VACANT, 0)));
    expect(winners.size).toBe(1);
    const winner = [...winners][0]!;
    expect([one.identity!.key, two.identity!.key]).toContain(winner);

    // And the loser is not seated *anywhere* — not as member 1 of the empire
    // the winner took, which is what the sim on its own would have allowed.
    for (const peer of t.peers) {
      expect(peer.driver.sim.state.empires[VACANT - 1]!.members).toHaveLength(1);
    }
  });

  it("leaves every world bit-identical", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 2 });
    await Promise.all([
      seated(t, "c1").driver.claim(VACANT),
      seated(t, "c2").driver.claim(VACANT),
    ]);
    await settleNetwork(t);
    await run(t, 120);
    expect(agreed(t)).toBe(true);
  });

  it("resolves by key order, which is the order every peer sorted", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 2 });
    const one = seated(t, "c1");
    const two = seated(t, "c2");
    await Promise.all([one.driver.claim(VACANT), two.driver.claim(VACANT)]);
    await settleNetwork(t);
    await run(t, 60);

    const lower = one.identity!.key < two.identity!.key ? one : two;
    expect(one.driver.roster.keyOf(VACANT, 0)).toBe(lower.identity!.key);
  });
});

describe("a claim is a record, checked like any other", () => {
  it("is signed by the key it seats, and nothing else verifies it", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const claimant = seated(t, "c1");
    const signed = await signClaim(claimant.identity!, t.gameId, { empire: VACANT, step: 100 });

    expect(await verifyClaim(t.gameId, signed)).toBe(true);
    // Somebody else's key on the same signature: the record names whose seat it
    // creates, so changing the name invalidates it.
    expect(
      await verifyClaim(t.gameId, {
        ...signed,
        claim: { ...signed.claim, key: seated(t, "e1m0").identity!.key },
      }),
    ).toBe(false);
    // A different empire under the same signature is a different record.
    expect(
      await verifyClaim(t.gameId, { ...signed, claim: { ...signed.claim, empire: 1 } }),
    ).toBe(false);
  });

  it("cannot be replayed into another game", async () => {
    const a = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const b = await table({ seats: [1, 1], vacancies: 1, claimants: 1, seed: 77 });
    const signed = await signClaim(a.peers.at(-2)!.identity!, a.gameId, {
      empire: VACANT,
      step: 100,
    });
    expect(await verifyClaim(b.gameId, signed)).toBe(false);
  });
});

describe("a claim nobody should act on", () => {
  it("is refused when it names a step already spent", async () => {
    // A roster append cannot be applied to a world that has moved on, and a
    // claim naming the past is either a stale record or somebody hoping a peer
    // will book it anyway.
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    await run(t, 40);
    const claimant = seated(t, "c1");
    const signed = await signClaim(claimant.identity!, t.gameId, { empire: VACANT, step: 1 });
    await deliver(t, signed);
    expect(booked(t)).toBe(0);
  });

  it("is refused when it names a step too far ahead to be honest", async () => {
    // A claim arrives from a stranger and names its own step, unlike an
    // amendment which computes one. A record naming step 40,000,000 would sit
    // in `seating` forever, holding readiness below it for the whole game.
    // Refused rather than clamped: a clamped step is a different record from the
    // one that was signed, and nothing would verify it.
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const claimant = seated(t, "c1");
    const signed = await signClaim(claimant.identity!, t.gameId, {
      empire: VACANT,
      step: 40_000_000,
    });
    await deliver(t, signed);
    expect(booked(t)).toBe(0);
  });

  it("is stored nowhere and gossiped to nobody when the signature is wrong", async () => {
    // Right shape, wrong signer. It must not be booked, and it must not be
    // rebroadcast: a peer that forwards what it could not verify is a peer
    // amplifying somebody else's forgery.
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 2 });
    const one = seated(t, "c1");
    const two = seated(t, "c2");
    const signed = await signClaim(one.identity!, t.gameId, { empire: VACANT, step: 40 });
    await deliver(t, { ...signed, claim: { ...signed.claim, key: two.identity!.key } });
    await run(t, 80);
    expect(booked(t)).toBe(0);
    for (const peer of t.peers) {
      expect(peer.driver.sim.state.empires[VACANT - 1]!.members).toHaveLength(0);
    }
  });
});

describe("the archive of a claimed game", () => {
  it("replays to the hash the table reached", async () => {
    // The assertion the whole `seatingOrder` argument exists for, and the only
    // one that can fail if the driver and the verifier drift: a different member
    // index is a `keyOf` miss on every later move that seat signed, and it
    // surfaces here as a hash mismatch that describes nothing.
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1, observer: true });
    const watcher = t.peers.at(-1)!;
    const archive = new Archive(t.genesis, watcher.driver);
    const detach = archive.attach(watcher.driver);

    await seated(t, "c1").driver.claim(VACANT);
    await settleNetwork(t);
    await run(t, 120);
    detach();

    const game = archive.toJSON();
    expect(game.claims).toHaveLength(1);
    const verdict = await verifyArchive(game);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("refuses a claim somebody added after the empire was taken", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1, observer: true });
    const watcher = t.peers.at(-1)!;
    const archive = new Archive(t.genesis, watcher.driver);
    const detach = archive.attach(watcher.driver);
    await seated(t, "c1").driver.claim(VACANT);
    await settleNetwork(t);
    await run(t, 120);
    detach();

    const game = archive.toJSON();
    const forged = await signClaim(seated(t, "e1m0").identity!, t.gameId, {
      empire: VACANT,
      step: game.claims![0]!.claim.step + 1,
    });
    const verdict = await verifyArchive({ ...game, claims: [...game.claims!, forged] });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/after it was taken/);
  });
});

describe("the order seats appear in", () => {
  it("is step first, then key", () => {
    const at = (step: number, key: string) => ({ claim: { empire: 1, key, step }, sig: "" });
    const sorted = [at(9, "a"), at(2, "z"), at(2, "b")].sort(seatingOrder);
    expect(sorted.map((one) => `${one.claim.step}${one.claim.key}`)).toEqual(["2b", "2z", "9a"]);
  });

  it("interleaves the two kinds rather than putting one array after the other", () => {
    // The divergence this prevents: two arrays each walked in their own order
    // assign different member indices the moment a claim and an amendment land
    // on the same step.
    const claim: SignedClaim = { claim: { empire: 1, key: "b", step: 5 }, sig: "" };
    const amendment: SignedAmendment = {
      amendment: { empire: 1, key: "a", step: 5, kind: MEMBER.HUMAN },
      signatures: [],
    };
    const merged = mergeSeatings([amendment], [claim]);
    expect(merged[0]).toBe(amendment);
    expect(merged[1]).toBe(claim);
  });
});

describe("the house a claimant brings", () => {
  // The half of banners worth having. A vacancy is not pre-branded, so a player
  // who always plays as one house brings it to whichever empty empire they
  // take — rather than hoping the composer happened to seal it.
  it("rides the claim, and every peer derives the same table", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const empire = 3;
    const claimant = t.peers.find((peer) => peer.name.startsWith("c"))!;

    expect(await claimant.driver.claim(empire, "rose")).toBe(true);
    await settleNetwork(t);
    await run(t, 40);

    for (const peer of t.peers) {
      const flown = peer.driver.claimedBanners();
      expect(flown, peer.name).toContainEqual({ empire, banner: "rose" });
    }
    expect(agreed(t)).toBe(true);
  });

  // A banner is presentation, so a squatter must not be able to deny a seat
  // over one. The later claim is refused as a *branding* and accepted as a
  // *seating*.
  it("a claim with a banner somebody already flies still seats the claimant", async () => {
    const t = await table({ seats: [1, 1], vacancies: 2, claimants: 2 });
    const [first, second] = t.peers.filter((peer) => peer.name.startsWith("c"));

    expect(await first!.driver.claim(3, "rose")).toBe(true);
    await settleNetwork(t);
    expect(await second!.driver.claim(4, "rose")).toBe(true);
    await settleNetwork(t);
    await run(t, 60);

    // Both are seated. That is the part that must not depend on a colour.
    expect(first!.driver.seat?.empire).toBe(3);
    expect(second!.driver.seat?.empire).toBe(4);
    expect(agreed(t)).toBe(true);
  });

  // Nothing downstream of `validate()` has ever seen a banner, so a peer that
  // missed the frame draws one empire under its index and agrees about
  // everything else. Degraded, never divergent.
  it("cannot move the hash", async () => {
    const plain = await table({ seats: [1, 1], vacancies: 1, claimants: 1, seed: 909 });
    const claimant = plain.peers.find((peer) => peer.name.startsWith("c"))!;
    await claimant.driver.claim(3);
    await settleNetwork(plain);
    await run(plain, 60);

    const flown = await table({ seats: [1, 1], vacancies: 1, claimants: 1, seed: 909 });
    const other = flown.peers.find((peer) => peer.name.startsWith("c"))!;
    await other.driver.claim(3, "rose");
    await settleNetwork(flown);
    await run(flown, 60);

    expect(flown.peers[0]!.driver.sim.hash()).toBe(plain.peers[0]!.driver.sim.hash());
  });

  it("a forged banner does not survive, because the banner is signed", async () => {
    const t = await table({ seats: [1, 1], vacancies: 1, claimants: 1 });
    const claimant = t.peers.find((peer) => peer.name.startsWith("c"))!;
    await claimant.driver.claim(3, "rose");
    await settleNetwork(t);

    // A relay rewriting the field breaks the signature, which is why it is in
    // the signed bytes even though it is never hashed into state.
    const signed = await signClaim(claimant.identity!, t.gameId, { empire: 3, step: 10, banner: "rose" });
    const tampered = { ...signed, claim: { ...signed.claim, banner: "cobalt" } };
    expect(await verifyClaim(t.gameId, tampered)).toBe(false);
    expect(await verifyClaim(t.gameId, signed)).toBe(true);
  });
});
