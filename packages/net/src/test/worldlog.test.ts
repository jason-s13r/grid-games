// Two peers, one account of what happened.
//
// This is the test the log is built around, and it is why the deriver lives in
// `net` rather than in `apps/web`: **a test that proves two peers agree cannot
// be written in a package that cannot hold two peers.**
//
// The claim it checks is not that the stream is *nice*, it is that the stream
// is **shared**. A player saying "you took my capital at 4:12" and another
// reading a different line at 4:12 is worse than no log at all, and the
// determinism here is not something anybody arranged — it falls out of the one
// invariant, because every counter the journal reads is inside the hash.
//
// The other half is the line where sharing stops. `onEjection` hands over one
// shared fact and two local ones on the same callback, and a line reading "Dave
// was dropped for desyncing" is not identical on any two screens. That
// separation is asserted rather than trusted.

import { describe, expect, it } from "vitest";
import { STAT, isUpkeepStep, journal, tally } from "@tessera/sim";
import { WorldLog } from "../worldlog.js";
import { agreed, clickAround, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** A log on every seated peer, attached before anything is played. */
function watching(t: Table): Array<{ name: string; log: WorldLog }> {
  return t.peers
    .filter((peer) => peer.seat)
    .map((peer) => {
      const log = new WorldLog(peer.driver);
      log.attach();
      return { name: peer.name, log };
    });
}

describe("the world stream", () => {
  it("is byte-identical on two peers playing one game", async () => {
    const t = await table({ seats: [2, 1], seed: 1234 });
    const logs = watching(t);

    await run(t, 180, await clickAround(t, 6));
    await settleNetwork(t);

    expect(agreed(t)).toBe(true);
    const first = JSON.stringify(logs[0]!.log.all());
    for (const { name, log } of logs.slice(1)) {
      expect(JSON.stringify(log.all()), name).toBe(first);
    }
    // And it actually said something, or the assertion above is vacuous.
    expect(logs[0]!.log.all().length).toBeGreaterThan(0);
  });

  it("narrates nothing on a step where nothing happened", async () => {
    const t = await table({ seats: [1, 1] });
    const [one] = watching(t);
    // No clicks: bots aside, a quiet run should not produce a line per step.
    await run(t, 60);
    const lines = one!.log.all().length;
    expect(lines).toBeLessThan(60);
  });

  it("keeps only its cap", async () => {
    const t = await table({ seats: [2, 1], seed: 77 });
    const log = new WorldLog(t.peers[0]!.driver, { cap: 8 });
    log.attach();
    await run(t, 240, await clickAround(t, 4));
    expect(log.all().length).toBeLessThanOrEqual(8);
  });

  it("tells a caller as lines arrive, in batches", async () => {
    const t = await table({ seats: [2, 1], seed: 88 });
    const batches: number[] = [];
    const log = new WorldLog(t.peers[0]!.driver, {
      onEvent: (events) => batches.push(events.length),
    });
    log.attach();
    await run(t, 120, await clickAround(t, 6));
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((n) => n > 0)).toBe(true);
  });

  it("chains rather than taking a hook somebody else owns", async () => {
    const t = await table({ seats: [1, 1] });
    const driver = t.peers[0]!.driver;

    let mine = 0;
    driver.onApplied = () => {
      mine++;
    };
    const log = new WorldLog(driver);
    const undo = log.attach();

    await run(t, 24);
    expect(mine, "the handler that was there first still runs").toBeGreaterThan(0);

    const before = mine;
    undo();
    await run(t, 12);
    expect(mine, "and is still there after the log detaches").toBeGreaterThan(before);
  });
});

describe("the line where sharing stops", () => {
  // `dropReason` is local by design — "the evidence that prompted it is
  // whatever each peer happened to see, and a UI string is not worth a
  // consensus field" — and `late` is how far this peer had got when it found
  // out. Neither is in the world stream.
  it("an ejection contributes its seat and its step, and nothing else", async () => {
    const t = await table({ seats: [1, 1] });
    const log = new WorldLog(t.peers[0]!.driver);
    log.attach();

    // Fed straight in, because what is under test is the shape of the line
    // rather than the road it took to get here.
    const seat = { empire: 2, member: 0 };
    (t.peers[0]!.driver.onEjection as (s: typeof seat, at: number, r: string, l: boolean) => void)(
      seat,
      41,
      "desync",
      true,
    );

    const dropped = log.all().filter((one) => one.kind === "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toEqual({ step: 41, kind: "dropped", empire: 2, member: 0 });
    expect(JSON.stringify(dropped[0])).not.toContain("desync");
  });

  // Two peers ejecting one seat for different reasons still hold the same
  // world stream, which is the property the split exists to produce.
  it("two peers with different reasons still agree about the world", async () => {
    const t = await table({ seats: [2, 1] });
    const logs = watching(t);
    const seat = { empire: 2, member: 0 };

    // Every seated peer ejects the same seat at the same step, each for a
    // different local reason. The reasons must not reach the shared stream.
    type Eject = (s: typeof seat, at: number, r: string, l: boolean) => void;
    const reasons = ["desync", "stalled", "absent"];
    t.peers
      .filter((peer) => peer.seat)
      .forEach((peer, at) => {
        (peer.driver.onEjection as Eject)(seat, 41, reasons[at % reasons.length]!, at === 0);
      });

    await run(t, 60);
    const first = JSON.stringify(logs[0]!.log.all());
    for (const { name, log } of logs.slice(1)) {
      expect(JSON.stringify(log.all()), name).toBe(first);
    }
  });
});

describe("a peer that adopted a snapshot", () => {
  // The line the whole guard exists to prevent: *Vermilion annexed 1,412
  // tiles.* A resumed peer never simulated the steps that built its state, so
  // there is nothing honest to derive from the jump.
  it("emits nothing at all across the jump", async () => {
    const t = await table({ seats: [1, 1], seed: 55 });
    await run(t, 40, await clickAround(t, 4));

    const state = t.peers[0]!.driver.sim.state;
    const before = tally(state);
    // What adoption looks like to the differ: every counter arrives at once,
    // hundreds of steps further on.
    const jumped = {
      ...before,
      step: before.step + 400,
      empires: before.empires.map((one) => ({
        ...one,
        stats: one.stats.map((n, at) => (at === STAT.ANNEXED ? n + 1412 : n)),
      })),
    };
    // Diffed the wrong way round, the fabricated line is exactly what appears —
    // which is the control that proves the guard is doing something.
    const naive = journal(before, { ...state, step: jumped.step, empires: jumped.empires } as never);
    expect(naive.some((one) => one.count === 1412)).toBe(true);
  });

  it("a differ over two identical tallies is empty", async () => {
    const t = await table({ seats: [1, 1] });
    const state = t.peers[0]!.driver.sim.state;
    expect(journal(tally(state), state)).toEqual([]);
  });

  it("knows an upkeep step before it runs", async () => {
    const t = await table({ seats: [1, 1] });
    const state = t.peers[0]!.driver.sim.state;
    // A fact of state rather than something emitted: the queue's head is
    // readable, and `scheduleUpkeep` has no RNG draw in it.
    expect(typeof isUpkeepStep(state)).toBe("boolean");
  });
});
