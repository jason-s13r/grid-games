// Watching a game that has already happened.
//
// The third `Driver`, and the strongest evidence that boundary was worth having:
// `Controls`, `mount` and the frame loop take this exactly as they take a solo
// game or a mesh one, and not a line of any of them knows the difference. What a
// replay has that the other two do not is a step it does not choose — the
// scrubber sets it, and the state arrives as a snapshot from the worker — so
// `tick` returns nothing and every input is refused.
//
// Refused rather than absent. A replay is a game object with a real `Sim` in it,
// and the click handlers are the same click handlers; `claim` returning false is
// what makes a click on the board do nothing instead of playing a move into
// somebody's finished game.

import { Sim } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import type { Driver, MoveKind } from "./Driver";

export class ReplayDriver implements Driver {
  readonly sim: Sim;
  /** No seat, and no empire. A replay is watched from outside, the way an
   *  observer peer watches a live game — `Controls` already renders that. */
  readonly empire = 0;
  readonly member = 0;
  readonly online = false;
  /** The clock never drives this, so "running" is a question about the scrubber
   *  rather than about the game. It is false so the pause button reads right. */
  readonly running = false;

  constructor(genesis: Genesis) {
    this.sim = new Sim(genesis);
  }

  /** Put the world at a step the worker computed. The bytes are checked by
   *  arriving at the hash the worker took from the same state — the caller
   *  compares them — which is the same contract a snapshot from a peer has. */
  show(data: ArrayBuffer): void {
    this.sim.restore(data);
  }

  pause(): void {}
  resume(): void {}

  claim(): boolean {
    return false;
  }

  act(_type: MoveKind): boolean {
    return false;
  }

  /** Nothing moves between seeks, so nothing is dirty. The repaint after a seek
   *  is the caller's, because a seek changes every tile and a dirty set of the
   *  whole map is a worse way to say that than a full repaint. */
  tick(): Set<number> {
    return new Set();
  }

  status(): string {
    return `Watching a saved game · step ${this.sim.step}`;
  }
}
