// What a capital is actually worth.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, CLAIM } from "../sim.js";
import { at, arena, humans, own, ownerAt, popAt } from "./testkit.js";
import { ITEM, MOVE } from "../types.js";

describe("taking a capital annexes the empire", () => {
  let sim: Sim;
  let victimTiles: number;

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    // Empire 2's capital is parked at (4,0); reach it from empire 1's at (2,0).
    own(sim, 3, 0, 1);
    for (let y = 1; y <= 5; y++) own(sim, 4, y, 2, 10);
    victimTiles = sim.state.empires[1]!.tilesOwned;
    sim.state.empires[1]!.diamonds = 4;
    sim.state.empires[1]!.bridges = 2;
    sim.state.empires[1]!.marchUnlocked = 1;
    sim.state.empires[0]!.members[0]!.popTimer = 500;
    sim.advance([CLAIM(sim.step, 1, 0, 0, 4, 0)]);
  });

  it("the capital changed hands", () => expect(ownerAt(sim, 4, 0)).toBe(1));

  it("and so did everything behind it", () => {
    expect(ownerAt(sim, 4, 3)).toBe(1);
    expect(sim.state.empires[1]!.tilesOwned).toBe(0);
  });

  it("the attacker's tile count grew by the whole empire", () => {
    expect(sim.state.empires[0]!.tilesOwned).toBeGreaterThanOrEqual(victimTiles);
  });

  it("the population came with the land", () => {
    expect(popAt(sim, 4, 3)).toBe(10);
    let sum = 0;
    for (let i = 0; i < sim.state.owner.length; i++) {
      if (sim.state.owner[i] === 1) sum += sim.state.pop[i]!;
    }
    expect(sim.state.empires[0]!.popTotal).toBe(sum);
  });

  it("the victim's books are empty", () => {
    expect(sim.state.empires[1]!.popTotal).toBe(0);
  });

  it("unspent stock is spoils", () => {
    expect(sim.state.empires[0]!.diamonds).toBe(4);
    expect(sim.state.empires[0]!.bridges).toBe(2);
    expect(sim.state.empires[1]!.diamonds).toBe(0);
  });

  it("and so is what they had learned", () => {
    expect(sim.state.empires[0]!.marchUnlocked).toBe(1);
  });

  it("and the victim is out", () => {
    expect(sim.state.empires[1]!.alive).toBe(0);
  });
});

// A capital falls to a deliberate claim from beside it, and to nothing else.
// Everything that reaches a tile without anybody choosing that tile — a coin's
// ball, a march landing two out — stops at the home square.
describe("and nothing else takes one", () => {
  /** Empire 2's capital, and the tile to its left. */
  const board = (): { sim: Sim; hx: number; hy: number } => {
    const sim = arena([humans(1), humans(1)]);
    const home = sim.state.empires[1]!.capital;
    return { sim, hx: home % sim.state.width, hy: Math.floor(home / sim.state.width) };
  };

  it("a cascade sweeps over it and leaves it standing", () => {
    const { sim, hx, hy } = board();
    own(sim, hx - 2, hy + 1, 1);
    sim.state.item[at(sim, hx - 1, hy + 1)] = ITEM.SILVER;
    sim.state.itemCount = 1;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    sim.advance([CLAIM(sim.step, 1, 0, 0, hx - 1, hy + 1)]);
    // The ball reaches it — the tile beside it changed hands — and the capital
    // did not.
    expect(ownerAt(sim, hx - 1, hy)).toBe(1);
    expect(ownerAt(sim, hx, hy)).toBe(2);
    expect(sim.state.empires[1]!.alive).toBe(1);
  });

  // Landing exactly level used to be worse than landing one short: the home
  // emptied, went neutral, and the empire was eliminated by not owning it —
  // with nobody inheriting, because annexation fires on a capture.
  it("emptying one is not taking one", () => {
    const { sim, hx, hy } = board();
    own(sim, hx - 1, hy, 1);
    for (let y = 1; y <= 3; y++) own(sim, hx, hy + y, 2, 10);
    sim.state.pop[at(sim, hx, hy)] = 40;
    sim.state.empires[1]!.popTotal = 70;
    sim.state.empires[0]!.members[0]!.popTimer = 40;
    sim.advance([CLAIM(sim.step, 1, 0, 0, hx, hy)]);

    expect(popAt(sim, hx, hy)).toBe(0);
    expect(ownerAt(sim, hx, hy)).toBe(2);
    expect(sim.state.empires[1]!.alive).toBe(1);
    expect(ownerAt(sim, hx, hy + 2)).toBe(2);
  });

  it("and the click that walks onto it does", () => {
    const { sim, hx, hy } = board();
    own(sim, hx - 1, hy, 1);
    for (let y = 1; y <= 3; y++) own(sim, hx, hy + y, 2, 10);
    sim.state.pop[at(sim, hx, hy)] = 40;
    sim.state.empires[1]!.popTotal = 70;
    sim.state.empires[0]!.members[0]!.popTimer = 40;
    sim.advance([CLAIM(sim.step, 1, 0, 0, hx, hy)]);
    sim.state.empires[0]!.members[0]!.popTimer = 1;
    sim.advance([CLAIM(sim.step, 1, 0, 0, hx, hy)]);

    expect(ownerAt(sim, hx, hy)).toBe(1);
    expect(sim.state.empires[1]!.alive).toBe(0);
    expect(ownerAt(sim, hx, hy + 2)).toBe(1);
    expect(sim.state.empires[1]!.tilesOwned).toBe(0);
  });

  // Everything that is not a home still empties to neutral.
  it("an ordinary tile emptied goes to nobody", () => {
    const { sim, hx, hy } = board();
    own(sim, hx - 1, hy + 2, 1);
    own(sim, hx, hy + 2, 2, 40);
    sim.state.empires[0]!.members[0]!.popTimer = 40;
    sim.advance([CLAIM(sim.step, 1, 0, 0, hx, hy + 2)]);
    expect(popAt(sim, hx, hy + 2)).toBe(0);
    expect(ownerAt(sim, hx, hy + 2)).toBe(0);
  });

  it("a march is refused outright", () => {
    const { sim, hx, hy } = board();
    own(sim, hx - 2, hy, 1);
    sim.state.empires[0]!.marchUnlocked = 1;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    expect(
      sim.validate({ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.MARCH, x: hx, y: hy }),
    ).toBe(false);
  });
});
