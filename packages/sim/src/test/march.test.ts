// Marching: two tiles from one spend, once the empire has bought the reach.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim } from "../sim.js";
import { ITEM, MOVE, TERRAIN } from "../types.js";
import { idx } from "../geometry.js";
import { arena, held, humans, own, ownerAt, popAt } from "./testkit.js";

describe("march", () => {
  let sim: Sim;

  const buy = (): void => {
    sim.state.empires[0]!.diamonds = sim.state.genesis.rules.marchCost;
    sim.advance([{ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.BUY_MARCH, x: 0, y: 0 }]);
  };
  const march = (x: number, y: number) =>
    sim.advance([{ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x, y }]);

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    own(sim, 5, 5, 1);
    buy();
    sim.state.empires[0]!.members[0]!.popTimer = 100;
    march(7, 5);
  });

  it("one purchase unlocks it for good", () => {
    expect(sim.state.empires[0]!.marchUnlocked).toBe(1);
    expect(sim.state.empires[0]!.diamonds).toBe(0);
  });

  it("and buying it twice is refused rather than wasted", () => {
    sim.state.empires[0]!.diamonds = 99;
    expect(
      sim.validate({ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.BUY_MARCH, x: 0, y: 0 }),
    ).toBe(false);
  });

  it("the far tile is taken", () => expect(ownerAt(sim, 7, 5)).toBe(1));

  it("and the tile in between with it", () => expect(ownerAt(sim, 6, 5)).toBe(1));

  it("the two share one population spend", () => {
    expect(popAt(sim, 6, 5) + popAt(sim, 7, 5)).toBe(100);
  });

  // Zeroed by the march, then the same step's accrual puts one back.
  it("the timer was spent", () => {
    expect(sim.state.empires[0]!.members[0]!.popTimer).toBe(1);
  });

  it("a diagonal reach works too", () => {
    sim.state.empires[0]!.members[0]!.popTimer = 60;
    march(8, 6);
    expect(ownerAt(sim, 8, 6)).toBe(1);
  });

  it("a tile already on the border is refused — that is a plain claim", () => {
    sim.state.empires[0]!.members[0]!.popTimer = 60;
    expect(
      sim.validate({ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 5, y: 4 }),
    ).toBe(false);
  });

  // Nothing is consumed, so an empire that has it can march every turn.
  it("marching costs no stock", () => {
    sim.state.empires[0]!.diamonds = 0;
    sim.state.empires[0]!.members[0]!.popTimer = 60;
    expect(sim.state.empires[0]!.marchUnlocked).toBe(1);
    expect(
      sim.validate({ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 10, y: 5 }),
    ).toBe(true);
  });

  it("and an empire without the upgrade cannot", () => {
    const s2 = arena([humans(1), humans(1)]);
    own(s2, 5, 5, 1);
    s2.state.empires[0]!.members[0]!.popTimer = 60;
    expect(
      s2.validate({ step: s2.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }),
    ).toBe(false);
  });

  it("cannot cross a mountain — there is no via tile to walk through", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    s.state.terrain[idx(6, 5, s.state.width)] = TERRAIN.MOUNTAIN;
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    expect(
      s.validate({ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }),
    ).toBe(false);
  });

  // A volley, not a column: rival ground is what it is for.
  it("lands on a tile another empire holds", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    own(s, 7, 5, 2, 10);
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }]);
    expect(ownerAt(s, 7, 5)).toBe(1);
    expect(popAt(s, 7, 5)).toBe(40); // half of 100, less the 10 that was there
  });

  it("and through one on the way", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    own(s, 6, 5, 2, 10);
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }]);
    expect(ownerAt(s, 6, 5)).toBe(1);
    expect(ownerAt(s, 7, 5)).toBe(1);
  });

  // A pocket the upkeep sweep cut off is exactly the gap a march is for.
  it("or on its own disconnected tile", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    own(s, 7, 5, 1, 3);
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    expect(
      s.validate({ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }),
    ).toBe(true);
  });

  // The last square of a siege has to be walked onto. Otherwise a ranged move
  // ends the game from two tiles out, with no turn in which to answer it.
  it("but never onto a capital", () => {
    const s = arena([humans(1), humans(1)]);
    const home = s.state.empires[1]!.capital;
    const hx = home % s.state.width;
    const hy = Math.floor(home / s.state.width);
    own(s, hx - 2, hy, 1);
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 999;
    expect(
      s.validate({ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: hx, y: hy }),
    ).toBe(false);
  });

  it("nor through one", () => {
    const s = arena([humans(1), humans(1)]);
    const home = s.state.empires[1]!.capital;
    const hx = home % s.state.width;
    const hy = Math.floor(home / s.state.width);
    own(s, hx - 1, hy + 1, 1);
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 999;
    // (hx, hy + 1) is the only via, and it is not the capital — but reaching
    // the capital itself would have to pass through it, and the target is
    // shielded regardless.
    expect(
      s.validate({ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: hx, y: hy }),
    ).toBe(false);
  });

  // Which leaves the siege intact: take the ground around it at range, then
  // walk onto the last square from a tile that is touching it.
  it("a capital still falls to a claim made from beside it", () => {
    const s = arena([humans(1), humans(1)]);
    const home = s.state.empires[1]!.capital;
    const hx = home % s.state.width;
    const hy = Math.floor(home / s.state.width);
    own(s, hx - 1, hy, 1, 1);
    s.state.empires[0]!.members[0]!.popTimer = 999;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.CLAIM, x: hx, y: hy }]);
    expect(ownerAt(s, hx, hy)).toBe(1);
    expect(s.state.empires[1]!.alive).toBe(0);
  });

  it("a diamond in the gap is collected", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    s.state.item[idx(6, 5, s.state.width)] = ITEM.DIAMOND;
    s.state.itemCount = 1;
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }]);
    expect(s.state.empires[0]!.diamonds).toBe(1);
    expect(s.state.item[idx(6, 5, s.state.width)]).toBe(ITEM.NONE);
  });

  it("and a coin in the gap fires", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    s.state.item[idx(6, 5, s.state.width)] = ITEM.BRONZE;
    s.state.itemCount = 1;
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }]);
    expect(s.state.item[idx(6, 5, s.state.width)]).toBe(ITEM.NONE);
    // The seed tile, the gap and the target, plus the two arms of the bronze
    // ball that were not already among them.
    expect(held(s, 1)).toBe(5);
  });

  it("a coin under a march is left where it lies", () => {
    const s = arena([humans(1), humans(1)]);
    own(s, 5, 5, 1);
    s.state.item[idx(7, 5, s.state.width)] = 3; // gold
    s.state.itemCount = 1;
    s.state.empires[0]!.marchUnlocked = 1;
    s.state.empires[0]!.members[0]!.popTimer = 100;
    s.advance([{ step: s.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: 7, y: 5 }]);
    expect(s.state.item[idx(7, 5, s.state.width)]).toBe(3);
    expect(held(s, 1)).toBe(3); // the seed tile and the two marched onto
  });
});
