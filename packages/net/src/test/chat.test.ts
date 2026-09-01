// Chat is signed, ordered and attributable, and deliberately outside the state
// hash. That is what makes it safe: a message arriving late, out of order, or
// not at all can never cause a desync.
//
// The way to prove it is to break chat on purpose.

import { beforeAll, describe, expect, it } from "vitest";
import { CHANNEL, FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { agreed, run, table } from "./harness.js";
import type { Table } from "./harness.js";

/** Every chat message to this peer is dropped on the floor. If chat were inside
 *  the hash, this is the run that would prove it. */
const DEAF = "e2m0";

describe("chat cannot desync a game", () => {
  let t: Table;
  let heard: number[];

  beforeAll(async () => {
    t = await table({
      seats: [2, 1],
      loopback: { drop: (_from, to, frame: Frame) => to === DEAF && frame.t === FRAME.MESSAGE },
    });

    await run(t, 96, async (step) => {
      if (step % 12 !== 0) return;
      for (const peer of t.peers) {
        if (peer.seat) await peer.driver.say(`step ${step} from ${peer.name}`, CHANNEL.PUBLIC);
      }
    });
    heard = t.peers.map((peer) => peer.chat.length);
  });

  it("the chattier peers heard more", () => {
    expect(heard[0]!).toBeGreaterThan(heard[2]!);
  });

  it("the deaf peer still heard its own words", () => {
    expect(heard[2]!).toBeGreaterThan(0);
  });

  it("messages really were dropped", () => expect(t.net.dropped).toBeGreaterThan(0));

  it("and every peer still holds the same state", () => expect(agreed(t)).toBe(true));
});
