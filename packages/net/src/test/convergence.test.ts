// The baseline: peers exchange only inputs, and end up bit-identical.
//
// Everything else in this package is a variation on making that hold when
// something goes wrong. If this one fails, nothing below it means anything.

import { beforeAll, describe, expect, it } from "vitest";
import { clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("peers converge", () => {
  let t: Table;
  let before: number;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], observer: true });
    before = t.peers[0]!.driver.hash();
    await run(t, 180, await clickAround(t, 24));
  });

  const lead = (): Table["peers"][number]["driver"] => t.peers[0]!.driver;

  it("the world advanced", () => expect(lead().step).toBeGreaterThan(120));

  it("the state actually changed", () => expect(lead().hash()).not.toBe(before));

  it("every peer is on the same step", () => {
    expect(t.peers.map((peer) => peer.driver.step)).toEqual(t.peers.map(() => lead().step));
  });

  it("every peer holds the same state", () => {
    expect(t.peers.map((peer) => peer.driver.hash())).toEqual(t.peers.map(() => lead().hash()));
  });

  // An observer holds no seat, so nobody waits for it and it cannot hold the
  // game up — which is what makes an always-on archive peer possible without
  // granting it any authority.
  it("an observer follows without anyone waiting for it", () => {
    expect(t.peers[3]!.driver.hash()).toBe(lead().hash());
  });

  it("nothing arrived late", () => {
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.lateMoves, 0)).toBe(0);
  });

  it("nobody reported a desync", () => {
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.desyncs, 0)).toBe(0);
  });

  it("nobody was ejected", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
  });

  // Four empires agreeing on an empty board would also agree, and agree about
  // nothing.
  it("and the empires are contesting real ground", () => {
    expect(lead().sim.state.empires.some((empire) => empire.tilesOwned > 1)).toBe(true);
  });
});
