// Win conditions and elimination.
//
// Presence is derived from the log, never from sockets. Peers genuinely
// disagree about who is reachable, so evaluating "last player remaining" from
// connection state would have two peers computing different winners — a
// guaranteed desync. Members emit signed HEARTBEATs instead, making liveness a
// deterministic function of state.
//
// An empire nobody has claimed is outside every count here, and the reason is
// the same one: it is territory, and territory does not go quiet. `silentFor`
// on an empire with no members is "silent since step zero", so counted as a
// player it would make everybody else absent-by-comparison and hand
// `WIN.LAST_ROSTER` to whoever beat first. Counted as alive it holds its capital
// forever and `LAST_EMPIRE` could never fire at all. Neither is a rule anybody
// would write down; both are what happens if you forget to write one.

import { ELIMINATION, PHASE, WIN } from "./types.js";
import type { Empire } from "./types.js";
import { isVacant } from "./state.js";
import type { State } from "./state.js";

export function isLive(state: State, empire: Empire): boolean {
  const window = state.genesis.rules.livenessWindow;
  for (const m of empire.members) {
    if (state.step - m.lastBeat <= window) return true;
  }
  return false;
}

/** Steps since this empire last had any live member. */
function silentFor(state: State, empire: Empire): number {
  let latest = -1;
  for (const m of empire.members) latest = Math.max(latest, m.lastBeat);
  return latest < 0 ? state.step : state.step - latest;
}

function eliminated(state: State, empire: Empire): boolean {
  if (state.genesis.rules.elimination === ELIMINATION.ANNIHILATION) {
    return empire.tilesOwned === 0;
  }
  return state.owner[empire.capital] !== empire.id;
}

export function checkVictory(state: State): void {
  if (state.phase !== PHASE.PLAYING) return;
  const rules = state.genesis.rules;

  for (const empire of state.empires) {
    if (!empire.alive) continue;
    if (eliminated(state, empire)) {
      empire.alive = 0;
      empire.eliminatedAt = state.step;
    }
  }

  // Unclaimed empires are excluded from every count below. Left in, a vacancy
  // holds its capital forever and `LAST_EMPIRE` could never fire; worse,
  // `silentFor` reports it silent from step zero, so `present` drops to one and
  // `WIN.LAST_ROSTER` is handed to whoever is awake on the first pass. That is
  // the same trap 0002 closed for sleeping teams, arriving through a different
  // door.
  const alive = state.empires.filter((e) => e.alive && !isVacant(e));

  if (alive.length === 1) {
    end(state, alive[0]!.id, WIN.LAST_EMPIRE);
    return;
  }
  if (alive.length === 0) {
    // Every claimed empire is gone and only vacancies remain: the game is over
    // and nobody won it, which is what a winner of zero already means here.
    end(state, 0, WIN.LAST_EMPIRE);
    return;
  }

  // Abandonment. The window is deliberately hours of game time: being asleep is
  // not being defeated, and a short window would reward waiting until an
  // opponent's team is offline — exactly what shift rotation exists to avoid.
  const present = alive.filter((e) => silentFor(state, e) < rules.abandonWindow);
  if (present.length === 1 && alive.length > 1) {
    end(state, present[0]!.id, WIN.LAST_ROSTER);
    return;
  }

  if (rules.endStep > 0 && state.step >= rules.endStep) {
    end(state, leader(state), WIN.TIMEOUT);
  }
}

/** Highest tile count, ties broken by population then by id, so the result is
 *  total and identical on every peer. */
function leader(state: State): number {
  let best: Empire | null = null;
  for (const e of state.empires) {
    if (!e.alive || isVacant(e)) continue;
    if (
      !best ||
      e.tilesOwned > best.tilesOwned ||
      (e.tilesOwned === best.tilesOwned && e.popTotal > best.popTotal)
    ) {
      best = e;
    }
  }
  return best ? best.id : 0;
}

function end(state: State, winner: number, reason: (typeof WIN)[keyof typeof WIN]): void {
  state.phase = PHASE.ENDED;
  state.winner = winner;
  state.winReason = reason;
}
