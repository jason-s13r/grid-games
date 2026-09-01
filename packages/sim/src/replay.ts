#!/usr/bin/env node
// Headless replay.
//
// Given a seed and a step count it runs the simulation and prints the final
// state hash. Two peers, or Node and a browser, must agree on that number for
// the same inputs — everything in Phase C rests on it, and this is how you
// check it by hand.
//
// The rules and determinism suites moved to src/test; this is the tool, not
// the tests.

import { Sim, makeGenesis } from "./sim.js";
import { hex } from "./hash.js";
import { humans, simbot } from "./specs.js";

function run(): void {
  const seed = Number(process.argv[3] ?? 0xc0ffee) >>> 0;
  const steps = Number(process.argv[4] ?? 3000);

  const sim = new Sim(
    makeGenesis({ seed, empires: [humans(1), simbot(), simbot(), simbot()] }),
  );
  sim.fastForward(steps);

  console.log(`seed      ${seed}`);
  console.log(`steps     ${sim.step}`);
  console.log(`hash      ${hex(sim.hash())}`);
  console.log(`phase     ${sim.ended ? `ended, winner ${sim.state.winner}` : "playing"}`);
  console.table(
    sim.summary().map((e) => ({
      empire: e.id,
      alive: e.alive,
      tiles: e.tilesOwned,
      peak: e.peakTiles,
      pop: e.popTotal,
      coins: e.coins.bronze + e.coins.silver + e.coins.gold,
      cascade: e.largestCascade.tiles,
    })),
  );
}

run();
