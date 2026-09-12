// A state a stranger can check, and the three shapes that make it worth having.
//
// The verifier is tested against hand-built bundles rather than through a game,
// because what it has to get right is the arithmetic of an electorate: who may
// sign, who no longer may, and how many of them are enough. A game produces one
// such shape at a time and the awkward ones — two seats, or four with two dropped
// — are exactly the ones a four-seat harness run never reaches.
//
// The premise, stated once: `adopt()` checks that bytes hash to the number they
// claim, the hash is 32-bit FNV-1a, and multiplication by the prime is invertible
// mod 2^32 — so bytes with a chosen hash are arithmetic, not a search. In a live
// mesh that costs one checkpoint interval, because everyone's signed checkpoints
// contradict a forgery and the peer that took it rebuilds. It costs the whole game
// when nobody is left to contradict it, and that is the case these bundles are
// for.

import { describe, expect, it } from "vitest";
import { CONTROL, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Identity, Roster, encodeDrop, sealGenesis, signCheckpoint } from "@tessera/protocol";
import type { SignedCheckpoint, SignedDrop } from "@tessera/protocol";
import { rosterAt, verifyResumePoint } from "../resume.js";
import type { ResumePoint } from "../resume.js";

interface Game {
  genesis: Genesis;
  seats: Array<{ identity: Identity; empire: number; member: number }>;
}

/** A sealed game with `shape` human seats per empire, and nothing simulated: the
 *  verifier never looks at the bytes, so a state is not needed to test it. */
async function game(shape: number[]): Promise<Game> {
  const seats: Game["seats"] = [];
  const empires = [];
  for (const [index, count] of shape.entries()) {
    const members = [];
    for (let member = 0; member < count; member++) {
      const identity = await Identity.generate();
      seats.push({ identity, empire: index + 1, member });
      members.push({ kind: MEMBER.HUMAN, key: identity.key });
    }
    empires.push({ control: CONTROL.HUMAN, members });
  }
  const genesis = await sealGenesis(
    makeGenesis({ seed: 7, startedAt: 0, map: { width: 24, height: 24 }, empires }),
  );
  return { genesis, seats };
}

const STEP = 24;
const HASH = 0xbfe534e8;

/** One seat's signature over (step, hash), which is the whole of a witness. */
async function signCheckpointFor(
  g: Game,
  seat: Game["seats"][number],
  hash = HASH,
  step = STEP,
): Promise<SignedCheckpoint> {
  return signCheckpoint(seat.identity, g.genesis.gameId!, {
    step,
    hash,
    empire: seat.empire,
    member: seat.member,
  });
}

const point = (over: Partial<ResumePoint> = {}): ResumePoint => ({
  step: STEP,
  hash: HASH,
  data: "AAAA",
  amendments: [],
  drops: [],
  witnesses: [],
  ...over,
});

/** A drop signed by a real majority of the seats that may endorse it. */
async function drop(g: Game, target: Game["seats"][number], atStep = 12): Promise<SignedDrop> {
  const record = { empire: target.empire, member: target.member, atStep };
  const payload = encodeDrop(g.genesis.gameId!, record);
  const endorsers = g.seats.filter((seat) => seat !== target);
  const signatures = [];
  for (const seat of endorsers) {
    signatures.push({
      empire: seat.empire,
      member: seat.member,
      sig: await seat.identity.sign(payload),
    });
  }
  return { drop: record, signatures };
}

