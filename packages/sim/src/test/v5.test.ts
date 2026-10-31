// Protocol 5: coins that gather, a ceiling on a simulation bot's tiles, growth
// that stops, and diamond mines. Each is checked against a v4 game as well, so
// the gate on the version is tested along with the rule.

import { describe, expect, it } from "vitest";
import { Sim, makeGenesis, mapFor, coinsFor, CLAIM } from "../sim.js";
import { DEFAULT_MAP, DEFAULT_RULES, hours, minutes } from "../constants.js";
import { ITEM, TERRAIN, CONTROL } from "../types.js";
import { place } from "../rules.js";
import { upkeep } from "../upkeep.js";
import { idx, xOf, yOf, ORTHO, inBounds } from "../geometry.js";
import { arena, humans, simbot, own, at, popAt } from "./testkit.js";

const dirty = new Set<number>();

describe("a simulation bot's tiles have a ceiling", () => {
  const board = (protocol?: number) => {
    const sim = arena([simbot(), humans(1)], 1, {}, protocol ? { protocol } : {});
    expect(sim.state.empires[0]!.control).toBe(CONTROL.SIMBOT);
    own(sim, 5, 5, 1, 4_990);
    own(sim, 9, 9, 2, 4_990);
    return sim;
  };

  it("holds a bot's tile to 5,000 in the first three hours", () => {
    const sim = board();
    place(sim.state, at(sim, 5, 5), 1, 999, dirty);
    expect(popAt(sim, 5, 5)).toBe(5_000);
    expect(place(sim.state, at(sim, 5, 5), 1, 999, dirty)).toBe(false);
    expect(popAt(sim, 5, 5)).toBe(5_000);
  });

  it("ratchets up with the clock, to 50,000", () => {
    const sim = board();
    sim.state.step = hours(3);
    place(sim.state, at(sim, 5, 5), 1, 20_000, dirty);
    expect(popAt(sim, 5, 5)).toBe(10_000);
    sim.state.step = hours(300);
    place(sim.state, at(sim, 5, 5), 1, 90_000, dirty);
    expect(popAt(sim, 5, 5)).toBe(50_000);
  });

  it("counts only what it placed in the empire's total", () => {
    const sim = board();
    const before = sim.state.empires[0]!.popTotal;
    place(sim.state, at(sim, 5, 5), 1, 999, dirty);
    expect(sim.state.empires[0]!.popTotal - before).toBe(10);
  });

  it("caps what is left on a tile a bot captures", () => {
    const sim = board();
    own(sim, 6, 5, 2, 10);
    place(sim.state, at(sim, 6, 5), 1, 20_000, dirty);
    expect(popAt(sim, 6, 5)).toBe(5_000);
  });

  it("leaves people and v4 games alone", () => {
    const sim = board();
    place(sim.state, at(sim, 9, 9), 2, 999, dirty);
    expect(popAt(sim, 9, 9)).toBe(5_989);
    const old = board(4);
    place(old.state, at(old, 5, 5), 1, 999, dirty);
    expect(popAt(old, 5, 5)).toBe(5_989);
  });
});

describe("growth", () => {
  const board = (protocol?: number) => {
    const sim = arena([humans(1), humans(1)], 1, {}, protocol ? { protocol } : {});
    const empire = sim.state.empires[0]!;
    empire.growthUnlocked = 1;
    // Joined to the capital at (2, 0).
    own(sim, 2, 1, 1, 998);
    own(sim, 2, 2, 1, 999);
    return sim;
  };

  it("stops at the ceiling", () => {
    const sim = board();
    upkeep(sim.state, dirty);
    expect(popAt(sim, 2, 1)).toBe(999);
    expect(popAt(sim, 2, 2)).toBe(999);
    expect(popAt(sim, 2, 0)).toBe(2);
  });

  it("waits while nobody in the empire is there", () => {
    const sim = board();
    sim.state.step = minutes(60);
    upkeep(sim.state, dirty);
    expect(popAt(sim, 2, 0)).toBe(1);
    sim.state.empires[0]!.members[0]!.lastBeat = sim.state.step;
    upkeep(sim.state, dirty);
    expect(popAt(sim, 2, 0)).toBe(2);
  });

  it("is as it was in a v4 game", () => {
    const sim = board(4);
    sim.state.step = minutes(60);
    upkeep(sim.state, dirty);
    expect(popAt(sim, 2, 2)).toBe(1_000);
  });
});

