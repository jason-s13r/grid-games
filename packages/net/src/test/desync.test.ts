// Peers broadcast a hash of their state every few steps. A build that is subtly
// non-deterministic diverges from everyone else and has no way to know it — so
// the disagreement has to be detected by comparison, not by self-inspection.

import { beforeAll, describe, expect, it } from "vitest";
import { agreed, clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a divergent peer is noticed", () => {
  let t: Table;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], checkpointInterval: 12 });
    await run(t, 36, await clickAround(t, 18));

    // Reach in and corrupt one peer's state — exactly what a subtly
    // non-deterministic build would do to itself.
    const rogue = t.peers[1]!;
    rogue.driver.sim.state.pop[0] = (rogue.driver.sim.state.pop[0] ?? 0) + 1;

    await run(t, 48);
  });

  it("the honest peers noticed", () => {
    expect(t.peers[0]!.desyncs.length).toBeGreaterThan(0);
  });

  it("and so did the divergent one", () => {
    expect(t.peers[1]!.desyncs.length).toBeGreaterThan(0);
  });

  it("the desync is reported against a real seat", () => {
    expect(t.peers[0]!.desyncs.every((entry) => entry.seat.empire >= 1)).toBe(true);
  });
});

// Noticing is not enough on its own. A peer whose state has drifted contributes
// nothing but noise: it validates against a world nobody else is in, and every
// checkpoint it signs disagrees. The plan's rule is that it rebuilds, and is
// dropped if it still disagrees — so the escalation has to survive the obvious
// objection, which is that a desync has no proof behind it. Two peers cannot
// see each other's memory, and neither can prove the other wrong.
//
// What makes it safe is that nobody acts alone. The drop goes through the same
// majority-endorsed record a stall does, and a peer only ever proposes one when
// it is in the agreeing majority itself.
describe("a peer that will not come back", () => {
  let t: Table;
  let rogue: string;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], checkpointInterval: 12, desyncTolerance: 2 });
    await run(t, 24, await clickAround(t, 12));

    rogue = t.peers[1]!.name;
    const broken = t.peers[1]!.driver;
    broken.sim.state.pop[0] = (broken.sim.state.pop[0] ?? 0) + 1;

    await run(t, 120, await clickAround(t, 12));
  });

  it("the majority dropped it", () => {
    const seen = t.peers[0]!.ejections;
    expect(seen.some((e) => e.reason === "desync")).toBe(true);
  });

  it("and dropped the seat that actually drifted", () => {
    const dropped = t.peers[0]!.ejections.find((e) => e.reason === "desync")!;
    expect(dropped.seat).toEqual(t.peers[1]!.seat);
  });

  // The drop is a record, not a local decision, so everybody has to have it —
  // including the peer being dropped, which is how it learns to stop.
  it("every peer agrees it happened", () => {
    for (const peer of t.peers) {
      expect(peer.ejections.some((e) => e.seat.empire === t.peers[1]!.seat!.empire &&
        e.seat.member === t.peers[1]!.seat!.member)).toBe(true);
    }
  });

  it("the honest peers are still playing together", () => {
    expect(agreed(t, [t.peers[0]!.name, t.peers[2]!.name])).toBe(true);
  });

  it("and the drifted peer never accused anybody", () => {
    // It is the minority. A peer that disagrees with everyone is likelier to be
    // the broken one than everyone is, and one that started accusing from there
    // would be accusing the honest majority.
    expect(t.peers[1]!.ejections.filter((e) => e.seat.member !== t.peers[1]!.seat!.member))
      .toEqual([]);
    expect(rogue).toBe(t.peers[1]!.name);
  });
});