describe("verifyResumePoint", () => {
  it("accepts a point a majority of seats signed for", async () => {
    const g = await game([2, 2]);
    const witnesses = [];
    for (const seat of g.seats.slice(0, 3)) witnesses.push(await signCheckpointFor(g, seat));

    const tally = await verifyResumePoint(g.genesis, point({ witnesses }));
    expect(tally).toMatchObject({ ok: true, endorsed: 3, needed: 3 });
  });

  it("refuses a point with no witnesses, and says 0 of 4 rather than false", async () => {
    // The fabricated-state attack. The bytes can be made to hash to anything, so
    // a bundle whose only credential is its own hash is a bundle with no
    // credential — and a bare `false` is the wrong way to say that, because a
    // client has to be able to tell "nobody vouched for this" from "two of four
    // did".
    const g = await game([2, 2]);
    const tally = await verifyResumePoint(g.genesis, point());
    expect(tally).toMatchObject({ ok: false, endorsed: 0, needed: 3 });
    expect(tally.problems.join(" ")).toMatch(/endorsed by 0 of 4/);
  });

  it("refuses a quorum short by one", async () => {
    const g = await game([2, 2]);
    const witnesses = [];
    for (const seat of g.seats.slice(0, 2)) witnesses.push(await signCheckpointFor(g, seat));

    const tally = await verifyResumePoint(g.genesis, point({ witnesses }));
    expect(tally).toMatchObject({ ok: false, endorsed: 2, needed: 3 });
  });

  it("ignores a witness from a key that is not in this game", async () => {
    const g = await game([2, 2]);
    const stranger = await game([1]);
    const witnesses = [
      await signCheckpointFor(g, g.seats[0]!),
      await signCheckpointFor(g, g.seats[1]!),
      // Signed correctly, by somebody with no seat here. An observer can never be
      // a witness, and this is the same fact from the other side.
      await signCheckpointFor(stranger, stranger.seats[0]!),
    ];
    const tally = await verifyResumePoint(g.genesis, point({ witnesses }));
    expect(tally.endorsed).toBe(2);
    expect(tally.ok).toBe(false);
  });

  it("does not count a witness for a different hash at the same step", async () => {
    // Not necessarily a forgery: a peer that was desynced at this step signed
    // honestly and was wrong. It vouches for somebody else's state.
    const g = await game([2, 2]);
    const witnesses = [
      await signCheckpointFor(g, g.seats[0]!),
      await signCheckpointFor(g, g.seats[1]!),
      await signCheckpointFor(g, g.seats[2]!, 0xdeadbeef),
    ];
    const tally = await verifyResumePoint(g.genesis, point({ witnesses }));
    expect(tally).toMatchObject({ ok: false, endorsed: 2 });
  });

  it("does not count a witness for a different step", async () => {
    const g = await game([2, 2]);
    const witnesses = [
      await signCheckpointFor(g, g.seats[0]!),
      await signCheckpointFor(g, g.seats[1]!),
      await signCheckpointFor(g, g.seats[2]!, HASH, STEP - 12),
    ];
    expect((await verifyResumePoint(g.genesis, point({ witnesses }))).endorsed).toBe(2);
  });

  it("counts one seat once, however many times it signs", async () => {
    const g = await game([2, 2]);
    const twice = await signCheckpointFor(g, g.seats[0]!);
    const tally = await verifyResumePoint(g.genesis, point({ witnesses: [twice, twice, twice] }));
    expect(tally).toMatchObject({ ok: false, endorsed: 1, needed: 3 });
  });

  it("refuses a witness whose signature does not verify, and names the seat", async () => {
    const g = await game([2, 2]);
    const forged = await signCheckpointFor(g, g.seats[0]!);
    const tampered: SignedCheckpoint = {
      checkpoint: forged.checkpoint,
      sig: forged.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")),
    };
    const tally = await verifyResumePoint(g.genesis, point({ witnesses: [tampered] }));
    expect(tally.problems.join(" ")).toMatch(/a witness from 1:0 does not verify/);
  });

  describe("a game of two", () => {
    it("can produce a resume point at all", async () => {
      // The regression for a gap that would have shipped looking fine: the
      // harness plays four-seat games, where a peer can reach a majority out of
      // other peers' checkpoints alone. With two seats the electorate is 2, a
      // majority is 2, and a peer that does not keep its own envelope can hold at
      // most 1 — so every two-player game would have been unresumable, silently.
      const g = await game([1, 1]);
      const witnesses = [
        await signCheckpointFor(g, g.seats[0]!),
        await signCheckpointFor(g, g.seats[1]!),
      ];
      expect(await verifyResumePoint(g.genesis, point({ witnesses }))).toMatchObject({
        ok: true,
        endorsed: 2,
        needed: 2,
      });
    });

    it("is not resumable on one seat's word", async () => {
      const g = await game([1, 1]);
      const witnesses = [await signCheckpointFor(g, g.seats[0]!)];
      expect(await verifyResumePoint(g.genesis, point({ witnesses }))).toMatchObject({
        ok: false,
        endorsed: 1,
        needed: 2,
      });
    });
  });

  describe("a solo game", () => {
    it("is self-attested, which is true and is not the same as verified", async () => {
      // One keyed seat against SimBots: `ok` is true and means exactly as much as
      // the one player's word. Correct, and a UI that renders it like 3 of 4 is
      // lying by omission — which is why the tally is the product and `ok` is the
      // convenience.
      const g = await game([1]);
      const witnesses = [await signCheckpointFor(g, g.seats[0]!)];
      expect(await verifyResumePoint(g.genesis, point({ witnesses }))).toMatchObject({
        ok: true,
        endorsed: 1,
        needed: 1,
      });
    });
  });

  describe("a game that has lost seats", () => {
    it("reaches a quorum out of the seats that are left", async () => {
      // The other gap that would have shipped looking fine: a four-seat game
      // that has dropped two needs three signatures from two available signers,
      // so resume points would stop existing exactly when a long game most needs
      // them.
      const g = await game([2, 2]);
      const drops = [await drop(g, g.seats[2]!), await drop(g, g.seats[3]!)];
      const witnesses = [
        await signCheckpointFor(g, g.seats[0]!),
        await signCheckpointFor(g, g.seats[1]!),
      ];

      expect(await verifyResumePoint(g.genesis, point({ drops, witnesses }))).toMatchObject({
        ok: true,
        endorsed: 2,
        needed: 2,
      });
    });

    it("will not let a fabricated drop shrink the electorate", async () => {
      // Otherwise the cheapest attack on a resume point is not forging a witness
      // at all: it is claiming everybody else left, so that one signature is a
      // majority.
      const g = await game([2, 2]);
      const unsigned: SignedDrop = {
        drop: { empire: g.seats[1]!.empire, member: g.seats[1]!.member, atStep: 12 },
        signatures: [],
      };
      const drops = [
        unsigned,
        { ...unsigned, drop: { empire: 2, member: 0, atStep: 12 } },
        { ...unsigned, drop: { empire: 2, member: 1, atStep: 12 } },
      ];
      const witnesses = [await signCheckpointFor(g, g.seats[0]!)];

      const tally = await verifyResumePoint(g.genesis, point({ drops, witnesses }));
      expect(tally).toMatchObject({ ok: false, endorsed: 1, needed: 3 });
      expect(tally.problems.join(" ")).toMatch(/lacks a quorum/);
    });

    it("ignores a drop dated after the point it is offered with", async () => {
      // A seat that was dropped later was present at this step and its signature
      // counts here.
      const g = await game([2, 2]);
      const later = await drop(g, g.seats[3]!, STEP + 12);
      const witnesses = [
        await signCheckpointFor(g, g.seats[0]!),
        await signCheckpointFor(g, g.seats[1]!),
      ];
      expect(await verifyResumePoint(g.genesis, point({ drops: [later], witnesses }))).toMatchObject(
        { ok: false, endorsed: 2, needed: 3 },
      );
    });
  });

  it("refuses an unsealed genesis, because nothing can be signed against it", async () => {
    const empires = [
      { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: "k" }] },
    ];
    const unsealed = makeGenesis({
      seed: 1,
      startedAt: 0,
      map: { width: 24, height: 24 },
      empires,
    });
    const tally = await verifyResumePoint(unsealed, point());
    expect(tally.problems.join(" ")).toMatch(/unsealed/);
  });

  it("refuses something that is not a resume point", async () => {
    const g = await game([1, 1]);
    for (const bad of [undefined, null, {}, { step: -1, witnesses: [] }]) {
      const tally = await verifyResumePoint(g.genesis, bad as unknown as ResumePoint);
      expect(tally.ok).toBe(false);
    }
  });
});

describe("rosterAt", () => {
  it("matches the genesis roster when there is nothing to apply", async () => {
    const g = await game([2, 2]);
    const walked = await rosterAt(g.genesis, []);
    expect(walked.all().map((seat) => seat.key)).toEqual(
      Roster.fromGenesis(g.genesis).all().map((seat) => seat.key),
    );
  });

  it("stops at an amendment that does not check out", async () => {
    const g = await game([2, 2]);
    const stranger = await Identity.generate();
    const bogus = {
      amendment: { empire: 1, key: stranger.key, kind: MEMBER.HUMAN, step: 12 },
      signatures: [],
    };
    const walked = await rosterAt(g.genesis, [bogus]);
    expect(walked.has(stranger.key)).toBe(false);
  });
});
