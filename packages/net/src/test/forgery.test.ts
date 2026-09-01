// Anyone may connect. Only keys in the roster produce accepted moves, so an
// arbitrary mid-game join is an observer by construction — no extra mechanism,
// and nothing to configure.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE } from "@tessera/sim";
import { FRAME, Identity, signMove } from "@tessera/protocol";
import { agreed, clickAround, pickClaim, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a forged move changes nothing", () => {
  let t: Table;
  let agreedBefore: boolean;

  beforeAll(async () => {
    t = await table({ seats: [2, 1] });
    const mallory = await Identity.generate();
    const victim = t.peers[0]!;

    await run(t, 48, await clickAround(t, 24));
    agreedBefore = agreed(t);

    // Mallory signs as a seat she does not hold, and sends it to one peer only:
    // if it were going to work anywhere, it would work on the peer that never
    // gets to compare notes about it.
    const attacker = t.net.connect("mallory");
    const target = pickClaim(victim.driver.sim, 1, 0);
    if (target) {
      const forged = await signMove(mallory, t.gameId, {
        ...target,
        step: victim.driver.step + 4,
        seq: 4096,
      });
      attacker.send(victim.name, { t: FRAME.MOVE, signed: forged });
    }

    // And a move signed correctly, but for a game that is not this one.
    const elsewhere = await signMove(mallory, "0".repeat(64), {
      step: victim.driver.step + 4,
      empire: 1,
      member: 0,
      seq: 4097,
      type: MOVE.HEARTBEAT,
      x: 0,
      y: 0,
    });
    attacker.send(victim.name, { t: FRAME.MOVE, signed: elsewhere });

    // And an unsigned readiness claim far in the future, which would walk the
    // whole table past steps nobody has spoken for.
    attacker.broadcast({
      t: FRAME.READY,
      signed: { ready: { upTo: 1 << 20, empire: 1, member: 0 }, sig: "x" },
    });

    await run(t, 48, await clickAround(t, 24));
  });

  it("the table agreed before the attempt", () => expect(agreedBefore).toBe(true));

  it("the victim still agrees with the table", () => expect(agreed(t)).toBe(true));

  it("neither forgery was ever treated as a move", () => {
    expect(t.peers[0]!.driver.lateMoves + t.peers[1]!.driver.lateMoves).toBe(0);
  });

  // Nothing was ejected, because nothing was accused: an unrecognised key is
  // not a cheat, it is a stranger.
  it("a non-roster peer is simply an observer", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });
});
