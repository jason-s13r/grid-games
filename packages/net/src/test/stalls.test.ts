// Someone closes their laptop. The table cannot simply guess when to stop
// waiting, because two peers guessing separately would drop the seat on
// different steps and desync over the disagreement.
//
// So a drop is itself a record: proposed, endorsed by a quorum, and applied at
// the step the record names rather than at whichever stopwatch fired first.

import { beforeAll, describe, expect, it } from "vitest";
import { agreed, clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a silent peer is dropped by agreement", () => {
  let t: Table;
  let frozenAt: number;
  let blockedOn: ReturnType<Table["peers"][number]["driver"]["blockedOn"]>;
  let stepWhileWaiting: number;

  beforeAll(async () => {
    t = await table({ seats: [2, 1], stallTimeout: 400 });
    const quiet = t.peers[2]!;

    await run(t, 60, await clickAround(t, 24));
    frozenAt = t.peers[0]!.driver.step;

    // The peer stops answering. Its transport goes with it, so nothing it has
    // already queued arrives either.
    t.awake.delete(quiet.name);
    t.net.disconnect(quiet.name);

    // Briefly — less than the stall timeout, so the table is caught in the act
    // of waiting rather than already past it.
    await run(t, 4);
    blockedOn = t.peers[0]!.driver.blockedOn();
    stepWhileWaiting = t.peers[0]!.driver.step;

    // Real time passes: long enough for the lowest-ranked peer to propose.
    t.clock.advance(2000);
    await run(t, 120, await clickAround(t, 24));
  });

  describe("while it is still only late", () => {
    it("the table stops rather than guessing", () => {
      expect(stepWhileWaiting).toBeLessThanOrEqual(frozenAt + 4);
    });

    it("and it knows exactly whom it is waiting for", () => {
      expect(blockedOn.map((seat) => seat.empire)).toEqual([2]);
    });
  });

  describe("once the drop is agreed", () => {
    const ejections = (): Array<Table["peers"][number]["ejections"][number] | undefined> =>
      t.peers.slice(0, 2).map((peer) => peer.ejections[0]);

    it("every remaining peer dropped the seat", () => {
      expect(ejections().every(Boolean)).toBe(true);
    });

    it("for the same reason", () => {
      expect(ejections().map((e) => e?.reason)).toEqual(["stalled", "stalled"]);
    });

    it("and on exactly the same step", () => {
      expect(new Set(ejections().map((e) => e?.atStep)).size).toBe(1);
    });

    // `late` means the peer had to rebuild to apply the drop. Agreeing on the
    // step in the first place is what avoids that.
    it("nobody had to rebuild", () => {
      expect(ejections().every((e) => e?.late === false)).toBe(true);
    });

    it("the game resumed", () => {
      expect(t.peers[0]!.driver.step).toBeGreaterThan(frozenAt + 60);
    });

    it("and the survivors still agree", () => {
      expect(agreed(t, ["e1m0", "e1m1"])).toBe(true);
    });
  });
});
