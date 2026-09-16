// The reader's event stream, derived from what is already hashed.
//
// The value of this file is one property: **the journal invents nothing**. Every
// line it produces is a difference between two sets of counters that live
// inside the state hash, so two peers at the same step derive the same lines
// without anybody arranging it. The tests below are mostly about what it must
// *not* say — on a quiet step, across an adopted snapshot, about a counter that
// did not move.

import { describe, expect, it } from "vitest";
import { STAT } from "../constants.js";
import { isUpkeepStep, journal, tally } from "../journal.js";
import type { Tally } from "../journal.js";
import { Sim, makeGenesis } from "../sim.js";
import { humans, simbot } from "../specs.js";
import { PHASE, WIN } from "../types.js";

const game = () =>
  new Sim(
    makeGenesis({
      seed: 4242,
      map: { width: 24, height: 24 },
      empires: [humans(1), humans(1), simbot("steady")],
    }),
  );

/** A tally with one counter moved, which is what one event looks like. */
const moved = (base: Tally, empire: number, slot: number, by: number): Tally => ({
  ...base,
  empires: base.empires.map((one) =>
    one.id === empire ? { ...one, stats: one.stats.map((n, at) => (at === slot ? n - by : n)) } : one,
  ),
});

describe("the journal", () => {
  it("says nothing when nothing moved", () => {
    const sim = game();
    expect(journal(tally(sim.state), sim.state)).toEqual([]);
  });

  it("says nothing across a hundred quiet steps but the counters that did move", () => {
    const sim = game();
    const before = tally(sim.state);
    for (let i = 0; i < 100; i++) sim.advance();
    const events = journal(before, sim.state);
    // Bots play, so something happened — but not a line per step.
    expect(events.length).toBeLessThan(100);
    for (const event of events) expect(event.step).toBe(sim.state.step);
  });

  it.each([
    ["took", STAT.TILES_TAKEN, 3],
    ["annexed", STAT.ANNEXED, 12],
    ["cascade", STAT.CASCADE_TILES, 7],
    ["diamond", STAT.DIAMONDS, 2],
  ])("turns a %s counter into one line with its count", (kind, slot, by) => {
    const sim = game();
    const now = tally(sim.state);
    const events = journal(moved(now, 1, slot, by), sim.state);
    expect(events).toContainEqual({ step: sim.state.step, kind, empire: 1, count: by });
  });

  // Three counters, one line. Which metal is worth saying; three separate lines
  // for one step is not.
  it("folds the three coin counters into one line", () => {
    const sim = game();
    let before = tally(sim.state);
    before = moved(before, 1, STAT.COINS_BRONZE, 1);
    before = moved(before, 1, STAT.COINS_SILVER, 1);
    before = moved(before, 1, STAT.COINS_GOLD, 1);
    const coins = journal(before, sim.state).filter((one) => one.kind === "coin");
    expect(coins).toHaveLength(1);
    expect(coins[0]!.count).toBe(3);
  });

  it.each([
    ["bridge", STAT.BRIDGES],
    ["ladder", STAT.LADDERS],
    ["march", STAT.MARCHES],
  ])("turns a %s into one line with no count", (kind, slot) => {
    const sim = game();
    const events = journal(moved(tally(sim.state), 2, slot, 1), sim.state);
    expect(events).toContainEqual({ step: sim.state.step, kind, empire: 2 });
  });

  it("notices an empire that was alive and is not", () => {
    const sim = game();
    const now = tally(sim.state);
    const before = {
      ...now,
      empires: now.empires.map((one) => (one.id === 2 ? { ...one, alive: 1 } : one)),
    };
    sim.state.empires[1]!.alive = 0;
    expect(journal(before, sim.state)).toContainEqual({
      step: sim.state.step,
      kind: "eliminated",
      empire: 2,
    });
  });

  it("notices a game ending, once", () => {
    const sim = game();
    const before = tally(sim.state);
    sim.state.phase = PHASE.ENDED;
    sim.state.winner = 1;
    sim.state.winReason = WIN.LAST_EMPIRE;

    const events = journal(before, sim.state);
    expect(events).toContainEqual({
      step: sim.state.step,
      kind: "ended",
      empire: 1,
      reason: WIN.LAST_EMPIRE,
    });
    // And not again, now that it has already ended.
    expect(journal(tally(sim.state), sim.state)).toEqual([]);
  });

  // The line the guard exists to prevent: *Vermilion annexed 1,412 tiles.* A
  // resumed peer never simulated the steps that built its state, so the roster
  // length is the cheap signal that a tally belongs to a different game shape.
  it("refuses to diff two tallies of different shapes", () => {
    const sim = game();
    const now = tally(sim.state);
    const shorter = { ...now, empires: now.empires.slice(1) };
    expect(journal(shorter, sim.state)).toEqual([]);
  });
});

describe("the upkeep metronome", () => {
  // No stat counts a sweep and none should — but `scheduleUpkeep` pushes
  // `from + upkeepInterval` with no RNG draw in it, so "this is an upkeep step"
  // is a fact of state readable *before* the step runs.
  it("is readable from the queue rather than emitted", () => {
    const sim = game();
    const interval = sim.state.genesis.rules.upkeepInterval;
    let seen = 0;
    for (let i = 0; i < interval * 2 + 2; i++) {
      if (isUpkeepStep(sim.state)) seen++;
      sim.advance();
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("reports what the board lost, and only when asked", () => {
    const sim = game();
    const now = tally(sim.state);
    const before = {
      ...now,
      empires: now.empires.map((one) => ({ ...one, popTotal: one.popTotal + 100 })),
    };
    // Not an upkeep step: the population delta is somebody's spending.
    expect(journal(before, sim.state).some((one) => one.kind === "upkeep")).toBe(false);
    // On one, it is the sweep.
    expect(journal(before, sim.state, true)).toContainEqual({
      step: sim.state.step,
      kind: "upkeep",
      empire: 0,
      count: 300,
    });
  });
});