describe("diamond mines", () => {
  const isMountainEdge = (sim: Sim, i: number): boolean => {
    const { width, height, terrain } = sim.state;
    return ORTHO.some(([dx, dy]) => {
      const x = xOf(i, width) + dx;
      const y = yOf(i, width) + dy;
      return inBounds(x, y, width, height) && terrain[idx(x, y, width)] === TERRAIN.MOUNTAIN;
    });
  };

  it("are placed beside mountains, one per 1,024 tiles, and not in v4", () => {
    const genesis = makeGenesis({ seed: 7, empires: [humans(1), humans(1)] });
    const sim = new Sim(genesis);
    const mines = [...sim.state.item.keys()].filter((i) => sim.state.item[i] === ITEM.MINE);
    expect(mines.length).toBe(6);
    for (const i of mines) {
      expect(sim.state.terrain[i]).toBe(TERRAIN.PLAIN);
      expect(isMountainEdge(sim, i)).toBe(true);
    }
    expect(sim.state.itemCount).toBe(0);
    const old = new Sim({ ...genesis, protocol: 4 });
    expect([...old.state.item].some((item) => item >= ITEM.MINE)).toBe(false);
  });

  const board = () => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 2, 1, 1, 1);
    sim.state.item[at(sim, 2, 2)] = ITEM.MINE;
    return sim;
  };
  const claimWith = (sim: Sim, bank: number, x: number, y: number) => {
    sim.state.empires[0]!.members[0]!.popTimer = bank;
    const move = CLAIM(sim.state.step, 1, 0, 0, x, y);
    expect(sim.validate(move)).toBe(true);
    sim.advance([move]);
  };

  it("is dug by a claim with a big enough bank", () => {
    const sim = board();
    claimWith(sim, 799, 2, 2);
    expect(sim.state.owner[at(sim, 2, 2)]).toBe(1);
    expect(sim.state.item[at(sim, 2, 2)]).toBe(ITEM.MINE);
    claimWith(sim, 800, 2, 2);
    expect(sim.state.item[at(sim, 2, 2)]).toBe(ITEM.MINE + 3);
  });

  it("gives its owner a diamond every few passes while connected, then is worked out", () => {
    const sim = board();
    claimWith(sim, 900, 2, 2);
    const empire = sim.state.empires[0]!;
    const { upkeepInterval: interval, mineEvery: every } = sim.state.genesis.rules;
    let given = 0;
    for (let pass = 1; pass <= every! * 5; pass++) {
      sim.state.step = pass * interval;
      const before = empire.diamonds;
      upkeep(sim.state, dirty);
      given += empire.diamonds - before;
      if (pass % every! !== 0) expect(empire.diamonds).toBe(before);
    }
    expect(given).toBe(3);
    expect(sim.state.item[at(sim, 2, 2)]).toBe(ITEM.MINE);
  });

  it("gives nothing cut off from the capital", () => {
    const sim = board();
    claimWith(sim, 900, 2, 2);
    // Cut the line: the tile between capital and mine goes to the other side.
    sim.state.owner[at(sim, 2, 1)] = 2;
    sim.state.step = sim.state.genesis.rules.mineEvery! * sim.state.genesis.rules.upkeepInterval;
    upkeep(sim.state, dirty);
    expect(sim.state.empires[0]!.diamonds).toBe(0);
  });
});

