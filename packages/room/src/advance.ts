// Moving a simulation forward through a batch, the same way on both ends.
//
// The room and every client call this, so they stop at the same checkpoint
// steps and hash the same states. A checkpoint is every CHECKPOINT_EVERY steps:
// a client reports its hash there, and the room compares it with its own.

import { CONTROL, PHASE, STEPS_PER_SECOND } from "@tessera/sim";
import type { Move, Sim, State } from "@tessera/sim";

/** Five seconds of game time between hash comparisons. */
export const CHECKPOINT_EVERY = STEPS_PER_SECOND * 5;

/** Two minutes of game time between snapshots the room keeps. A multiple of
 *  CHECKPOINT_EVERY, so every snapshot step also has a recorded hash. Each is
 *  a write; the moves since the last one are what a woken room reads, so this
 *  trades one against the other. */
export const SNAPSHOT_EVERY = STEPS_PER_SECOND * 120;

export interface Advanced {
  /** Tiles that changed, for a renderer. */
  dirty: Set<number>;
  /** (step, hash) at every checkpoint crossed. */
  checkpoints: Array<{ step: number; hash: number }>;
}

/** Simulate up to (not including) step `upTo`, applying each move at its own
 *  step. Moves for steps already simulated are ignored, which is the caller's
 *  bug to avoid rather than this function's to repair. */
export function advanceTo(sim: Sim, upTo: number, moves: readonly Move[]): Advanced {
  const byStep = new Map<number, Move[]>();
  for (const move of moves) {
    const list = byStep.get(move.step);
    if (list) list.push(move);
    else byStep.set(move.step, [move]);
  }

  const dirty = new Set<number>();
  const checkpoints: Array<{ step: number; hash: number }> = [];
  while (sim.step < upTo && !sim.ended) {
    for (const tile of sim.advance(byStep.get(sim.step) ?? [])) dirty.add(tile);
    if (sim.step % CHECKPOINT_EVERY === 0) checkpoints.push({ step: sim.step, hash: sim.hash() });
  }
  return { dirty, checkpoints };
}

/** The step a game started at `startedAt` should have reached by `now`. */
export function stepAt(startedAt: number, now: number): number {
  return Math.max(0, Math.floor(((now - startedAt) * STEPS_PER_SECOND) / 1000));
}

/** Nobody is left who could send a move, so the rest of the game is the
 *  simulation's alone and can be run to its end now rather than at the clock's
 *  pace.
 *
 *  That is: the game has an end, joining has closed, and no living empire is
 *  played from outside the simulation. Once the window closes a person cannot
 *  take a seat, and a bot comes in only by invite or approval from an empire's
 *  own seats, so an empire nobody holds stays empty and one that has fallen
 *  can no longer invite anybody. What is left are SimBots, whose moves every
 *  peer derives from the shared seed. A headless bot holding a seat still
 *  sends its own moves, so its empire keeps the game on the clock.
 *
 *  A function of the state alone, so the room and every client agree on the
 *  step it becomes true at. Nothing that can still arrive after that step is a
 *  move the simulation would accept, so a client that runs ahead reaches the
 *  same end as the room. */
export function unattended(state: State): boolean {
  if (state.phase !== PHASE.PLAYING) return false;
  const rules = state.genesis.rules;
  const window = rules.joinWindow ?? 0;
  if (rules.endStep <= 0 || window <= 0 || state.step < window) return false;
  return !state.empires.some((e) => e.alive && e.control === CONTROL.HUMAN && e.members.length > 0);
}

/** The step to simulate to: `upTo`, or, once nobody is left to move, the end. */
export function goalOf(sim: Sim, upTo: number): number {
  return unattended(sim.state) ? Math.max(upTo, sim.state.genesis.rules.endStep + 1) : upTo;
}
