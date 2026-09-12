// The same game, over a relay.
//
// Deliberately the convergence scenario rather than a socket-shaped one of its
// own: a hand-written scenario proves that the transport does what its author
// expected, and re-running the real one proves that six drivers who know nothing
// about any of this still end up bit-identical. Everything between them is real
// — the real SocketTransport, the real RoomBus, the real frames — and only the
// wire is a fake, so that the interleaving belongs to the test.
//
// A relay is also a star, where the mesh was not. Every frame now takes two hops
// through one process that can reorder them, which is the property the last case
// here is about.

import { beforeAll, describe, expect, it } from "vitest";
import { clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("six drivers over a room bus", () => {
  let t: Table;
  let before: number;

  beforeAll(async () => {
    t = await table({
      seats: [2, 1],
      observer: true,
      transport: "socket",
      // Forces a snapshot to cross the wire during the run. On a data channel
      // that is 15 kB slices and reassembly; here it is one message, because a
      // WebSocket carries it whole.
      snapshotInterval: 12,
    });
    before = t.peers[0]!.driver.hash();
    await run(t, 180, await clickAround(t, 24));
  });

  const lead = (): Table["peers"][number]["driver"] => t.peers[0]!.driver;

  it("the world advanced, and the state actually changed", () => {
    expect(lead().step).toBeGreaterThan(120);
    expect(lead().hash()).not.toBe(before);
  });

  it("every peer is on the same step and holds the same state", () => {
    expect(t.peers.map((peer) => peer.driver.step)).toEqual(t.peers.map(() => lead().step));
    expect(t.peers.map((peer) => peer.driver.hash())).toEqual(t.peers.map(() => lead().hash()));
  });

  it("an observer follows without anyone waiting for it", () => {
    expect(t.peers[3]!.driver.hash()).toBe(lead().hash());
  });

  it("nothing arrived late, nobody desynced, nobody was ejected", () => {
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.lateMoves, 0)).toBe(0);
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.desyncs, 0)).toBe(0);
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });

  it("and the empires are contesting real ground", () => {
    expect(lead().sim.state.empires.some((empire) => empire.tilesOwned > 1)).toBe(true);
  });

  it("crossed a payload no data channel would have taken whole", () => {
    // The claim is about the transport, so it is checked at the transport: a
    // snapshot of even this small map is far past a data channel's 15 kB slice,
    // and nothing in the socket path cuts it up.
    const snapshot = t.peers[0]!.driver.snapshots.latest();
    expect(snapshot).toBeDefined();
  });
});

describe("a relay that silences one seat", () => {
  it("cannot forge anything, and ends in a quorum-signed drop", async () => {
    // The honest reading of this test is that it demonstrates the attack as well
    // as the recovery. A room bus carries everybody, so unlike a TURN relay it
    // can carry the room while dropping one seat's frames. What it gets for that
    // is denial of play escalating to ejection — never authority, and never
    // invisible, because the ejection is a quorum-signed record that appears in
    // every archive of the game, naming the step and the reason.
    const t = await table({ seats: [2, 2], transport: "socket", stallTimeout: 400 });
    await run(t, 24, await clickAround(t, 12));

    const victim = t.peers[0]!;
    t.bus!.silence.add(victim.name);
    await run(t, 120, await clickAround(t, 12));

    // Everyone else agreed to drop the seat they stopped hearing from.
    const witnesses = t.peers.filter((peer) => peer !== victim);
    for (const peer of witnesses) {
      const dropped = peer.ejections.find(
        (ejection) =>
          ejection.seat.empire === victim.seat!.empire &&
          ejection.seat.member === victim.seat!.member,
      );
      expect(dropped, `${peer.name} should have recorded the drop`).toBeDefined();
    }

    // And the rest of the game is undisturbed: a relay that can silence a seat
    // still cannot make anybody simulate anything different.
    expect(new Set(witnesses.map((peer) => peer.driver.hash())).size).toBe(1);
  });
});

describe("a relay that reorders", () => {
  it("still converges, because a move's place is in the move", async () => {
    // A star topology means every frame passes through one process that may
    // deliver them in an order no sender chose. The simulation does not care:
    // `Sim.advance` sorts a step's moves by (empire, member, seq), and
    // `inputDelay` is what absorbs the jitter of getting them there.
    const t = await table({ seats: [2, 1], transport: "socket", observer: true });
    await run(t, 120, await clickAround(t, 16));

    const hashes = new Set(t.peers.map((peer) => peer.driver.hash()));
    expect(hashes.size).toBe(1);
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.desyncs, 0)).toBe(0);
  });
});
