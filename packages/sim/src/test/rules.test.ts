// The rules, checked rather than reasoned about.
//
// Every number here is a design decision that Phase C's consensus depends on
// reproducing exactly: two peers that disagree about what a gold coin does
// disagree about the state hash, and the game stops.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, makeGenesis, CLAIM } from "../sim.js";
import { MOVE, MEMBER, CONTROL, TERRAIN, ITEM } from "../types.js";
import { idx } from "../geometry.js";
import { STEPS_PER_SECOND } from "../constants.js";
import { arena, at, claimNow, held, humans, own, ownerAt, popAt } from "./testkit.js";

describe("surround multiplier", () => {
  it("one adjacent tile places 999", () => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 6, 5);
    expect(popAt(sim, 6, 5)).toBe(999);
  });

  it("four-side surround places 999 x 4", () => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 4, 1);
    own(sim, 5, 6, 1);
    own(sim, 4, 5, 1);
    own(sim, 6, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 5, 5);
    expect(popAt(sim, 5, 5)).toBe(3996);
  });
});

describe("coin claim radii", () => {
  // perTile is floor(999 / tiles); the remainder is added to the coin tile so
  // no population is lost to the division.
  const cases = [
    { coin: "bronze", item: ITEM.BRONZE, tiles: 5, perTile: 199 },
    { coin: "silver", item: ITEM.SILVER, tiles: 13, perTile: 76 },
    { coin: "gold", item: ITEM.GOLD, tiles: 25, perTile: 39 },
  ] as const;

  describe.each(cases)("$coin", ({ item, tiles, perTile }) => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 10, 12, 1);
      sim.state.item[at(sim, 11, 12)] = item;
      sim.state.itemCount = 1;
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      claimNow(sim, 1, 0, 11, 12);
    });

    // The claim covers the ball, and the seed tile at (10,12) sits inside it.
    it(`claims ${tiles} tiles`, () => expect(held(sim, 1)).toBe(tiles));

    it(`spreads floor(999/${tiles}) per tile`, () => expect(popAt(sim, 11, 13)).toBe(perTile));

    it("puts the remainder on the coin tile", () => {
      expect(popAt(sim, 11, 12)).toBe(perTile + (999 - perTile * tiles));
    });
  });
});

describe("coin cascade", () => {
  let sim: Sim;

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    own(sim, 10, 12, 1);
    sim.state.item[at(sim, 11, 12)] = ITEM.BRONZE;
    sim.state.item[at(sim, 12, 12)] = ITEM.GOLD; // inside the bronze radius
    sim.state.itemCount = 2;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 11, 12);
  });

  it("a coin inside the radius triggers a chain", () => {
    expect(held(sim, 1)).toBeGreaterThan(5);
  });

  it("chained gold covers its own full radius", () => {
    expect(ownerAt(sim, 15, 12)).toBe(1);
  });

  it("creates population rather than dividing it", () => {
    // Every tile of the chained gold gets the bronze's own 199 per tile.
    expect(popAt(sim, 12, 13)).toBe(199);
  });

  it("a bot's cascade does not chain", () => {
    const bot = arena([
      { control: CONTROL.HUMAN, members: [{ kind: MEMBER.BOT }] },
      humans(1),
    ]);
    own(bot, 10, 12, 1);
    bot.state.item[at(bot, 11, 12)] = ITEM.BRONZE;
    bot.state.item[at(bot, 12, 12)] = ITEM.GOLD;
    bot.state.itemCount = 2;
    bot.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(bot, 1, 0, 11, 12);
    expect(ownerAt(bot, 15, 12)).toBe(0);
  });
});

describe("terrain and crossings", () => {
  const blocked = (terrain: number): boolean => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    sim.state.terrain[at(sim, 6, 5)] = terrain;
    return !sim.validate(CLAIM(0, 1, 0, 0, 6, 5));
  };

  it("mountains are impassable", () => expect(blocked(TERRAIN.MOUNTAIN)).toBe(true));
  it("lakes are impassable", () => expect(blocked(TERRAIN.LAKE)).toBe(true));
  it("rivers block until bridged", () => expect(blocked(TERRAIN.RIVER)).toBe(true));

  // Buying, placing and then crossing is one story, so these run in order
  // against one board rather than rebuilding the setup three times.
  describe("bridging a river", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 5, 5, 1);
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      sim.state.terrain[at(sim, 6, 5)] = TERRAIN.RIVER;
    });

    const buy = { empire: 1, member: 0, seq: 0, type: MOVE.BUY_BRIDGE, x: 0, y: 0 };

    it("cannot be bought without diamonds", () => {
      expect(sim.validate({ step: 0, ...buy })).toBe(false);
    });

    it("spends the diamonds it costs", () => {
      sim.state.empires[0]!.diamonds = 3;
      sim.advance([{ step: sim.step, ...buy }]);
      expect(sim.state.empires[0]!.diamonds).toBe(0);
    });

    it("yields one bridge", () => expect(sim.state.empires[0]!.bridges).toBe(1));

    it("converts the tile when placed", () => {
      sim.advance([
        { step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.PLACE_BRIDGE, x: 6, y: 5 },
      ]);
      expect(sim.state.terrain[at(sim, 6, 5)]).toBe(TERRAIN.RIVER_BRIDGED);
    });

    it("and the river is then passable", () => {
      expect(sim.validate(CLAIM(sim.step, 1, 0, 0, 6, 5))).toBe(true);
    });
  });
});

