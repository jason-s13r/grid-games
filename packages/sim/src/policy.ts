// Bot targeting. One policy, two homes:
//
//   SimBot  — runs inside every peer's sim, drives a whole bot empire, costs
//             zero bandwidth, and must therefore be perfectly deterministic.
//   PeerBot — runs as its own mesh client holding a member seat (Phase C).
//             Its moves are validated, not derived, so it may use any
//             randomness it likes.
//
// Ported from the prototype's Bot.js (expand / attack / defend / home and the
// mode cycling), with the `% this.modes` bug fixed — that was a modulo against
// an array, which yields NaN.
//
// Mode is derived from game time rather than stored, so bots need no fields in
// the snapshot and can never desync through their own bookkeeping.
//
// The optional `forced` and `focus` arguments exist for the PeerBot alone. A
// SimBot passes neither, and must not: both are decisions made outside the
// shared stream, which is exactly what a bot inside the simulation cannot have.
// Because it passes neither, adding them moves no hash — the draw order for an
// in-sim bot is the one it always was.

import { MOVE, ITEM } from "./types.js";
import type { BotProfile, Empire, Move } from "./types.js";
import { PASSABLE } from "./constants.js";
import { ORTHO, idx, xOf, yOf, inBounds, dist2 } from "./geometry.js";
import type { Rng } from "./rng.js";
import type { State } from "./state.js";

const MODES = ["expand", "attack", "defend", "home"] as const;
export type Mode = (typeof MODES)[number];

const PHASE_STEPS = 240; // ~20s of game time per coherent phase
/** Appetite for an adjacent coin when a profile does not say. */
const DEFAULT_COINS = 70;

/** Even, which is what a seat with no profile plays. */
const EVEN: Weights = [1, 1, 1, 1];
export type Weights = [number, number, number, number];

/** A pure integer mix, so which phase a window is can be a function of state
 *  rather than a draw from the shared stream. */
function mix(a: number, b: number, c: number): number {
  let h = (0x811c9dc5 ^ (a >>> 0)) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x01000193) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x01000193) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Which mode a weighted roll lands on. */
function modeAt(weights: Weights, roll: number): Mode {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) return MODES[roll % MODES.length]!;
  let left = roll % total;
  for (let i = 0; i < MODES.length; i++) {
    left -= Math.max(0, weights[i]!);
    if (left < 0) return MODES[i]!;
  }
  return MODES[MODES.length - 1]!;
}

/** The phase a bot is in, and how strongly it prefers one.
 *
 *  A phase lasts twenty seconds because a bot that re-chose every action would
 *  have no behaviour at all, only an average. Which phase this window is comes
 *  from hashing the window number rather than from the shared RNG: it is a pure
 *  function of state, identical on every peer, and it consumes no draws — so
 *  weighting a bot's appetites cannot shift the stream that everything else in
 *  the simulation reads from.
 *
 *  The occasional deviation still costs a draw, and still exists so that two
 *  bots in the same window do not move in lockstep. */
function pickMode(state: State, empire: Empire, weights: Weights, rng: Rng): Mode {
  const window = Math.floor(state.step / PHASE_STEPS) + empire.id;
  const base = modeAt(weights, mix(state.genesis.seed, empire.id, window));
  return rng.int(100) < 25 ? modeAt(weights, rng.int(1 << 20)) : base;
}

interface Scan {
  owned: number[];
  frontier: number[];
  coins: number[];
  /** Owned tiles with an enemy tile orthogonally beside them — the only tiles
   *  where reinforcement does anything. */
  threatened: number[];
}

/** One pass over the ownership layer. Called at most once per bot action
 *  (botActionInterval), not per step. */
function scan(state: State, empire: Empire): Scan {
  const { width, height, owner, terrain, item } = state;
  const owned: number[] = [];
  const frontier: number[] = [];
  const coins: number[] = [];
  const threatened: number[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== empire.id) continue;
    owned.push(i);

    const x = xOf(i, width);
    const y = yOf(i, width);
    let contested = false;
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny, width, height)) continue;
      const ni = idx(nx, ny, width);
      if (owner[ni] === empire.id) continue;
      if (owner[ni]! > 0) contested = true;
      if (!PASSABLE[terrain[ni]!]) continue;
      if (seen.has(ni)) continue;
      seen.add(ni);
      frontier.push(ni);
      if (item[ni] !== ITEM.NONE) coins.push(ni);
    }
    if (contested) threatened.push(i);
  }

  return { owned, frontier, coins, threatened };
}

/** A specific empire's capital, if it is somebody else's and still standing. */
function capitalOf(state: State, empire: Empire, id: number): number {
  if (id === empire.id) return -1;
  const other = state.empires.find((one) => one.id === id);
  return other?.alive ? other.capital : -1;
}