describe("coins", () => {
  // Where the coins are after a few minutes of nobody moving: the share within
  // a spawn hop of somebody's ground, and how many other coins each has within
  // the same distance.
  const census = (protocol: number) => {
    const genesis = makeGenesis({ seed: 3, empires: [humans(1), humans(1), humans(1), humans(1)] });
    const sim = new Sim({ ...genesis, protocol });
    const { width, height, owner, item } = sim.state;
    for (const empire of sim.state.empires) {
      const cx = xOf(empire.capital, width);
      const cy = yOf(empire.capital, width);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (inBounds(x, y, width, height) && owner[idx(x, y, width)] === 0) owner[idx(x, y, width)] = empire.id;
      }
    }
    sim.fastForward(minutes(4));
    const isCoinAt = (j: number) => item[j]! > ITEM.NONE && item[j]! < ITEM.DIAMOND;
    let coins = 0, nearGround = 0, neighbours = 0, diamonds = 0;
    for (let i = 0; i < item.length; i++) {
      if (item[i] === ITEM.DIAMOND) diamonds++;
      if (!isCoinAt(i)) continue;
      coins++;
      let ground = false;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = xOf(i, width) + dx, y = yOf(i, width) + dy;
        if (!inBounds(x, y, width, height) || (!dx && !dy)) continue;
        const j = idx(x, y, width);
        if (owner[j] !== 0) ground = true;
        if (isCoinAt(j)) neighbours++;
      }
      if (ground) nearGround++;
    }
    return { nearGround: nearGround / coins, neighbours: neighbours / coins, diamonds };
  };

  it("gather near empires and near one another, and are never diamonds", () => {
    const v4 = census(4);
    const v5 = census(5);
    expect(v5.nearGround).toBeGreaterThan(v4.nearGround * 2);
    expect(v5.neighbours).toBeGreaterThan(v4.neighbours * 1.5);
    expect(v5.diamonds).toBe(0);
    expect(v4.diamonds).toBeGreaterThan(0);
  });
});

describe("coin farms", () => {
  // A field 20 by 20 walled in by empire 1, on a default-sized map, and a few
  // minutes of coins.
  const field = (share?: number) => {
    const rules = share === undefined ? { coinFarmShare: undefined } : { coinFarmShare: share };
    const genesis = makeGenesis({ seed: 5, empires: [humans(1), humans(1)], rules });
    const sim = new Sim(genesis);
    const { width, owner } = sim.state;
    const [x0, y0, size] = [30, 20, 22];
    for (let k = 0; k < size; k++) {
      for (const [x, y] of [[x0 + k, y0], [x0 + k, y0 + size - 1], [x0, y0 + k], [x0 + size - 1, y0 + k]]) {
        // Strong enough to outlast the decay of ground cut off from a capital.
        owner[idx(x!, y!, width)] = 1;
        sim.state.pop[idx(x!, y!, width)] = 100_000;
      }
    }
    sim.fastForward(minutes(5));
    let inside = 0;
    for (let y = y0 + 1; y < y0 + size - 1; y++) {
      for (let x = x0 + 1; x < x0 + size - 1; x++) {
        const item = sim.state.item[idx(x, y, width)]!;
        if (item > ITEM.NONE && item < ITEM.DIAMOND) inside++;
      }
    }
    return inside;
  };

  it("fill up when a share of coins goes into them", () => {
    const without = field();
    const with35 = field(35);
    expect(with35).toBeGreaterThan(without * 3);
    expect(with35).toBeGreaterThan(20);
  });
});

describe("map size", () => {
  it("is the default map at the default size", () => {
    expect(mapFor(DEFAULT_MAP.width, DEFAULT_MAP.height)).toEqual(DEFAULT_MAP);
  });

  it("gives a bigger map coins more often, and no cap short of the map", () => {
    expect(coinsFor(DEFAULT_MAP.width, DEFAULT_MAP.height)).toEqual({
      coinIntervalMin: DEFAULT_RULES.coinIntervalMin,
      coinIntervalMax: DEFAULT_RULES.coinIntervalMax,
      // No cap short of the map itself.
      maxItemsOnMap: DEFAULT_MAP.width * DEFAULT_MAP.height,
    });
    const big = coinsFor(DEFAULT_MAP.width * 2, DEFAULT_MAP.height * 2);
    expect(big.coinIntervalMax).toBe(Math.round(DEFAULT_RULES.coinIntervalMax / 2));
    expect(makeGenesis({ seed: 1, map: { width: 192, height: 128 }, empires: [humans(1)] }).rules.maxItemsOnMap).toBe(192 * 128);
  });

  it("scales mountains with the area and rivers with the side", () => {
    const big = mapFor(DEFAULT_MAP.width * 4, DEFAULT_MAP.height * 4);
    expect(big.mountains).toBe(DEFAULT_MAP.mountains * 16);
    expect(big.rivers).toBe(DEFAULT_MAP.rivers * 4);
  });
});
