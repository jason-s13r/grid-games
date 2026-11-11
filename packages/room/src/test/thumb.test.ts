// The listings' map: small, faithful to who holds what, and sent sparingly.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, TERRAIN, makeGenesis, simbot } from "@tessera/sim";
import type { Identity } from "@tessera/protocol";
import { THUMB_WIDTH, TERRAIN_BASE, thumbnail } from "../thumb.js";
import { MAP_EVERY_MS } from "../room.js";
import { Harness, identities } from "./harness.js";

let alice: Identity;

beforeAll(async () => {
  [alice] = (await identities(1)) as [Identity];
});

const world = (width: number, height: number) =>
  new Sim(makeGenesis({ seed: 99, map: { width, height }, empires: [simbot("easy"), simbot("easy")] }));

describe("the thumbnail", () => {
  it("keeps a small map at a tile a cell", () => {
    const sim = world(48, 36);
    const thumb = thumbnail(sim.state, ["cobalt", "amber"], sim.step);
    expect([thumb.width, thumb.height]).toEqual([48, 36]);
    for (let i = 0; i < thumb.cells.length; i++) {
      const owner = sim.state.owner[i]!;
      const terrain = sim.state.terrain[i]!;
      const want = owner > 0 ? owner : terrain === TERRAIN.PLAIN ? 0 : TERRAIN_BASE + terrain;
      expect(thumb.cells[i]).toBe(want);
    }
  });

  it("shrinks a wide map to fit, each cell what covers most of its square", () => {
    const sim = world(256, 176);
    for (let i = 0; i < 2000; i++) sim.advance();
    const thumb = thumbnail(sim.state, [], sim.step);
    expect(thumb.width).toBeLessThanOrEqual(THUMB_WIDTH);
    expect(thumb.width).toBe(Math.ceil(256 / 3));
    expect(thumb.height).toBe(Math.ceil(176 / 3));
    // Every empire with ground on the map still shows somewhere.
    const shown = new Set(thumb.cells);
    for (const empire of sim.state.empires) if (empire.tilesOwned > 9) expect(shown.has(empire.id)).toBe(true);
  });
});

describe("the room", () => {
  it("sends the map at the start, then no more often than it should", async () => {
    const h = new Harness({ creator: alice.key, bots: ["easy"] });
    const a = await h.join(alice);
    a.client.pickBanner("sping");
    await h.settle();
    a.client.start();
    await h.settle();
    expect(h.maps).toHaveLength(1);
    expect(h.maps[0]!.map.step).toBe(0);
    expect(h.maps[0]!.map.banners[0]).toBe("sping");

    // Snapshots come every couple of game minutes; maps do not.
    await h.run(5 * 60_000, 5_000);
    expect(h.maps).toHaveLength(1);
    await h.run(MAP_EVERY_MS, 5_000);
    expect(h.maps).toHaveLength(2);
    expect(h.maps[1]!.map.step).toBeGreaterThan(0);
  });
});
