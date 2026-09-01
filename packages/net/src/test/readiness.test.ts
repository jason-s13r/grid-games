// A readiness promise is "I will send nothing more for steps up to here". It is
// what lets a peer advance without waiting on a round trip for every step.
//
// Submitting a move holds that promise below the move's slot until the
// signature is out, so a READY cannot overtake the move it is promising about.
// Signing is asynchronous and the world does not stop for it: the peer keeps
// simulating, and every announcement it makes in that window is capped away.
//
// Left there, the promise on record is stale the moment the ceiling lifts — and
// a peer whose promise is stale blocks the peer waiting on it, which stops
// announcing in turn. Two peers then wait on each other until the stall timer
// ejects one of them for a fault it did not have.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE } from "@tessera/sim";
import { FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { agreed, clickAround, pickClaim, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a promise made while signing is renewed, not left stale", () => {
  let t: Table;
  let promised: number;
  let standingAt: number;
  let heldAt: number;

  beforeAll(async () => {
    t = await table({ seats: [1, 1], stallTimeout: 60_000 });
    await run(t, 60, await clickAround(t, 20));

    const peer = t.peers[0]!;
    const identity = peer.identity! as unknown as {
      sign: (payload: Uint8Array) => Promise<string>;
    };
    const realSign = identity.sign.bind(identity);

    // Gate exactly one signature: the move's. Heartbeats and readiness go
    // through the same key, and holding those too would be a different failure.
    let arming = false;
    let release = (): void => {};
    identity.sign = async (payload) => {
      if (arming) {
        arming = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return realSign(payload);
    };

    const claim = pickClaim(peer.driver.sim, peer.seat!.empire, peer.seat!.member);
    expect(claim).not.toBeNull();
    arming = true;
    const pending = peer.driver.submit(MOVE.CLAIM, claim!.x, claim!.y);

    // Long enough that the peer overruns the ceiling it is holding.
    await run(t, 12);
    heldAt = t.peers[1]!.driver.step;

    release();
    await pending;
    promised = (peer.driver as unknown as { broadcastReady: number }).broadcastReady;
    standingAt = peer.driver.step;

    await run(t, 60, await clickAround(t, 20));
  });

  it("the promise was renewed as soon as the signature was out", () => {
    expect(promised).toBeGreaterThanOrEqual(standingAt);
  });

  it("the table moved on once the signature landed", () => {
    expect(t.peers[1]!.driver.step).toBeGreaterThan(heldAt);
  });

  it("and nobody was ejected for waiting", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });

  // A signature held for a full second is far past the input delay, so the move
  // it was signing misses the slot it was addressed to and one peer applies
  // what the other never received. That is not what this scenario is about, and
  // it is not swept up either: the checkpoint machinery is what catches it.
  it("the move that missed its slot was noticed, not swallowed", () => {
    expect(t.peers.some((peer) => peer.desyncs.length > 0)).toBe(true);
  });
});

describe("a peer that was not listening when we last spoke", () => {
  // A full mesh takes a second hop to form. Two players who join a host at the
  // same moment are talking to the host long before their channel to each other
  // opens — and readiness is announced once, when it advances. Each then waits
  // on a promise the other made before either could hear it, and nothing but
  // the stall timer ever breaks it: neither is advancing, so neither has
  // anything new to announce.
  let t: Table;
  let isolated = true;

  beforeAll(async () => {
    t = await table({
      seats: [1, 1, 1],
      stallTimeout: 60_000,
      loopback: {
        drop: (from, to, frame: Frame) =>
          isolated &&
          frame.t === FRAME.READY &&
          [from, to].every((peer) => peer === "e2m0" || peer === "e3m0"),
      },
    });
    // Long enough for everyone to announce, and for the two isolated seats to
    // miss each other doing it.
    await run(t, 8);
    isolated = false;
    await run(t, 96, await clickAround(t, 24));
  });

  it("hears the standing promise once the channel opens", () => {
    expect(t.net.dropped).toBeGreaterThan(0);
    expect(t.peers[1]!.driver.step).toBeGreaterThan(60);
  });

  it("so the table gets going", () => {
    expect(t.peers[0]!.driver.step).toBeGreaterThan(60);
  });

  it("with nobody ejected for it", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });

  it("and everyone on the same state", () => expect(agreed(t)).toBe(true));
});
