// What a capital is actually worth.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, CLAIM } from "../sim.js";
import { arena, humans, own, ownerAt, popAt } from "./testkit.js";

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

  it("and the victim is out", () => {
    expect(sim.state.empires[1]!.alive).toBe(0);
  });
});
