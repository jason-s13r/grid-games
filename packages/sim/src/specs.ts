// Empire shorthand for anyone assembling a genesis.
//
// `makeGenesis` takes a list of EmpireSpec, and writing those out by hand is
// noise at every call site — the replay tool and the test fixtures both did it
// before this file existed.

import type { BotMode, BotPhase, BotProfile, EmpireSpec } from "./types.js";
import { CONTROL, MEMBER } from "./types.js";
import { STEPS_PER_SECOND } from "./constants.js";

const seconds = (n: number): number => Math.round(n * STEPS_PER_SECOND);

/** One empire of n human seats sharing its territory, each with its own timer. */
export const humans = (n: number): EmpireSpec => ({
  control: CONTROL.HUMAN,
  members: Array.from({ length: n }, () => ({ kind: MEMBER.HUMAN })),
});

export type Difficulty = "easy" | "steady" | "hard";

/** Click-rate bands, in steps. Speed belongs to the phase rather than to the
 *  bot: the same opponent wants quick cheap claims while it is spreading into
 *  empty ground and a long bank before it puts something heavy on a tile it
 *  means to keep. */
const FAST: [number, number] = [seconds(2), seconds(30)];
const MEDIUM: [number, number] = [seconds(30), seconds(60)];
const SLOW: [number, number] = [seconds(60), seconds(90)];

/** How fast a bot clicks in each phase. The same for every difficulty,
 *  because speed is a property of the work rather than of the opponent: you
 *  grab empty ground quickly and cheaply, and you bank properly before putting
 *  something on a tile somebody is holding. A bot is fast to expand and slow to
 *  attack whether it is easy or hard.
 *
 *  Sharing the table is also what makes popMax mean anything. A claim spends
 *  `min(steps waited, popMax)`, so a cap only bites when the bot waits longer
 *  than the cap — and if easy were the one clicking fastest, it would dodge its
 *  own ceiling and the difficulty would evaporate. */
const TEMPO: Record<BotMode, [number, number]> = {
  // Growth wants tiles, not thick ones: cheap claims every few seconds.
  expand: FAST,
  // Everything that puts population somewhere it has to survive banks first.
  attack: SLOW,
  defend: SLOW,
  fortify: SLOW,
  // A pocket is on the upkeep clock, so reconnecting is worth doing before it
  // is worth doing well.
  heal: MEDIUM,
  sleep: FAST,
};

const phase = (mode: BotMode, seconds_: number): BotPhase => ({
  steps: seconds(seconds_),
  rate: TEMPO[mode],
});

/** Three opponents, and what actually separates them.
 *
 *  Strength is the population ceiling, and nothing else. Everyone accrues one
 *  population a step — twelve a second, bot and person alike — and a claim
 *  spends the whole bank, so a claim is worth `min(steps waited, popMax)`. Wait
 *  the 83 seconds a person needs to reach 999 and easy still lands 333: the
 *  same patience, a third of the blow, and the two thirds it grew in the
 *  meantime evaporate. That is legible on the board — you can see what its
 *  tiles cost to take — where an accrual penalty would have just felt like the
 *  bot doing less for no visible reason.
 *
 *  It follows that a cap only bites in the slow phases, which is exactly where
 *  it should: nobody's ceiling is reached while grabbing empty ground at one
 *  claim every few seconds, and everybody's is tested before a blow at held
 *  ground. Easy throws away most of a slow phase. Hard throws away none of it.
 *
 *  Duration is the appetite: time in a phase is its share of the cycle, so
 *  there is no separate weight to keep in step with it. Easy spends a quarter
 *  of its life asleep and barely attacks; hard never sleeps and spends a third
 *  of its time walking at somebody.
 *
 *  Sleep is a real phase rather than an absence of one. Population accrues
 *  through it, so a bot coming out of a sleep opens with a full bank — exactly
 *  what a person returning from an hour away does, and the reason an easy bot
 *  is occasionally dangerous rather than uniformly harmless. */
export const DIFFICULTY: Record<Difficulty, BotProfile> = {
  easy: {
    popMax: 333,
    coins: 20,
    phases: {
      expand: phase("expand", 90),
      attack: phase("attack", 30),
      defend: phase("defend", 45),
      fortify: phase("fortify", 45),
      heal: phase("heal", 30),
      sleep: phase("sleep", 90),
    },
  },
  steady: {
    popMax: 666,
    coins: 60,
    phases: {
      expand: phase("expand", 90),
      attack: phase("attack", 75),
      defend: phase("defend", 45),
      fortify: phase("fortify", 30),
      heal: phase("heal", 30),
      sleep: phase("sleep", 30),
    },
  },
  hard: {
    popMax: 999,
    coins: 95,
    phases: {
      expand: phase("expand", 90),
      attack: phase("attack", 105),
      defend: phase("defend", 45),
      fortify: phase("fortify", 30),
      heal: phase("heal", 30),
    },
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
