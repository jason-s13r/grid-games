// How long a game runs, and the two windows that have to move with it.
//
// One function rather than an enum of blessed lengths: a host who wants 47
// minutes gets 47 minutes. What a host must not be able to do is set an end
// without the abandonment window scaling to match, because a 3-hour window in
// a 10-day game is a losing condition for going to bed — three teams sleep,
// one insomniac is the only empire "present", and victory.ts hands them
// WIN.LAST_ROSTER by 03:00 without a tile changing hands.
//
// So the host sets one number and this file derives the other two. That is the
// whole reason a duration is a function and not a field.

import { days, hours } from "./constants.js";
import type { Rules } from "./types.js";

/** The three numbers a duration decides. Nothing else about a game changes. */
export type DurationRules = Pick<Rules, "endStep" | "joinWindow" | "abandonWindow">;

/** The longest game this build composes. Policy, not encoding: every
 *  step-valued field is a u32, which carries 133x this (11 years), and the
 *  real constraint is the archive — each seat signs a heartbeat every 30 s and
 *  those cannot be elided from the log, so a 31-day four-seat game is ~357,000
 *  signed records and ~70 MB of JSON, which is what a retaining browser tab
 *  holds in one array. Raising it is this constant, one UI string, and an
 *  answer to that arithmetic — nothing else moves.
 *
 *  Deliberately *not* checked in `inspectGenesis`: an over-long game cheats
 *  nobody but the people who chose it, and welding the cap into the join path
 *  would make raising it later a protocol bump. See MIN_ABANDON_WINDOW for the
 *  rule that does go there, and why the two differ. */
export const MAX_DURATION = days(31);

/** The shortest abandonment window any game may have, and the floor
 *  `durationRules` clamps to. Exported because `inspectGenesis` checks the
 *  same number — a clamp and a check that could drift apart are a bug with a
 *  waiting period. */
export const MIN_ABANDON_WINDOW = hours(3);

/** A third of 240 hours is a window nothing could fire inside. A table that
 *  has genuinely stopped playing should end. */
const MAX_ABANDON_WINDOW = hours(36);

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);

/** The three rules a chosen length implies.
 *
 *  `joinShare` is the fraction of the game the door stays open for, because
 *  "an hour" means something different in a 15-minute game and a 10-day one.
 *  A third reads right at both ends; `0` seals the table.
 *
 *  Note what `durationRules(0)` returns: field for field, `DEFAULT_RULES`
 *  today. The open-ended case needs no branch because the clamp produces it. */
export function durationRules(request: number, joinShare = 1 / 3): DurationRules {
  // Clamped, not thrown on: a caller asking for two years gets 31 days.
  const endStep = clamp(request, 0, MAX_DURATION);
  return {
    endStep,
    // 0 means always open and is what every existing record says, so "closed"
    // cannot be 0. Step 0 is the composition of the record itself, so a window
    // that shuts at step 1 is the honest half-open reading of "no late joins".
    joinWindow: joinShare === 0 ? 1 : Math.round(endStep * joinShare),
    // A third of the game, floored at 3 h and capped at 36 h. The floor is
    // what makes short games safe: under about nine hours the abandonment rule
    // never decides anything, which is correct, because nobody goes to bed
    // inside a 15-minute game and the rule exists for the ones where they do.
    abandonWindow: clamp(
      Math.round(endStep / 3),
      MIN_ABANDON_WINDOW,
      MAX_ABANDON_WINDOW,
    ),
  };
}
