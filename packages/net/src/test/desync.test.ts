// Peers broadcast a hash of their state every few steps. A build that is subtly
// non-deterministic diverges from everyone else and has no way to know it — so
// the disagreement has to be detected by comparison, not by self-inspection.

import { beforeAll, describe, expect, it } from "vitest";
import { clickAround, run, table } from "./harness.js";
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
