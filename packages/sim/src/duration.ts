// How long a game runs, and the two windows that have to move with it.
//
// One function rather than an enum of blessed lengths: a host who wants 47
// minutes gets 47 minutes. What a host must not be able to do is set an end
// and leave the abandonment rule as it was, because a 3-hour window in a
// 10-day game is a losing condition for going to bed — three teams sleep, one
// insomniac is the only empire "present", and victory.ts hands them
// WIN.LAST_ROSTER by 03:00 without a tile changing hands.
//
// A game with an end has no abandonment at all: an empire may sit idle until
// the timeout, and the timeout is what stops the game waiting for somebody
// who has left. Scaling the window (a third of the game, capped at 36 h) was
// tried first, and under it a 10-day game could end on day three, as soon as
// one empire was the only one opened in the last 36 hours. The window stays
// for an open-ended game, which has nothing else to end it.
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

/** The shortest abandonment window any game may have, and the one
 *  `durationRules` gives an open-ended game. Exported because `inspectGenesis`
 *  checks the same number — a rule and a check that could drift apart are a
 *  bug with a waiting period. */
export const MIN_ABANDON_WINDOW = hours(3);

/** `abandonWindow` for a game that has no abandonment: one with an end.
 *  Accepted by `inspectGenesis` alongside anything at or above the floor, and
 *  read by every build as "nobody is ever the only one present" — a window of
 *  zero steps holds no heartbeat, so `present` is empty and `LAST_ROSTER`
 *  cannot fire. A build that ran such a record would agree; an older
 *  `inspectGenesis` refuses it as below the floor, so an old peer declines to
 *  join rather than desyncing, which is why this needs no protocol bump. */
export const NO_ABANDONMENT = 0;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);

/** The three rules a chosen length implies.
 *
 *  `joinShare` is the fraction of the game the door stays open for, because
 *  "an hour" means something different in a 15-minute game and a 10-day one.
 *  A third reads right at both ends; `0` seals the table.
 *
 *  Note what `durationRules(0)` returns: field for field, `DEFAULT_RULES`
 *  today. */
export function durationRules(request: number, joinShare = 1 / 3): DurationRules {
  // Clamped, not thrown on: a caller asking for two years gets 31 days.
  const endStep = clamp(request, 0, MAX_DURATION);
  return {
    endStep,
    // 0 means always open and is what every existing record says, so "closed"
    // cannot be 0. Step 0 is the composition of the record itself, so a window
    // that shuts at step 1 is the honest half-open reading of "no late joins".
    joinWindow: joinShare === 0 ? 1 : Math.round(endStep * joinShare),
    // Off for any game with an end, which the timeout finishes; the floor for
    // an open-ended one, which is what DEFAULT_RULES has always said.
    abandonWindow: endStep > 0 ? NO_ABANDONMENT : MIN_ABANDON_WINDOW,
  };
}
