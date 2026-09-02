// The same recorded game, replayed wherever this suite happens to be running.
//
// Determinism inside one engine is the easy half, and the determinism suite
// already has it: two runs in the same process agree because they are the same
// arithmetic twice. What the mesh actually needs is stronger — a move applied
// in Chrome on a laptop and in Firefox on a phone has to produce the same
// state, or the two peers desync and the game stops, twenty minutes in, for
// nobody's visible reason.
//
// So this file is deliberately environment-blind and is run twice: once under
// Node by this package's suite, and once in real browsers by the client's. The
// fixture is a recorded game rather than a seeded one because a seeded game
// exercises the world's own machinery and none of the move path — validation,
// combat, cascades and the surround multiplier are all reached through inputs.
//
// When this fails, the number is the bug report: the fixture's hash is what the
// engine that recorded it computed, and any other value means two peers running
// the same log now hold different worlds.

import { describe, expect, it } from "vitest";
import { Sim } from "../sim.js";
import { hex } from "../hash.js";
import type { Genesis, Move } from "../types.js";
import fixture from "./fixtures/recorded.json";

const recorded = fixture as unknown as {
  genesis: Genesis;
  steps: number;
  hash: string;
  moveLog: Move[];
};

/** Named in the failure output, so a red run says which engine disagreed. */
const environment =
  typeof navigator !== "undefined" && navigator.userAgent
    ? navigator.userAgent.slice(0, 60)
    : `node ${typeof process !== "undefined" ? process.version : "?"}`;

describe(`a recorded game replays identically (${environment})`, () => {
  const sim = new Sim(recorded.genesis);
  sim.fastForward(recorded.steps, recorded.moveLog);

  it("reaches the recorded step", () => expect(sim.step).toBe(recorded.steps));

  it("reaches the recorded hash", () => expect(hex(sim.hash())).toBe(recorded.hash));

  // Without this the test would still pass on a log whose moves were all
  // rejected, and would then be checking the map generator and nothing else.
  it("and the moves are what got it there", () => {
    const withoutMoves = new Sim(recorded.genesis);
    withoutMoves.fastForward(recorded.steps);
    expect(hex(withoutMoves.hash())).not.toBe(recorded.hash);
  });

  it("the log is not trivially small", () => {
    expect(recorded.moveLog.length).toBeGreaterThan(100);
  });
});
