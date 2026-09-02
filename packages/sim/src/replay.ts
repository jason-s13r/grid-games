#!/usr/bin/env node
// Headless replay.
//
// Three modes, one output. `replay [seed] [steps]` plays a fresh seeded game
// and prints its final state hash. `replay --log <file>` takes a recorded game
// — the genesis record and the moves that were applied to it — and prints the
// hash that log arrives at. `replay --record <file>` writes one, which is how
// the cross-environment fixture in src/test/fixtures is made.
//
// The second is the load-bearing one. Everything downstream rests on two peers
// agreeing on that number for the same inputs, and the ways they can fail to
// are not visible from inside one engine: a float in the game logic, a Set
// iterated in insertion order, a division that rounds differently. Node and a
// browser running this same log and printing the same number is the check, and
// the hash is small enough to compare by eye or in CI.
//
// The rules and determinism suites live in src/test; this is the tool.

import { readFileSync, writeFileSync } from "node:fs";
import { Sim, makeGenesis } from "./sim.js";
import { hex } from "./hash.js";
import { Rng } from "./rng.js";
import { policy } from "./policy.js";
import { humans, simbot } from "./specs.js";
import type { Genesis, Move } from "./types.js";

/** What a recorded game is: the record everything derives from, and the inputs
 *  in the order they were applied. Moves may be bare or still in their signed
 *  envelopes — an archive keeps the signatures so a log can be re-verified
 *  rather than merely believed, and replay does not care either way. */
interface Recorded {
  genesis: Genesis;
  moveLog: Array<Move | { move: Move }>;
  /** Where the recording stopped. A log describes a world at a step, not at
   *  its last move: coins spawn and territory decays long after anybody last
   *  clicked, so stopping at the final move would land somewhere else. */
  steps?: number;
  hash?: string;
}

function unwrap(entry: Move | { move: Move }): Move {
  return "move" in entry ? entry.move : entry;
}

function report(sim: Sim, label: string): void {
  console.log(`source    ${label}`);
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

function fromLog(path: string, to?: number): void {
  const recorded = JSON.parse(readFileSync(path, "utf8")) as Recorded;
  if (!recorded?.genesis || !Array.isArray(recorded.moveLog)) {
    throw new Error(`${path} is not a recorded game: expected { genesis, moveLog }`);
  }

  const moves = recorded.moveLog.map(unwrap);
  const last = moves.reduce((max, move) => Math.max(max, move.step), 0);
  const target = to ?? recorded.steps ?? last + 1;

  const sim = new Sim(recorded.genesis);
  sim.fastForward(target, moves);
  report(sim, `${path} (${moves.length} moves)`);

  // A recorded hash is a claim about this engine, so check it here rather than
  // leaving it to whoever reads the output.
  if (recorded.hash) {
    const got = hex(sim.hash());
    console.log(`recorded  ${recorded.hash}`);
    if (got !== recorded.hash) {
      console.error(`MISMATCH  this engine reached ${got}, the log says ${recorded.hash}`);
      process.exitCode = 1;
    }
  }
}

/** Record a game the way a mesh peer would: bot empires derive their moves
 *  from the shared stream and so leave nothing in the log, while the human
 *  empire's moves are decided *outside* that stream — as a real player's are —
 *  and written down. The log is therefore load-bearing rather than decorative:
 *  replaying it without applying the moves reaches a different hash. */
function record(path: string, seed: number, steps: number): void {
  const genesis = makeGenesis({
    seed,
    empires: [humans(1), simbot(), simbot(), simbot()],
  });
  const sim = new Sim(genesis);

  // Its own stream, never the simulation's: a draw made here and nowhere else
  // is exactly the desync a PeerBot is careful to avoid.
  const hand = new Rng(seed ^ 0x5eed);
  const moveLog: Move[] = [];
  let seq = 0;

  while (sim.step < steps && !sim.ended) {
    const moves: Move[] = [];
    const empire = sim.state.empires[0]!;
    if (empire.alive && sim.step % 6 === 0) {
      const move = policy(sim.state, empire, 0, hand);
      if (move && sim.validate({ ...move, seq })) {
        const stamped = { ...move, seq: seq++ };
        moves.push(stamped);
        moveLog.push(stamped);
      }
    }
    sim.advance(moves);
  }

  const fixture = {
    note:
      "A recorded game, replayed by both the Node and browser suites. " +
      "Regenerate with: pnpm --filter @tessera/sim replay --record <path>",
    genesis,
    steps: sim.step,
    hash: hex(sim.hash()),
    moveLog,
  };
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  report(sim, `recorded to ${path} (${moveLog.length} moves)`);
}

function fromSeed(seed: number, steps: number): void {
  const sim = new Sim(
    makeGenesis({ seed, empires: [humans(1), simbot(), simbot(), simbot()] }),
  );
  sim.fastForward(steps);
  report(sim, `seed ${seed}`);
}

function run(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };

  const positional = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const seed = Number(flag("--seed") ?? positional[0] ?? 0xc0ffee) >>> 0;
  const steps = Number(flag("--steps") ?? positional[1] ?? 3000);

  const log = flag("--log");
  if (log) {
    const to = flag("--to");
    fromLog(log, to === undefined ? undefined : Number(to));
    return;
  }

  const target = flag("--record");
  if (target) {
    record(target, seed, steps);
    return;
  }

  fromSeed(seed, steps);
}

run();
