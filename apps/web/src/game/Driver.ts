// What the view needs from a game, whichever kind it is.
//
// Local play and mesh play differ in where moves come from and in nothing else:
// the same simulation, the same dirty-tile contract, the same sidebar. Naming
// that boundary keeps Controls and main.ts from knowing which one they have.

import type { Sim } from "@tessera/sim";
import type { MOVE } from "@tessera/sim";

export type MoveKind = (typeof MOVE)[keyof typeof MOVE];

export interface Driver {
  readonly sim: Sim;
  /** The empire this client plays, and which seat within it. */
  readonly empire: number;
  readonly member: number;
  readonly running: boolean;
  readonly online: boolean;

  pause(): void;
  resume(): void;
  claim(x: number, y: number): boolean;
  act(type: MoveKind, x?: number, y?: number): boolean;
  /** Advance to wall-clock time; returns the tiles the renderer must repaint. */
  tick(): Set<number>;
  /** One line for the status bar: who we are waiting for, or nothing at all. */
  status(): string;
}
