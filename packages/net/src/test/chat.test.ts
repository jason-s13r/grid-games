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

describe("team chat is private to the empire", () => {
  // The mesh broadcasts everything, so an opponent and an observer both receive
  // every team message and store it. What separates them from a teammate is
  // only whether the bytes open.
  const PLAN = "push their capital at 3:20, I have 900 banked";
  let t: Table;
  let mate: Table["peers"][number];
  let opponent: Table["peers"][number];
  let observer: Table["peers"][number];

  beforeAll(async () => {
    t = await table({ seats: [2, 1], observer: true });
    await run(t, 24);
    await t.peers[0]!.driver.say(PLAN, CHANNEL.TEAM);
    await run(t, 24);
    [, mate, opponent, observer] = t.peers;
  });

  it("the teammate reads it", () => {
    expect(mate.heard.at(-1)).toBe(PLAN);
  });

  it("the sender sees what it typed, not what it sent", () => {
    expect(t.peers[0]!.heard.at(-1)).toBe(PLAN);
    expect(t.peers[0]!.chat.at(-1)!.body).not.toBe(PLAN);
  });

  it("an opponent receives it and cannot read it", () => {
    expect(opponent.chat).toHaveLength(1);
    expect(opponent.heard.at(-1)).toBeNull();
  });

  it("an observer receives it and cannot read it", () => {
    expect(observer.chat).toHaveLength(1);
    expect(observer.heard.at(-1)).toBeNull();
  });

  // Attribution survives encryption on purpose: an opponent should be able to
  // see that empire 1 is talking, and how much. Only the words are private.
  it("but everyone can see who said it and when", () => {
    const seen = opponent.chat[0]!;
    expect(seen.empire).toBe(1);
    expect(seen.member).toBe(0);
    expect(seen.channel).toBe(CHANNEL.TEAM);
  });

  it("and nothing about it touched the state", () => expect(agreed(t)).toBe(true));
});
