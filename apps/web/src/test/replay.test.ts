// Scrubbing backwards through a game the simulation cannot rewind.
//
// `Sim` has no undo and never will: a step is a hash, not a diff, and an undo
// would be a second implementation of the rules running in reverse — the exact
// thing the whole design refuses. So going back is going forward from somewhere
// earlier, and the only question that matters about this engine is whether the
// state it lands on is bit-for-bit the state a fresh simulation reaches at that
// step. Everything else here — the ladder spacing, the rung budget, the clamp —
// is bookkeeping in service of that one assertion.
//
// It is asserted against a freshly built `Sim` rather than against a recorded
// number, because a recorded number would pass just as happily if both sides
// drifted together.

import { describe, expect, it } from "vitest";
import { Sim, makeGenesis, simbot } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { ARCHIVE_FORMAT } from "@tessera/net";
import type { ArchivedGame } from "@tessera/net";
import { ReplayEngine } from "../replay/Engine";
import { MIN_LADDER, RUNGS, ladderFor, rungBelow, rungsFor } from "../replay/ladder";

const STEPS = 5_000;

/** Two SimBot empires and no move log at all.
 *
 *  A SimBot's play is part of the simulation rather than input to it, so this is
 *  a game that is thousands of steps of genuine, varied state — territory
 *  changing hands, coins accruing, upkeep running — with nothing to sign. That
 *  makes it the cheapest honest fixture there is for a replay: what is being
 *  tested is whether a step is reproducible, not whether a signature is real. */
const genesis = (): Genesis =>
  makeGenesis({
    seed: 4242,
    startedAt: 1_700_000_000_000,
    map: { width: 96, height: 72 },
    empires: [simbot("easy"), simbot("steady")],
  });

const saved = (steps = STEPS): ArchivedGame => ({
  format: ARCHIVE_FORMAT,
  genesis: genesis(),
  moveLog: [],
  amendments: [],
  messages: [],
  steps,
  hash: "",
});

/** What the world is at a step, computed the long way. */
const truth = (step: number): number => {
  const sim = new Sim(genesis());
  sim.fastForward(step);
  return sim.hash();
};

describe("the ladder is sized, not fixed", () => {
  it("never goes finer than five-odd minutes of game per rung", () => {
    // Below that the rungs cost more memory than the seek they save is worth.
    expect(ladderFor(100)).toBe(MIN_LADDER);
    expect(ladderFor(0)).toBe(MIN_LADDER);
  });

  it("spreads a long game over a fixed budget of rungs", () => {
    // A snapshot is ~320KB on a large map. A fixed spacing over a ten-day game
    // would be 2,500 rungs and most of a gigabyte.
    const tenDays = 12 * 60 * 60 * 24 * 10;
    expect(rungsFor(tenDays)).toBeLessThanOrEqual(RUNGS + 1);
    expect(ladderFor(tenDays)).toBeGreaterThan(MIN_LADDER);
  });

  it("keeps a rung for the beginning", () => {
    // Off by one here and the store evicts step zero, which makes seeking to the
    // start of a game the single most expensive seek there is.
    expect(rungsFor(STEPS, ladderFor(STEPS))).toBe(2);
    expect(rungBelow(0, 4096)).toBe(0);
  });

  it("puts no seek further than one ladder from a rung", () => {
    // The property the whole file exists for, stated as arithmetic.
    const ladder = ladderFor(STEPS);
    for (const step of [0, 1, 4095, 4096, 4097, STEPS]) {
      expect(step - rungBelow(step, ladder)).toBeLessThan(ladder);
    }
  });
});

describe("a replay lands on the state a simulation would reach", () => {
  it("is the genesis state at step zero", () => {
    const engine = new ReplayEngine(saved());
    engine.build();
    expect(engine.seek(0).hash).toBe(truth(0));
  });

  it("is the same state at the end as a fresh run", () => {
    const engine = new ReplayEngine(saved());
    engine.build();
    expect(engine.seek(STEPS).hash).toBe(truth(STEPS));
  });

  it("goes backwards to a state that is bit-for-bit right", () => {
    // The assertion this file exists for. The engine has already simulated past
    // this step twice — once building the ladder, once seeking to the end — and
    // what it hands back has to be indistinguishable from never having gone
    // there at all.
    const engine = new ReplayEngine(saved());
    engine.build();
    engine.seek(STEPS);
    expect(engine.seek(1_200).hash).toBe(truth(1_200));
  });

  it("goes backwards across a rung, which is the case the ladder is for", () => {
    const engine = new ReplayEngine(saved());
    engine.build();
    engine.seek(STEPS);
    // 4,096 is a rung; 4,100 is four steps past one and 4,090 is six short.
    expect(engine.seek(4_100).hash).toBe(truth(4_100));
    expect(engine.seek(4_090).hash).toBe(truth(4_090));
  });

  it("survives being dragged back and forth", () => {
    // A scrubber is not a sequence of forward seeks, and a store that quietly
    // mutated a rung's buffer would pass every test above and fail this one.
    const engine = new ReplayEngine(saved());
    engine.build();
    for (const step of [3_000, 500, 4_800, 120, 4_096, 2_500, 0]) {
      expect(engine.seek(step).hash).toBe(truth(step));
    }
  });

  it("clamps a seek past the end rather than running off it", () => {
    const engine = new ReplayEngine(saved());
    engine.build();
    const frame = engine.seek(STEPS * 10);
    expect(frame.step).toBe(STEPS);
    expect(frame.hash).toBe(truth(STEPS));
  });

  it("reports progress on the way, in the units the bar is drawn in", () => {
    const seen: Array<[number, number]> = [];
    const engine = new ReplayEngine(saved());
    engine.build((step, total) => seen.push([step, total]));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([, total]) => total === STEPS)).toBe(true);
    expect(seen.at(-1)![0]).toBe(STEPS);
  });
});

describe("what the engine takes the length to be", () => {
  it("is the step the world reached, not the step of the last move", () => {
    // A game whose players stopped clicking an hour ago has gone on spawning
    // coins and decaying territory ever since, and a timeline that stopped at
    // the last click would hide the hour that decided it.
    const engine = new ReplayEngine(saved(STEPS));
    expect(engine.total).toBe(STEPS);
  });

  it("stops the timeline where a game that ended actually ended", () => {
    // `steps` is a claim in a file. If the simulation reaches a winner first, the
    // track has to be drawn against the real end or the last tenth of it is a
    // stretch of game that never happened.
    const engine = new ReplayEngine(saved(STEPS));
    engine.build();
    expect(engine.reached).toBeLessThanOrEqual(STEPS);
  });
});