describe("noob protection", () => {
  let sim: Sim;
  let cx: number;
  let cy: number;
  let capital: number;

  beforeAll(() => {
    sim = new Sim(
      makeGenesis({
        seed: 7,
        empires: [humans(1), humans(1)],
        map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
        rules: {
          coinIntervalMin: 1 << 28,
          coinIntervalMax: 1 << 28,
          noobTiles: 40,
          noobSteps: 100 * STEPS_PER_SECOND,
        },
      }),
    );
    capital = sim.state.empires[1]!.capital;
    cx = capital % sim.state.width;
    cy = Math.floor(capital / sim.state.width);

    // Attacker adjacent to the protected capital.
    sim.state.owner[idx(cx - 1, cy, sim.state.width)] = 1;
    sim.state.pop[idx(cx - 1, cy, sim.state.width)] = 1;
    sim.state.empires[0]!.tilesOwned++;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
  });

  it("a protected capital rejects attacks", () => {
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy))).toBe(false);
  });

  it("a protected capital takes no damage", () => {
    const before = sim.state.pop[capital]!;
    sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy));
    expect(sim.state.pop[capital]).toBe(before);
  });

  it("protection lifts once the timer passes", () => {
    sim.state.step = 100 * STEPS_PER_SECOND + 1;
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy))).toBe(true);
  });
});

describe("team empires", () => {
  describe("three members share territory and not timers", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(3), humans(1)]);
      own(sim, 5, 5, 1);
      own(sim, 8, 8, 1);
      for (let i = 0; i < 300; i++) sim.advance([]);
    });

    it("member A accrues its own timer", () => {
      expect(sim.state.empires[0]!.members[0]!.popTimer).toBe(300);
    });

    it("member B accrues independently", () => {
      expect(sim.state.empires[0]!.members[1]!.popTimer).toBe(300);
    });

    it("three members hold three separate timers", () => {
      const [a, b, c] = sim.state.empires[0]!.members;
      expect(new Set([a, b, c]).size).toBe(3);
    });

    // Two members of one empire acting on the same step, on different fronts,
    // is the whole point of a shared empire.
    it("two members act on the same step", () => {
      sim.state.empires[0]!.members[0]!.popTimer = 100;
      sim.state.empires[0]!.members[1]!.popTimer = 100;
      const dirty = sim.advance([
        CLAIM(sim.step, 1, 0, 0, 6, 5),
        CLAIM(sim.step, 1, 1, 0, 9, 8),
      ]);
      expect([ownerAt(sim, 6, 5), ownerAt(sim, 9, 8)]).toEqual([1, 1]);
      expect(dirty.size).toBeGreaterThanOrEqual(2);
    });
  });

  // Night cover has to cost the empire something, or a bot seat is strictly
  // free and therefore overpowered.
  describe("a bot member is cheaper to run and worth less", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN }, { kind: MEMBER.BOT }] },
        humans(1),
      ]);
      own(sim, 5, 5, 1);
      for (let i = 0; i < 200; i++) sim.advance([]);
    });

    it("a human member accrues at full rate", () => {
      expect(sim.state.empires[0]!.members[0]!.popTimer).toBe(200);
    });

    it("a bot member accrues at half rate", () => {
      expect(sim.state.empires[0]!.members[1]!.popTimer).toBe(100);
    });
  });
});

describe("win conditions", () => {
  describe("capturing a capital", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      const victim = sim.state.empires[1]!;
      victim.capital = at(sim, 12, 12);
      sim.state.owner[victim.capital] = 2;
      sim.state.pop[victim.capital] = 1;
      victim.tilesOwned = 1;
      own(sim, 11, 12, 1);
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      claimNow(sim, 1, 0, 12, 12);
    });

    it("eliminates the empire", () => expect(sim.state.empires[1]!.alive).toBe(0));
    it("ends the game", () => expect(sim.ended).toBe(true));
    it("and the survivor wins", () => expect(sim.state.winner).toBe(1));
  });

  // Being asleep is not being defeated. A short window would reward waiting
  // until an opponent's team is offline, which is the behaviour the whole
  // shift-rotation design exists to avoid.
  describe("abandonment", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 5, 5, 1);
      own(sim, 15, 15, 2);
    });

    it("does not fire on a minute of silence", () => {
      sim.state.step = 60 * STEPS_PER_SECOND;
      sim.state.empires[0]!.members[0]!.lastBeat = sim.state.step;
      sim.advance([]);
      expect(sim.ended).toBe(false);
    });

    it("fires past the window", () => {
      sim.state.step = sim.state.genesis.rules.abandonWindow + 10;
      sim.state.empires[0]!.members[0]!.lastBeat = sim.state.step;
      sim.advance([]);
      expect(sim.ended && sim.state.winner === 1).toBe(true);
    });
  });
});
