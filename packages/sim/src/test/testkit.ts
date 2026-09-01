// Fixtures the rules tests are built from.
//
// Kept apart from the tests themselves because `replay.ts` wants the same
// empire specs for its command line, and because a fixture that sets up a board
// is worth reading on its own.

import { Sim, makeGenesis, CLAIM } from "../sim.js";
import type { EmpireSpec } from "../types.js";
import { TERRAIN, ITEM } from "../types.js";
import { idx } from "../geometry.js";

export { humans, simbot } from "../specs.js";

/** A blank arena: no terrain features, no spawns, so a test controls the board
 *  completely.
 *
 *  Every empire keeps an owned capital parked in row 0, well clear of the
 *  working area. Without one, elimination fires on the first advance and the
 *  game ends before the test does anything. */
export function arena(empires: EmpireSpec[], seed = 1): Sim {
  const sim = new Sim(
    makeGenesis({
      seed,
      empires,
      map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
      rules: { coinIntervalMin: 1 << 28, coinIntervalMax: 1 << 28, noobSteps: 0, noobTiles: 0 },
    }),
  );
  const s = sim.state;
  s.terrain.fill(TERRAIN.PLAIN);
  s.owner.fill(0);
  s.pop.fill(0);
  s.item.fill(ITEM.NONE);
  s.itemCount = 0;
  for (const e of s.empires) {
    e.tilesOwned = 0;
    e.popTotal = 0;
    e.alive = 1;
    const capital = idx(e.id * 2, 0, s.width);
    e.capital = capital;
    s.owner[capital] = e.id;
    s.pop[capital] = 1;
    e.tilesOwned = 1;
    e.popTotal = 1;
  }
  return sim;
}

/** Tiles an empire holds, ignoring the parked capital. */
export function held(sim: Sim, empire: number): number {
  let n = 0;
  for (let i = 0; i < sim.state.owner.length; i++) {
    if (sim.state.owner[i] === empire && i !== sim.state.empires[empire - 1]!.capital) n++;
  }
  return n;
}

export function own(sim: Sim, x: number, y: number, empire: number, pop = 1): void {
  const i = idx(x, y, sim.state.width);
  sim.state.owner[i] = empire;
  sim.state.pop[i] = pop;
  const e = sim.state.empires[empire - 1]!;
  e.tilesOwned++;
  e.popTotal += pop;
}

export const at = (sim: Sim, x: number, y: number): number => idx(x, y, sim.state.width);
export const popAt = (sim: Sim, x: number, y: number): number => sim.state.pop[at(sim, x, y)]!;
export const ownerAt = (sim: Sim, x: number, y: number): number => sim.state.owner[at(sim, x, y)]!;

export function claimNow(
  sim: Sim,
  empire: number,
  member: number,
  x: number,
  y: number,
): boolean {
  const move = CLAIM(sim.state.step, empire, member, 0, x, y);
  const valid = sim.validate(move);
  if (valid) sim.advance([move]);
  return valid;
}
