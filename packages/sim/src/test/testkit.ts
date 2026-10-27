// Fixtures the rules tests are built from.
//
// Kept apart from the tests themselves because `replay.ts` wants the same
// empire specs for its command line, and because a fixture that sets up a board
// is worth reading on its own.

import { Sim, makeGenesis, CLAIM } from "../sim.js";
import type { EmpireSpec, Rules } from "../types.js";
import { TERRAIN, ITEM } from "../types.js";
import { idx } from "../geometry.js";
import { rebuildShields } from "../state.js";

export { humans, simbot } from "../specs.js";

/** A blank arena: no terrain features, no spawns, no upkeep, so a test
 *  controls the board completely.
 *
 *  Every empire keeps an owned capital parked in row 0, well clear of the
 *  working area. Without one, elimination fires on the first advance and the
 *  game ends before the test does anything.
 *
 *  Parked well clear also means disconnected, so the upkeep sweep would decay
 *  every tile a test placed. Suppressed here the same way spawning is — these
 *  are world processes, and the tests that care about them build their own
 *  board. See upkeep.test.ts. */
export function arena(
  empires: EmpireSpec[],
  seed = 1,
  rules: Partial<Rules> = {},
  /** Stamp a version other than the one this build composes. The only way to
   *  put a v3 peer and a v4 peer in one process, which is what a gated branch
   *  needs to be tested at all — the Sim constructor never checks gameId, so a
   *  hand-stamped genesis is enough and no re-sealing is involved. */
  options: { protocol?: number } = {},
): Sim {
  const genesis = makeGenesis({
    seed,
    empires,
    map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
    rules: {
      coinIntervalMin: 1 << 28,
      coinIntervalMax: 1 << 28,
      upkeepInterval: 1 << 28,
      // No capital protection: an arena is a board for testing one transition,
      // and a shield nobody asked for is a refusal in the middle of a test about
      // something else. The grace fields are absent from `DEFAULT_RULES` — they
      // travel only with vacancies — so these two are what protection is read
      // from here, and a test about grace names the grace fields itself.
      noobSteps: 0,
      noobTiles: 0,
      // `vacancyRadius` is absent too, and that matters for this fixture in
      // particular: `arena` parks capitals two tiles apart, so any nonzero
      // radius would close the whole board and every rules test touching an
      // unclaimed empire would fail for a reason unrelated to what it tests.
      ...rules,
    },
  });
  const sim = new Sim(
    options.protocol === undefined ? genesis : { ...genesis, protocol: options.protocol },
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
  // The capitals just moved, and the shield layer is derived from where they
  // are. A no-op at the arena's default radius of zero, and the difference
  // between a working fixture and a silently wrong one for any test that sets
  // `vacancyRadius` itself.
  rebuildShields(s);
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
