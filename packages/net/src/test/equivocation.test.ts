// Telling different peers different things is the only attack a signature
// cannot prevent — and because the mesh gossips every move it sees, it is
// detected rather than merely suspected.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE } from "@tessera/sim";
import type { Move } from "@tessera/sim";
import { FRAME, signMove } from "@tessera/protocol";
import { clickAround, run, settle, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("equivocation is caught and costs the seat", () => {
  let t: Table;
  let witnesses: Table["peers"];
  let cheatedAt: number;
  let cheaterMember: number;

  beforeAll(async () => {
    t = await table({ seats: [2, 1] });
    await run(t, 36, await clickAround(t, 18));

    // One seat signs two different moves for the same slot.
    const cheater = t.peers[1]!;
    cheaterMember = cheater.seat!.member;
    cheatedAt = cheater.driver.step + 5;
    const base: Move = {
      step: cheatedAt,
      empire: cheater.seat!.empire,
      member: cheaterMember,
      seq: 9999,
      type: MOVE.HEARTBEAT,
      x: 0,
      y: 0,
    };

    const a = await signMove(cheater.identity!, t.gameId, base);
    const b = await signMove(cheater.identity!, t.gameId, { ...base, x: 1 });

    // Sent from a peer of its own so the two halves genuinely arrive apart,
    // which is what the attack looks like from the outside.
    const wire = t.net.connect("gossip");
    for (const signed of [a, b]) {
      wire.broadcast({ t: FRAME.MOVE, signed });
      await settle();
      t.net.flush();
      await settle();
    }

    await run(t, 24);
    witnesses = t.peers.filter((peer) => peer.ejections.length > 0);
  });

  it("the cheat was detected", () => expect(witnesses.length).toBeGreaterThanOrEqual(2));

  it("as equivocation", () => {
    expect(witnesses.map((peer) => peer.ejections[0]!.reason)).toEqual(
      witnesses.map(() => "equivocation"),
    );
  });

  // The proof carries the step, so every witness reaches the same verdict from
  // the evidence rather than from when the evidence happened to reach it.
  it("and every witness ejects on the same step", () => {
    expect(new Set(witnesses.map((peer) => peer.ejections[0]!.atStep)).size).toBe(1);
  });

  it("the step comes from the proof, not from when it was seen", () => {
    expect(witnesses[0]!.ejections[0]!.atStep).toBeGreaterThan(cheatedAt);
  });

  it("and both halves were validly signed by that seat", () => {
    expect(witnesses.every((peer) => peer.ejections[0]!.seat.member === cheaterMember)).toBe(true);
  });
});
