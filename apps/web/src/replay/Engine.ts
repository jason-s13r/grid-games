// Replaying a saved game, and being able to go backwards through it.
//
// Everything in this file is ordinary synchronous work that happens to take
// minutes. Twelve steps a second means an hour is 43,200 steps, three days is
// 3,110,400 and ten days is 10,368,000 — so nothing here may run on the thread
// that paints, and the class is deliberately free of `postMessage` so that the
// worker around it (`worker.ts`) is glue and this is testable under Node.
//
// The order is verify, then build, and it is that way round on purpose: the
// expensive thing is a replay, and spending a minute building a timeline for a
// log whose signatures turn out to be forged is a minute spent on a lie. The
// cost of that ordering is a second full pass — `verifyArchive` owns its own
// replay loop and there is no way to keep snapshots out of it — and the scrubber
// says which phase it is in rather than showing one bar that stalls halfway.

import { Sim } from "@tessera/sim";
import type { Move } from "@tessera/sim";
import { SnapshotStore, verifyArchive } from "@tessera/net";
import type { ArchivedGame, Verdict } from "@tessera/net";
import { ladderFor, rungsFor } from "./ladder";

/** Steps between progress reports while building. Small enough that a bar moves
 *  smoothly on a short game, large enough that the reporting is not itself the
 *  cost on a long one. */
export const CHUNK = 8192;

/** The state at a step, as it crosses back to the page. */
export interface Frame {
  step: number;
  hash: number;
  data: ArrayBuffer;
}

export class ReplayEngine {
  /** The step the game reached, which is not the step of the last move: a game
   *  whose players stopped clicking an hour ago has gone on spawning coins and
   *  decaying territory ever since. */
  readonly total: number;
  readonly ladder: number;

  private readonly sim: Sim;
  private readonly store: SnapshotStore;
  /** The log indexed once. `Sim.fastForward` builds this map on every call, and
   *  a seek that rebuilds an index over three million moves is a seek that costs
   *  more in bookkeeping than in simulation. */
  private readonly byStep = new Map<number, Move[]>();
  private built = 0;

  constructor(game: ArchivedGame) {
    const moves = game.moveLog.map((entry) => ("move" in entry ? entry.move : entry));
    for (const move of moves) {
      const list = this.byStep.get(move.step);
      if (list) list.push(move);
      else this.byStep.set(move.step, [move]);
    }

    const last = moves.reduce((max, move) => Math.max(max, move.step), 0);
    this.total = game.steps ?? last + 1;
    this.ladder = ladderFor(this.total);
    this.sim = new Sim(game.genesis);
    this.store = new SnapshotStore(rungsFor(this.total, this.ladder));
  }

  /** Whether the log is genuine, and whether it reaches the state it claims.
   *
   *  Static because there is no point constructing an engine for an archive that
   *  is not one, and separate from `build` because it is the answer a player
   *  should have before they are shown anything. */
  static check(game: ArchivedGame): Promise<Verdict> {
    return verifyArchive(game);
  }

  /** How far the timeline reaches so far. */
  get reached(): number {
    return this.built;
  }

  /** One pass forward at full speed, keeping a rung every `ladder` steps.
   *
   *  Not cancellable from inside: a worker cannot read its own message queue
   *  while this runs, and the page cancels by terminating it. That is the whole
   *  of the cancel story and it is simpler than a cooperative one — there is no
   *  state to unwind, because nothing outside the worker has been told anything
   *  yet. */
  build(onProgress?: (step: number, total: number) => void): void {
    this.keep();
    while (this.sim.step < this.total && !this.sim.ended) {
      const until = Math.min(this.sim.step + CHUNK, this.total);
      while (this.sim.step < until && !this.sim.ended) {
        this.sim.advance(this.byStep.get(this.sim.step) ?? []);
        // Checked inside the loop rather than at chunk boundaries: a rung is
        // defined by the step it sits on, and a chunk that straddles one would
        // silently shift the whole ladder.
        if (this.sim.step % this.ladder === 0) this.keep();
      }
      this.built = this.sim.step;
      onProgress?.(this.sim.step, this.total);
    }
    // A game that ended before its nominal length is at its real end, and that
    // is the number the scrubber's track must be drawn against.
    this.built = this.sim.step;
    this.keep();
  }

  /** The state at a step, however far back it is.
   *
   *  This is the whole point of the ladder: restore the newest rung at or before
   *  the step, then advance at most `ladder` times. Going backwards costs the
   *  same as going forwards a little, which is what makes a scrubber a scrubber
   *  rather than a rewind button that reloads the page. */
  seek(step: number): Frame {
    const want = Math.max(0, Math.min(step, this.built));
    const rung = this.store.at(want);
    // There is always a rung at zero, so this is a guard against a store that
    // was mis-sized rather than an expected branch — and replaying from the
    // genesis record is the correct answer if it ever fires.
    if (rung) this.sim.restore(rung.data);
    else this.sim.restore(new Sim(this.sim.state.genesis).snapshot());

    while (this.sim.step < want && !this.sim.ended) {
      this.sim.advance(this.byStep.get(this.sim.step) ?? []);
    }
    return { step: this.sim.step, hash: this.sim.hash(), data: this.sim.snapshot() };
  }

  private keep(): void {
    this.store.put({ step: this.sim.step, hash: this.sim.hash(), data: this.sim.snapshot() });
  }
}
