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
// the snapshot and can never desync through their own bookkeeping. That holds
// even now that phases have their own durations: a profile's phases add up to a
// cycle of known length, so `step % cycle` says where in it the bot is, in a
// walk over at most six entries and no memory at all.
//
// The optional `forced` and `focus` arguments exist for the PeerBot alone. A
// SimBot passes neither, and must not: both are decisions made outside the
// shared stream, which is exactly what a bot inside the simulation cannot have.
// Because it passes neither, adding them moves no hash — the draw order for an
// in-sim bot is the one it always was.

import { MOVE, ITEM } from "./types.js";
import type { BotMode, BotPhase, BotProfile, Empire, Move } from "./types.js";
import { reachable } from "./upkeep.js";
import { PASSABLE } from "./constants.js";
import { ORTHO, idx, xOf, yOf, inBounds, dist2 } from "./geometry.js";
import type { Rng } from "./rng.js";
import type { State } from "./state.js";

export const MODES = ["expand", "attack", "defend", "fortify", "heal", "sleep"] as const;
export type Mode = BotMode;

/** Appetite for an adjacent coin when a profile does not say. */
const DEFAULT_COINS = 70;

/** What a seat with no profile plays: everything in turn, twenty seconds each,
 *  a claim every two, and it never sleeps. This is the shape a PeerBot gets
 *  when nobody has said otherwise. */
const DEFAULT_PHASES: Partial<Record<Mode, BotPhase>> = {
  expand: { steps: 240, rate: [24, 24] },
  attack: { steps: 240, rate: [24, 24] },
  defend: { steps: 240, rate: [24, 24] },
  fortify: { steps: 240, rate: [24, 24] },
};

/** A pure integer mix, so the tempo of a phase can be a function of state
 *  rather than a draw from the shared stream. */
function mix(a: number, b: number, c: number): number {
  let h = (0x811c9dc5 ^ (a >>> 0)) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 0x01000193) >>> 0;
  h = Math.imul(h ^ (c >>> 0), 0x01000193) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

export interface Turn {
  mode: Mode;
  /** Steps between claims for this visit to the phase. */
  interval: number;
  /** The step this visit began, so a caller can tell whether a claim is due. */
  since: number;
}

/** Where in its cycle a bot is, right now.
 *
 *  Derived rather than remembered. The phases a profile declares add up to a
 *  cycle of fixed length, so the position in it is `step % cycle` and finding
 *  the phase is a walk over at most six entries — no fields in the snapshot,
 *  nothing to desync through.
 *
 *  The tempo is drawn from the phase's span by hashing which pass through the
 *  cycle this is, not by asking the RNG. That matters more than it sounds: the
 *  stream is shared with coin spawns and everything else in the world, so a bot
 *  that drew for its own tempo would move the world around it whenever somebody
 *  changed its profile. */
