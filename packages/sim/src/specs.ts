// Empire shorthand for anyone assembling a genesis.
//
// `makeGenesis` takes a list of EmpireSpec, and writing those out by hand is
// noise at every call site — the replay tool and the test fixtures both did it
// before this file existed.

import type { BotProfile, EmpireSpec } from "./types.js";
import { CONTROL, MEMBER } from "./types.js";
import { STEPS_PER_SECOND } from "./constants.js";

const seconds = (n: number): number => Math.round(n * STEPS_PER_SECOND);

/** One empire of n human seats sharing its territory, each with its own timer. */
export const humans = (n: number): EmpireSpec => ({
  control: CONTROL.HUMAN,
  members: Array.from({ length: n }, () => ({ kind: MEMBER.HUMAN })),
});

export type Difficulty = "easy" | "steady" | "hard";

/** Three bots, and the arithmetic that makes them different.
 *
 *  A seat banks one population a step and a claim spends the lot, so a claim is
 *  worth `min(interval, popMax)` — which makes the cap the only real strength
 *  dial there is. Everything an empire spends in a minute is capped by what it
 *  grew in that minute, so a bot cannot be made stronger by clicking more; it
 *  can only be made *weaker* by banking less than it grew and pouring away the
 *  difference. That is what an easy bot does.
 *
 *    easy    banks 15, claims every 5s — a quarter of what it grew, and the
 *            rest evaporates. Sprawls widely in tiles worth 15 apiece, which
 *            anybody can take straight back, and it spends most of its phases
 *            pottering around its own capital.
 *    steady  banks 50, claims every 6s — two thirds of its growth, in tiles
 *            worth taking seriously.
 *    hard    banks everything, claims every 8s — full efficiency in the
 *            heaviest blows of the three. A 96 tile with three friendly
 *            neighbours costs an attacker 384 to take, and it takes nearly
 *            every coin it can reach, which is the one way in the game to gain
 *            ground faster than population accrues.
 *
 *  Over five minutes on a medium map that comes out around 1900, 4200 and 5000
 *  population held, in tiles averaging 54, 85 and 119 — a scale in what a bot
 *  is worth fighting, not in what it is allowed to do.
 *
 *  Weights are [expand, attack, defend, home]. */
export const DIFFICULTY: Record<Difficulty, BotProfile> = {
  easy: {
    popMax: 15,
    interval: seconds(5),
    weights: [2, 1, 2, 4],
    coins: 20,
  },
  steady: {
    popMax: 50,
    interval: seconds(6),
    weights: [3, 2, 2, 1],
    coins: 60,
  },
  hard: {
    popMax: 999,
    interval: seconds(8),
    weights: [4, 4, 2, 0],
    coins: 95,
  },
};

/** An empire played by the simulation itself, from the shared seed. It costs no
 *  bandwidth and cannot drop, which is what makes it the filler for an empty
 *  seat or a single-player game.
 *
 *  Its difficulty is in the genesis record like everything else about it, so
 *  "the bots were on hard" is a fact of the game rather than a thing somebody
 *  remembers afterwards. */
export const simbot = (level: Difficulty = "steady"): EmpireSpec => ({
  control: CONTROL.SIMBOT,
  members: [{ kind: MEMBER.BOT, bot: DIFFICULTY[level] }],
});
