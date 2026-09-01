// Terrain generation, judged by whether the map it produces is playable.

import { describe, expect, it } from "vitest";
import { Sim, makeGenesis } from "../sim.js";
import { TERRAIN } from "../types.js";
import { humans } from "./testkit.js";

// A river that seals the map is the bug being fixed here, so the assertion is
// about whether it can be walked across.
describe("rivers are fordable", () => {
  /** Lines you can cross the river on without a bridge.
   *
   *  A river lays down one tile per row (running vertically) or one per column
   *  (horizontally), so crossing it means finding a line of the perpendicular
   *  axis with no river tile on it at all. Only one of the two counts means
   *  anything for a given river, and it is always the smaller: the axis the
   *  river runs along has a tile on every line by construction. */
  const crossings = (sim: Sim): number => {
    const { terrain, width, height } = sim.state;
    const rows = new Uint8Array(height);
    const cols = new Uint8Array(width);
    for (let i = 0; i < terrain.length; i++) {
      if (terrain[i] !== TERRAIN.RIVER) continue;
      rows[Math.floor(i / width)] = 1;
      cols[i % width] = 1;
    }
    const clear = (mask: Uint8Array) => mask.reduce((n, hit) => n + (hit ? 0 : 1), 0);
    return Math.min(clear(rows), clear(cols));
  };

  const world = (seed: number, riverGaps: number): Sim =>
    new Sim(
      makeGenesis({
        seed,
        empires: [humans(1), humans(1)],
        map: { width: 64, height: 48, mountains: 0, lakes: 0, walls: 0, rivers: 1, riverGaps },
      }),
    );

  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

  it.each(seeds)("seed %i: an ungapped river cannot be crossed at all", (seed) => {
    expect(crossings(world(seed, 0))).toBe(0);
  });

  it.each(seeds)("seed %i: fords open a way over", (seed) => {
    expect(crossings(world(seed, 3))).toBeGreaterThanOrEqual(3);
  });

  it("and the river is still mostly there", () => {
    const sim = world(1, 3);
    let river = 0;
    for (const t of sim.state.terrain) if (t === TERRAIN.RIVER) river++;
    expect(river).toBeGreaterThan(20);
  });
});


// A ford is no help to an empire the generator dropped into a corner the river
// pinched off: twenty tiles, no front, and nothing to do until it can afford a
// bridge out. Capitals go on the mainland or nowhere.
describe("capitals start somewhere worth starting", () => {
  /** Every tile in the passable region containing `from`. */
  const regionAt = (sim: Sim, from: number): Set<number> => {
    const { terrain, width, height } = sim.state;
    const passableAt = (i: number) =>
      terrain[i] === TERRAIN.PLAIN ||
      terrain[i] === TERRAIN.RIVER_BRIDGED ||
      terrain[i] === TERRAIN.WALL_LADDERED;
    if (!passableAt(from)) return new Set();

    const seen = new Uint8Array(terrain.length);
    const queue = [from];
    seen[from] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % width;
      const y = Math.floor(i / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (seen[ni] || !passableAt(ni)) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return new Set(queue);
  };

  const seeds = [1, 7, 13, 42, 99, 256];

  it.each(seeds)("seed %i: every capital has room to grow into", (seed) => {
    const sim = new Sim(
      makeGenesis({ seed, empires: [humans(1), humans(1), humans(1), humans(1)] }),
    );
    const tiles = sim.state.width * sim.state.height;
    for (const empire of sim.state.empires) {
      expect(regionAt(sim, empire.capital).size).toBeGreaterThan(tiles / 4);
    }
  });

  it.each(seeds)("seed %i: and they can all reach each other", (seed) => {
    const sim = new Sim(
      makeGenesis({ seed, empires: [humans(1), humans(1), humans(1), humans(1)] }),
    );
    const home = regionAt(sim, sim.state.empires[0]!.capital);
    for (const empire of sim.state.empires) {
      expect(home.has(empire.capital)).toBe(true);
    }
  });
});