export function turnOf(state: State, empire: Empire, seat: number, profile?: BotProfile): Turn {
  const phases = profile?.phases ?? DEFAULT_PHASES;
  const entries = MODES.map((mode) => [mode, phases[mode]] as const).filter(
    ([, phase]) => phase && phase.steps > 0,
  ) as Array<readonly [Mode, BotPhase]>;

  // A bot with no phases at all does nothing, which is a legitimate thing to
  // ask for and better than inventing behaviour it was not given.
  if (entries.length === 0) return { mode: "sleep", interval: 1, since: state.step };

  const cycle = entries.reduce((sum, [, phase]) => sum + phase.steps, 0);
  // Offset by seat so two bots on the same profile are not in lockstep.
  const at = (state.step + empire.id * 97 + seat * 31) % cycle;

  let start = 0;
  let pass = Math.floor((state.step + empire.id * 97 + seat * 31) / cycle);
  for (const [mode, phase] of entries) {
    if (at < start + phase.steps) {
      const [low, high] = phase.rate;
      const span = Math.max(1, high - low + 1);
      const interval = Math.max(1, low + (mix(state.genesis.seed ^ pass, empire.id + seat, start) % span));
      return { mode, interval, since: state.step - (at - start) };
    }
    start += phase.steps;
  }

  const [mode, phase] = entries[entries.length - 1]!;
  return { mode, interval: Math.max(1, phase.rate[0]), since: state.step };
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

  // A forced mode draws nothing here — a caller that pins the mode has already
  // made the decision this draw would have made.
  const mode = forced ?? turnOf(state, empire, memberIndex, profile).mode;
  if (mode === "sleep") return null;
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
    // Around the border rather than at the cheapest tile on it. Always taking
    // the weakest frontier tile grows a finger towards whatever is softest,
    // and a finger is all border and no interior — every tile of it exposed on
    // three sides, none of it earning the surround multiplier. Sweeping the
    // angle instead means the whole edge comes forward together.
    target = alongTheBorder(state, empire, frontier, rng);
  } else if (mode === "attack" && frontier.length > 0) {
    // What to steer at. `focus` names an empire and takes its capital; without
    // one, the nearest tile anybody else is actually holding — which is where
    // the fighting is, and much nearer than a capital. A named empire that is
    // dead or absent falls back rather than doing nothing: a bot with orders
    // it cannot follow should still fight.
    const chosen = focus === undefined ? -1 : capitalOf(state, empire, focus);
    const goal = chosen >= 0 ? chosen : nearestHeldTile(state, empire, frontier);
    target = goal < 0 ? weakest(state, frontier, rng) : closestTo(state, frontier, goal, rng);
  } else if (mode === "defend") {
    // Reinforce where the line actually is. Piling population onto a random
    // interior tile looked like defence and achieved nothing; the thinnest
    // tile with an enemy beside it is the one about to fall.
    target =
      threatened.length > 0
        ? weakest(state, threatened, rng)
        : weakest(state, owned, rng);
  } else if (mode === "heal") {
    // A pocket the capital cannot reach is on a clock: upkeep decays it every
    // pass and it goes neutral. Reconnecting is worth more than anything else
    // this bot could spend on, because it saves tiles it has already paid for.
    target = towardsThePocket(state, empire, frontier, rng);
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

/** Expansion that spirals rather than reaching.
 *
 *  The frontier tile nearest a sweep angle that turns with the clock, so
 *  successive claims walk around the empire's edge and it thickens in every
 *  direction at once. A tie on angle goes to the cheaper tile, so the sweep
 *  still prefers soft ground where it has a choice.
 *
 *  atan2 would be the obvious way to get an angle and is exactly what a
 *  deterministic simulation cannot use: it is implementation-defined at the
 *  last bit and two engines would eventually disagree. This compares
 *  cross-products of integers instead, which is the same ordering in whole
 *  numbers. */
function alongTheBorder(state: State, empire: Empire, frontier: number[], rng: Rng): number {
  const { width } = state;
  const cx = xOf(empire.capital, width);
  const cy = yOf(empire.capital, width);

  // One full turn every ~48 seconds of game time, in eight sectors.
  const sector = Math.floor(state.step / 72) % 8;
  const [sx, sy] = SWEEP[sector]!;

  const samples = Math.min(24, frontier.length);
  const start = rng.int(frontier.length);
  let best = -1;
  let bestKey = -Infinity;

  for (let k = 0; k < samples; k++) {
    const i = frontier[(start + k) % frontier.length]!;
    const dx = xOf(i, width) - cx;
    const dy = yOf(i, width) - cy;
    // Alignment with the sweep direction, scaled to keep it integral. Distance
    // is divided out only coarsely: a tile twice as far along the sweep is
    // still on it, and dividing exactly would need a float.
    const along = dx * sx + dy * sy;
    const off = Math.abs(dx * sy - dy * sx);
    const key = along * 4 - off * 3 - Math.min(state.pop[i]!, 60);
    if (key > bestKey) {
      bestKey = key;
      best = i;
    }
  }
  return best;
}

/** Eight compass directions, as integer vectors. */
const SWEEP: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** The nearest tile somebody else is holding, measured from the frontier
 *  rather than from the capital — the fighting is at the edge, and an empire's
 *  own capital may be a long way behind it. */
function nearestHeldTile(state: State, empire: Empire, frontier: number[]): number {
  const { width, owner, pop } = state;
  let best = -1;
  let bestD = Infinity;

  // Sampled from the frontier, because scanning the whole map for the nearest
  // enemy tile on every action is the one thing a bot must not cost.
  const from = frontier[0]!;
  const fx = xOf(from, width);
  const fy = yOf(from, width);

  for (let i = 0; i < owner.length; i++) {
    const held = owner[i]!;
    if (held === empire.id || (held === 0 && pop[i] === 0)) continue;
    const d = dist2(fx, fy, xOf(i, width), yOf(i, width));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A step towards a pocket the capital has lost touch with.
 *
 *  Claims the passable tile on the main body's frontier that is closest to the
 *  stranded ground. Reconnecting takes as many claims as the gap is wide, and
 *  each one is a claim that also expands — so a healing bot that fails to
 *  reconnect has still not wasted the population. */
function towardsThePocket(state: State, empire: Empire, frontier: number[], rng: Rng): number {
  const seen = reachable(state, empire);
  const { width, owner } = state;

  let pocket = -1;
  let bestD = Infinity;
  const cx = xOf(empire.capital, width);
  const cy = yOf(empire.capital, width);

  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== empire.id || seen[i]) continue;
    const d = dist2(cx, cy, xOf(i, width), yOf(i, width));
    if (d < bestD) {
      bestD = d;
      pocket = i;
    }
  }

  // Nothing is cut off, so there is nothing to heal. Thicken the line instead
  // of standing still — it is the phase nearest in spirit.
  if (pocket < 0) return weakest(state, frontier, rng);
  return closestTo(state, frontier, pocket, rng);
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
