// Determinism is a hard prerequisite for everything downstream.
//
// Peers exchange only inputs and compare hashes; two engines that disagree by
// one bit disagree forever. These are slow on purpose — a few thousand steps is
// where an ordering hazard or a float creeping into game logic actually shows.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, makeGenesis } from "../sim.js";
import { hex } from "../hash.js";
import { STEPS_PER_SECOND } from "../constants.js";
import { humans, simbot } from "./testkit.js";

const spec = () =>
  makeGenesis({ seed: 0xc0ffee, empires: [humans(1), simbot(), simbot(), simbot()] });

describe("determinism", () => {
  let runA: Sim;
  let runB: Sim;

  beforeAll(() => {
    runA = new Sim(spec());
    runB = new Sim(spec());
    for (let i = 0; i < 2000; i++) {
      runA.advance([]);
      runB.advance([]);
    }
  });

  it("two runs of one seed agree", () => {
    expect(hex(runB.hash())).toBe(hex(runA.hash()));
  });

  // Two empty boards would also agree, and agree about nothing.
  it("the game actually progressed", () => {
    expect(runA.state.empires.some((e) => e.tilesOwned > 1)).toBe(true);
  });

  it("a snapshot round-trips to the same hash", () => {
    const clone = new Sim(spec());
    clone.restore(runA.snapshot());
    expect(hex(clone.hash())).toBe(hex(runA.hash()));
  });

  it("a restored sim continues identically", () => {
    const clone = new Sim(spec());
    clone.restore(runA.snapshot());
    const ahead = new Sim(spec());
    ahead.restore(runA.snapshot());
    for (let i = 0; i < 200; i++) {
      ahead.advance([]);
      clone.advance([]);
    }
    expect(hex(clone.hash())).toBe(hex(ahead.hash()));
  });

  it("fastForward equals stepping", () => {
    const stepped = new Sim(spec());
    for (let i = 0; i < 1500; i++) stepped.advance([]);
    const jumped = new Sim(spec());
    jumped.fastForward(1500);
    expect(hex(jumped.hash())).toBe(hex(stepped.hash()));
  });

  // Stats are inside hashed state, so end-of-game figures are consensus by
  // construction rather than something a client reports and a server trusts.
  it("stats reproduce across runs", () => {
    const rerun = new Sim(spec());
    for (let i = 0; i < 2000; i++) rerun.advance([]);
    expect(rerun.summary()).toEqual(runA.summary());
  });
});

describe("offline catch-up", () => {
  // Wall-clock time drives the step number, so a peer that closed the tab last
  // night has to cross a night's worth of steps before it can play. Scheduled
  // events rather than per-tick map scans are what make that possible.
  it("crosses six offline hours in well under a second", () => {
    const sim = new Sim(makeGenesis({ seed: 99, empires: [humans(1), simbot()] }));
    const sixHours = 6 * 60 * 60 * STEPS_PER_SECOND;

    const started = Date.now();
    sim.fastForward(sixHours);
    const elapsed = Date.now() - started;

    expect(sim.step >= sixHours || sim.ended).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });
});
