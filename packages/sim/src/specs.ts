// Empire shorthand for anyone assembling a genesis.
//
// `makeGenesis` takes a list of EmpireSpec, and writing those out by hand is
// noise at every call site — the replay tool and the test fixtures both did it
// before this file existed.

import type { EmpireSpec } from "./types.js";
import { CONTROL, MEMBER } from "./types.js";

/** One empire of n human seats sharing its territory, each with its own timer. */
export const humans = (n: number): EmpireSpec => ({
  control: CONTROL.HUMAN,
  members: Array.from({ length: n }, () => ({ kind: MEMBER.HUMAN })),
});

/** An empire played by the simulation itself, from the shared seed. It costs no
 *  bandwidth and cannot drop, which is what makes it the filler for an empty
 *  seat or a single-player game. */
export const simbot = (): EmpireSpec => ({
  control: CONTROL.SIMBOT,
  members: [{ kind: MEMBER.BOT }],
});
