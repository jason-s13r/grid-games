// Empire shorthand for anyone assembling a genesis.
//
// `makeGenesis` takes a list of EmpireSpec, and writing those out by hand is
// noise at every call site — the replay tool and the test fixtures both did it
// before this file existed.

import type { BotMode, BotPhase, BotProfile, EmpireSpec } from "./types.js";
import { CONTROL, MEMBER } from "./types.js";
import { MODES } from "./policy.js";
import { STEPS_PER_SECOND } from "./constants.js";

/** Seconds in, steps out. Every duration a bot carries is a step count; this
 *  exists only so the table below reads in the units a person tunes it in. */
const fromSeconds = (n: number): number => Math.round(n * STEPS_PER_SECOND);

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
const FAST: [number, number] = [fromSeconds(2), fromSeconds(30)];
const MEDIUM: [number, number] = [fromSeconds(30), fromSeconds(60)];
const SLOW: [number, number] = [fromSeconds(60), fromSeconds(90)];

/** How fast a bot clicks in each phase. The same for every difficulty,
 *  because speed is a property of the work rather than of the opponent: you
 *  grab empty ground quickly and cheaply, and you bank properly before putting
 *  something on a tile somebody is holding. A bot is fast to expand and slow to
 *  attack whether it is easy or hard.
 *
 *  Sharing the table is also what makes popMax mean anything. A claim spends
 *  `min(steps waited, popMax)`, so a cap only bites when the bot waits longer
 *  than the cap — and if easy were the one clicking fastest, it would dodge its
 *  own ceiling and the difficulty would evaporate.
 *
 *  This is also the one thing a hand-tuned bot cannot move, and for the same
 *  reason: `BotTuning` names every number a player may turn, and a tempo knob
 *  beside a strength knob would let the second undo the first. */
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

const phase = (mode: BotMode, seconds: number): BotPhase => ({
  steps: fromSeconds(seconds),
  rate: TEMPO[mode],
});

/** A bot written in the units a person thinks in: a population ceiling, an
 *  appetite for coins, and seconds spent in each phase.
 *
 *  `BotProfile` is what the simulation reads and `BotTuning` is what a person
 *  sets, and they are deliberately not the same shape. A profile carries a
 *  click-rate band per phase, which is shared across every difficulty and must
 *  stay that way; a tuning carries no rate at all, so nothing that comes out of
 *  this file can dodge its own ceiling by clicking faster. */
export interface BotTuning {
  /** Population this bot banks to. The sim clamps it to `rules.popMax`, so
   *  asking for more than the game allows holds the seat back rather than
   *  lifting it. */
  popMax: number;
  /** Percent chance of taking an adjacent coin instead of following the
   *  phase — the appetite for spidering outward. */
  coins: number;
  /** Seconds spent in each phase. `0` means the bot never enters it, which is
   *  how a bot that never sleeps is written; all six at zero is a bot that
   *  does nothing at all, and that is a legitimate thing to ask for. */
  phases: Record<BotMode, number>;
}

/** The three presets, in the units they were tuned in. Exported because a
 *  "customise" control has to start somewhere, and the honest place to start
 *  is whichever preset the player was already looking at. */
export const TUNING: Record<Difficulty, BotTuning> = {
  easy: {
    popMax: 333,
    coins: 20,
    phases: { expand: 90, attack: 30, defend: 45, fortify: 45, heal: 30, sleep: 90 },
  },
  steady: {
    popMax: 666,
    coins: 60,
    phases: { expand: 90, attack: 75, defend: 45, fortify: 30, heal: 30, sleep: 30 },
  },
  hard: {
    popMax: 999,
    coins: 95,
    phases: { expand: 90, attack: 105, defend: 45, fortify: 30, heal: 30, sleep: 0 },
  },
};

/** A tuning as the simulation reads it.
 *
 *  Phases at zero are dropped rather than written as `steps: 0`, because
 *  "never sleeps" and "sleeps for no time" are the same bot and should be the
 *  same record — a genesis is content-addressed, so two spellings of one game
 *  would be two game ids. */
export function tuneBot(tuning: BotTuning): BotProfile {
  const phases: Partial<Record<BotMode, BotPhase>> = {};
  for (const mode of MODES) {
    const seconds = tuning.phases[mode] ?? 0;
    if (seconds > 0) phases[mode] = phase(mode, seconds);
  }
  return {
    popMax: Math.max(1, Math.round(tuning.popMax)),
    coins: Math.min(100, Math.max(0, Math.round(tuning.coins))),
    phases,
  };
}

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
  easy: tuneBot(TUNING.easy),
  steady: tuneBot(TUNING.steady),
  hard: tuneBot(TUNING.hard),
};

/** How hard a bot empire plays: one of the three presets, or a profile somebody
 *  dialled in themselves.
 *
 *  Widening this widens no trust. A bot profile has never been checked by
 *  `inspectGenesis` and could never usefully be: every number in one is already
 *  bounded where it is read — `popMax` is clamped to `rules.popMax` when the
 *  seat is created, a phase's rate is floored at `rules.botActionInterval` on
 *  every action, and `coins` is a percentage. The strongest profile anybody can
 *  write is therefore an opponent rather than an exploit, it is in the genesis
 *  record for every peer to read before agreeing to play, and a host who makes
 *  the bots brutal has made them brutal to themselves as well. */
export type BotChoice = Difficulty | BotProfile;

/** An empire played by the simulation itself, from the shared seed. It costs no
 *  bandwidth and cannot drop, which is what makes it the filler for an empty
 *  seat or a single-player game.
 *
 *  Its difficulty is in the genesis record like everything else about it, so
 *  "the bots were on hard" is a fact of the game rather than a thing somebody
 *  remembers afterwards. */
export const simbot = (level: BotChoice = "steady"): EmpireSpec => ({
  control: CONTROL.SIMBOT,
  members: [{ kind: MEMBER.BOT, bot: typeof level === "string" ? DIFFICULTY[level] : level }],
});