function nearestEnemyCapital(state: State, empire: Empire): number {
  let best = -1;
  let bestD = Infinity;
  const cx = xOf(empire.capital, state.width);
  const cy = yOf(empire.capital, state.width);

  for (const other of state.empires) {
    if (other.id === empire.id || !other.alive) continue;
    const d = dist2(cx, cy, xOf(other.capital, state.width), yOf(other.capital, state.width));
    if (d < bestD) {
      bestD = d;
      best = other.capital;
    }
  }
  return best;
}

/** Returns a CLAIM move, or null when there is nothing worth doing. Draw counts
 *  depend only on state, so every peer consumes the same RNG stream. */
export function policy(
  state: State,
  empire: Empire,
  memberIndex: number,
  rng: Rng,
  forced?: Mode,
  focus?: number,
  profile?: BotProfile,
): Move | null {
  const member = empire.members[memberIndex];
  if (!member || member.popTimer <= 0) return null;

  const { owned, frontier, coins, threatened } = scan(state, empire);
  if (owned.length === 0) return null;

  const weights = profile?.weights ?? EVEN;
  // A forced mode draws nothing here — a caller that pins the mode has already
  // made the decision this draw would have made.
  const mode = forced ?? pickMode(state, empire, weights, rng);
  let target = -1;

  // A coin is worth far more than a plain tile, so take one when adjacent
  // regardless of the current phase — but a coin sits on neutral ground by
  // definition, so taking one is expansion, and a bot pinned to defence does
  // not expand.
  //
  // How eagerly is the spidering knob: a bot that always takes the coin beside
  // it walks outward towards wherever the population is, and one that rarely
  // does stays where it started.
  if (!forced && coins.length > 0 && rng.int(100) < (profile?.coins ?? DEFAULT_COINS)) {
    target = coins[rng.int(coins.length)]!;
  } else if (mode === "expand" && frontier.length > 0) {
    target = weakest(state, frontier, rng);
  } else if (mode === "attack" && frontier.length > 0) {
    // Whose capital to walk towards. `focus` names one; without it, whoever is
    // closest — which is the only choice a SimBot ever makes, because a caller
    // that picks an enemy has decided something no shared stream could agree
    // on. A named empire that is dead or absent falls back to nearest rather
    // than to nothing: a bot with orders it cannot follow should still fight.
    const chosen = focus === undefined ? -1 : capitalOf(state, empire, focus);
    const capital = chosen >= 0 ? chosen : nearestEnemyCapital(state, empire);
    target = capital < 0 ? weakest(state, frontier, rng) : closestTo(state, frontier, capital, rng);
  } else if (mode === "defend") {
    // Reinforce where the line actually is. Piling population onto a random
    // interior tile looked like defence and achieved nothing; the thinnest
    // tile with an enemy beside it is the one about to fall.
    target =
      threatened.length > 0
        ? weakest(state, threatened, rng)
        : (nearCapital(state, empire, rng) ?? owned[rng.int(owned.length)]!);
  } else {
    target = nearCapital(state, empire, rng) ?? owned[rng.int(owned.length)]!;
  }

  if (target < 0) {
    // A defender never falls back onto neutral ground: with nothing to hold it
    // banks its population instead.
    if (forced === "defend") return null;
    if (frontier.length === 0) return null;
    target = frontier[rng.int(frontier.length)]!;
  }

  return {
    step: state.step,
    empire: empire.id,
    member: memberIndex,
    seq: 0,
    type: MOVE.CLAIM,
    x: xOf(target, state.width),
    y: yOf(target, state.width),
  };
}

/** Cheapest tile to take, sampled rather than fully sorted — one RNG draw,
 *  bounded work. */
function weakest(state: State, list: number[], rng: Rng): number {
  const samples = Math.min(8, list.length);
  const start = rng.int(list.length);
  let best = list[start]!;
  for (let k = 1; k < samples; k++) {
    const candidate = list[(start + k) % list.length]!;
    if (state.pop[candidate]! < state.pop[best]!) best = candidate;
  }
  return best;
}

function closestTo(state: State, list: number[], goal: number, rng: Rng): number {
  const gx = xOf(goal, state.width);
  const gy = yOf(goal, state.width);
  const samples = Math.min(12, list.length);
  const start = rng.int(list.length);

  let best = list[start]!;
  let bestD = dist2(xOf(best, state.width), yOf(best, state.width), gx, gy);
  for (let k = 1; k < samples; k++) {
    const c = list[(start + k) % list.length]!;
    const d = dist2(xOf(c, state.width), yOf(c, state.width), gx, gy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function nearCapital(state: State, empire: Empire, rng: Rng): number | null {
  const { width, height } = state;
  const cx = xOf(empire.capital, width);
  const cy = yOf(empire.capital, width);
  const options: number[] = [];

  for (const [dx, dy] of ORTHO) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (!inBounds(nx, ny, width, height)) continue;
    const ni = idx(nx, ny, width);
    if (PASSABLE[state.terrain[ni]!]) options.push(ni);
  }
  return options.length === 0 ? null : options[rng.int(options.length)]!;
}
