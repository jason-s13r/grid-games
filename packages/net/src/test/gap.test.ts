// The outage that used to cost a seat.
//
// This is the plan's core claim, written as code. A data channel is reliable and
// ordered, and when it stops being either it is gone and so is the peer — so
// every recovery path in the driver was written without the state a WebSocket
// has and a data channel does not: **back, having missed things**.
//
// What used to happen, in six steps:
//
//   1. a seat submits; `submit` signs, stashes the move locally, broadcasts it,
//      and in its `finally` announces readiness up to the slot;
//   2. the socket is down across that broadcast, and a socket in CLOSING or
//      CLOSED discards a send silently. Both writes go nowhere;
//   3. everyone else blocks, because each peer waits on every seat's readiness.
//      This is the part that saves it: an outage shorter than the stall timeout
//      costs nothing *if the frames survive it*;
//   4. the socket comes back. The peer is blocked, so `repeatReady` re-sends the
//      standing promise — but nothing re-sends a move;
//   5. so the room has the promise without the move. Everyone unblocks and
//      simulates the slot without it; the sender simulates it with;
//   6. at the next checkpoint the sender is a minority of one, and roughly
//      twenty seconds later its seat is dropped by quorum.
//
// Step 2 is the whole fault and the outbound buffer is the whole fix.

import { describe, expect, it } from "vitest";
import { MOVE } from "@tessera/sim";
import { clickAround, pickClaim, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** Bring a peer's socket back, letting the transport's jittered backoff fire.
 *  Real time is the one concession: the backoff is deliberately not
 *  deterministic, because a relay coming back must not be met by every client it
 *  dropped on the same millisecond. */
async function restore(t: Table, sockets: number): Promise<void> {
  for (let i = 0; i < 80 && t.bus!.sockets.length === sockets; i++) {
    await new Promise((done) => setTimeout(done, 25));
    t.bus!.settle();
  }
  for (let i = 0; i < 6; i++) {
    await new Promise((done) => setTimeout(done, 5));
    t.bus!.settle();
  }
  await settleNetwork(t);
}

describe("an observer whose socket drops", () => {
  it("catches up, rather than archiving a game that did not happen", async () => {
    // The case the host peer is made of, and the worst one in the series. An
    // observer holds no seat, so nobody waits for it and nobody can see that it
    // disagrees — it broadcasts no checkpoints. Left alone it keeps archiving a
    // game nobody played, and the archive is self-consistent, so verifying it
    // returns VERIFIED for a game that did not happen.
    const t = await table({ seats: [2, 1], observer: true, transport: "socket" });
    await run(t, 24, await clickAround(t, 12));

    const watcher = t.peers.find((peer) => !peer.seat)!;
    expect(t.bus!.socketOf(watcher.name), "the observer should hold a socket").toBeDefined();

    // Killed on every step, not once per chunk, because the transport is doing
    // its job: the backoff is real time, and a socket killed once has several
    // chances to come back inside a five-step run. **A relay that stays
    // unreachable is the case worth testing**, and the observer only falls
    // behind while it actually is.
    //
    // Once per chunk was enough until the driver started waiting for its own
    // signatures. A seated peer now pauses a pump while a move of its own is in
    // flight — it may not simulate past a step it has an unsent move for — so
    // the seats no longer reliably outrun an observer that keeps reconnecting,
    // and "did it fall behind" became a race between two kinds of latency
    // rather than a fact about a dead socket.
    const clicking = await clickAround(t, 12);
    for (let i = 0; i < 8; i++) {
      await run(t, 5, async (step) => {
        t.bus!.socketOf(watcher.name)?.kill();
        await clicking(step);
      });
    }
    // The world does not wait for it, which is exactly what makes an always-on
    // archive peer possible and exactly what makes this gap invisible.
    expect(watcher.driver.step).toBeLessThan(t.peers[0]!.driver.step);

    const before = t.bus!.sockets.length;
    await restore(t, before);
    await run(t, 24, await clickAround(t, 12));

    expect(watcher.driver.step).toBe(t.peers[0]!.driver.step);
    expect(watcher.driver.hash()).toBe(t.peers[0]!.driver.hash());
  });
});

describe("a socket that drops across a submit", () => {
  it("costs no move, no divergence and no seat", async () => {
    const t = await table({
      seats: [2, 1],
      observer: true,
      transport: "socket",
      // Tight enough that a missing move would be noticed and acted on inside
      // this run: three disagreeing checkpoints is what proposes a drop.
      checkpointInterval: 8,
      desyncTolerance: 2,
      stallTimeout: 2000,
    });

    await run(t, 40, await clickAround(t, 16));
    const victim = t.peers[0]!;
    const agreed = t.peers[1]!.driver.hash();
    expect(victim.driver.hash()).toBe(agreed);

    // The socket dies, and the peer writes a move into the hole.
    const socket = t.bus!.socketOf(victim.name);
    expect(socket, "the victim should hold a socket").toBeDefined();
    const before = t.bus!.sockets.length;
    socket!.kill();

    const move = pickClaim(victim.driver.sim, victim.seat!.empire, victim.seat!.member);
    expect(move, "there should be somewhere to claim").not.toBeNull();
    await victim.driver.submit(MOVE.CLAIM, move!.x, move!.y);

    // The world turns while the socket is down. Everyone else blocks on the
    // readiness this seat has already promised, which is what buys the time the
    // buffer needs.
    await run(t, 6);
    await restore(t, before);
    await run(t, 60, await clickAround(t, 16));

    // The whole claim: one state, nobody dropped, and the move that was written
    // into the outage is in it.
    const hashes = new Set(t.peers.map((peer) => peer.driver.hash()));
    expect(hashes.size, "every peer holds one state").toBe(1);
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.desyncs, 0)).toBe(0);

    const state = t.peers[1]!.driver.sim.state;
    expect(
      state.owner[move!.y * state.width + move!.x],
      "the move written during the outage landed, on a peer that was never told about it directly",
    ).toBe(victim.seat!.empire);
  });

  it("survives an outage long enough to hold several moves", async () => {
    const t = await table({ seats: [2, 1], transport: "socket", stallTimeout: 4000 });
    await run(t, 24, await clickAround(t, 12));

    const victim = t.peers[0]!;
    const before = t.bus!.sockets.length;
    t.bus!.socketOf(victim.name)!.kill();

    for (let i = 0; i < 3; i++) {
      const move = pickClaim(victim.driver.sim, victim.seat!.empire, victim.seat!.member);
      if (move) await victim.driver.submit(MOVE.CLAIM, move.x, move.y);
      await run(t, 2);
    }

    await restore(t, before);
    await run(t, 40, await clickAround(t, 12));

    // In order, which is why the buffer's overflow is a failure rather than a
    // drop-oldest: a truncated buffer reproduces exactly this bug, silently.
    expect(new Set(t.peers.map((peer) => peer.driver.hash())).size).toBe(1);
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });
});
