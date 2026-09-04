// Connectivity upkeep: what a capital still reaches, and what it does not.
//
// Two mechanics fall out of one sweep, which is why they live together.
//
// DECAY. Territory cut off from its capital used to sit on the board forever.
// A pocket carved out behind enemy lines was permanent, so encircling an
// opponent achieved nothing until every one of their tiles was individually
// overwhelmed, and a dead empire's islands littered the map for the rest of
// the game. Cutting a supply line should be worth something on its own: an
// isolated tile now loses a fraction of its population each pass and goes
// neutral when it runs out, so a pincer is a real move and a relief column is
// a real answer.
//
// GROWTH. The other half of the same walk. Once an empire has bought the
// upgrade, every tile the capital can still reach gains a little population on
// every pass, for the rest of the game — a defensive boost, and the one thing
// that rewards a consolidated, connected empire over a sprawl of disconnected
// raids. It is deliberately a standing property rather than a timed buff: what
// it pays for is staying joined up.
//
// One pass over the ownership layer per upkeep interval, not per step. On the
// default 96x64 map that is ~6k tiles every 20 s of game time, so a six-hour
// fast-forward costs about a thousand sweeps rather than a quarter of a
// million.

import { ORTHO, idx, xOf, yOf, inBounds } from "./geometry.js";
import { setOwner } from "./rules.js";
import type { DirtySet } from "./rules.js";
import type { State } from "./state.js";
import type { Empire } from "./types.js";

/** Flood the empire's own tiles outward from its capital. Returns a mask over
 *  the whole map: 1 where the capital still reaches. */
export function reachable(state: State, empire: Empire): Uint8Array {
  const { width, height, owner } = state;
  const seen = new Uint8Array(owner.length);

  const capital = empire.capital;
  if (owner[capital] !== empire.id) return seen;

  // A plain array used as a FIFO with a head index — a Set would iterate in
  // insertion order, which is fine, but the queue never needs membership tests
  // because `seen` already answers that.
  const queue = [capital];
  seen[capital] = 1;

  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = xOf(i, width);
    const y = yOf(i, width);
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny, width, height)) continue;
      const ni = idx(nx, ny, width);
      if (seen[ni] || owner[ni] !== empire.id) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }

  return seen;
}

export function upkeep(state: State, dirty: DirtySet): void {
  const rules = state.genesis.rules;

  for (const empire of state.empires) {
    if (!empire.alive) continue;

    const seen = reachable(state, empire);
    const growing = empire.growthUnlocked !== 0;
    let delta = 0;

    for (let i = 0; i < state.owner.length; i++) {
      if (state.owner[i] !== empire.id) continue;

      if (seen[i]) {
        if (!growing) continue;
        state.pop[i] = state.pop[i]! + rules.growthAmount;
        delta += rules.growthAmount;
        dirty.add(i);
        continue;
      }

      // Cut off. Integer division with a floor of decayMin, so a tile holding
      // one population still reaches zero rather than rounding its way to
      // immortality.
      const pop = state.pop[i]!;
      const loss = Math.max(rules.decayMin, Math.floor((pop * rules.decayNum) / rules.decayDen));
      const left = pop - loss;
      delta -= Math.min(loss, pop);

      if (left <= 0) {
        state.pop[i] = 0;
        setOwner(state, i, 0);
      } else {
        state.pop[i] = left;
      }
      dirty.add(i);
    }

    empire.popTotal = Math.max(0, empire.popTotal + delta);
  }
}
