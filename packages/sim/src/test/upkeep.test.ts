// Supply lines: what a capital still reaches, and what happens to the rest.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, makeGenesis } from "../sim.js";
import { EVENT } from "../events.js";
import { upkeep } from "../upkeep.js";
import { idx } from "../geometry.js";
import { arena, at, held, humans, own, ownerAt, popAt } from "./testkit.js";

/** Connect a run of tiles from the parked capital down into the working area,
 *  so an empire in the arena has a supply line to be cut. */
function supply(sim: Sim, empire: number, toX: number, toY: number): void {
  const capitalX = empire * 2;
  for (let y = 1; y <= toY; y++) own(sim, capitalX, y, empire);
  const step = toX > capitalX ? 1 : -1;
  for (let x = capitalX + step; x !== toX + step; x += step) own(sim, x, toY, empire);
}

describe("population decay", () => {
  let sim: Sim;
  const sweep = (n: number) => {
    for (let i = 0; i < n; i++) upkeep(sim.state, new Set());
  };

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    supply(sim, 1, 8, 6);
    own(sim, 8, 7, 1, 80); // connected, hanging off the end of the line
    own(sim, 15, 15, 1, 80); // an island, connected to nothing
  });

  it("a tile the capital reaches is untouched", () => {
    sweep(1);
    expect(popAt(sim, 8, 7)).toBe(80);
  });

  it("a tile it does not reach loses an eighth", () => {
    expect(popAt(sim, 15, 15)).toBe(70);
  });

  // 70 -> 62 -> 55: an eighth of what is left each time, floored.
  it("and keeps losing it", () => {
    sweep(2);
    expect(popAt(sim, 15, 15)).toBe(55);
  });

  it("until it goes neutral", () => {
    sweep(60);
    expect([popAt(sim, 15, 15), ownerAt(sim, 15, 15)]).toEqual([0, 0]);
  });

  it("the connected tile survived all of it", () => {
    expect([popAt(sim, 8, 7), ownerAt(sim, 8, 7)]).toEqual([80, 1]);
  });

  it("and the empire's tile count followed the loss", () => {
    expect(ownerAt(sim, 15, 15)).toBe(0);
    expect(held(sim, 1)).toBe(sim.state.empires[0]!.tilesOwned - 1);
  });

  // Cutting a supply line should orphan everything behind the cut, not just
  // the tile that was cut.
  it("severing the line orphans what was behind it", () => {
    const line = at(sim, 2, 3);
    sim.state.owner[line] = 0;
    sim.state.pop[line] = 0;
    sim.state.empires[0]!.tilesOwned--;

    sweep(1);
    expect(popAt(sim, 8, 7)).toBeLessThan(80);
  });
});

describe("upkeep runs on its own schedule", () => {
  it("the sweep is scheduled and reschedules itself", () => {
    const sim = new Sim(
      makeGenesis({
        seed: 3,
        empires: [humans(1), humans(1)],
        map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
        rules: { upkeepInterval: 12, coinIntervalMin: 1 << 28, coinIntervalMax: 1 << 28 },
      }),
    );
    const island = idx(20, 20, sim.state.width);
    sim.state.owner[island] = 1;
    sim.state.pop[island] = 400;
    sim.state.empires[0]!.tilesOwned++;
    sim.state.empires[0]!.popTotal += 400;

    for (let i = 0; i < 40; i++) sim.advance([]);
    expect(sim.state.pop[island]).toBeLessThan(400);

    const pending = sim.state.events.toSorted().filter((e) => e.type === EVENT.UPKEEP);
    expect(pending.length).toBe(1);
  });
});

