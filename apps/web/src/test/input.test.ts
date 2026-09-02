// One click on the board, and what it means.
//
// The board has no modes. What used to be "arm bridge, then click a river" is
// now just "click a river", because a bridge was never able to go anywhere
// else. These tests pin that down from both ends: the right move goes out for
// the terrain under the cursor, and a click the rules will refuse costs the
// player nothing but the click.
//
// The bug this file was originally written for: a mode left armed with nothing
// in stock swallowed every later click in silence, and the game looked frozen.
// It cannot happen now — there is no mode to leave armed — but the property it
// was really about still matters, so "the board is claimable straight after a
// placement" is kept below.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEPS_PER_SECOND, TERRAIN, idx } from "@tessera/sim";
import { LocalGame } from "../game/Local";
import { Controls } from "../view/Controls";
import { boardClick } from "../game/input";

/** Controls only needs somewhere to hang a listener and somewhere to write
 *  markup; the DOM itself is not what is under test here. */
const stub = () =>
  ({ addEventListener() {}, innerHTML: "", textContent: "", hidden: false }) as unknown as HTMLElement;

const elementsFor = () => ({
  hud: stub(),
  acts: stub(),
  standings: stub(),
  roster: stub(),
  rosterPanel: stub(),
  clock: stub(),
  banner: stub(),
  zoomhint: stub(),
});

describe("clicking the board", () => {
  let game: LocalGame;
  let empire: LocalGame["sim"]["state"]["empires"][number];

  // LocalGame derives its step from wall-clock time, so three tick() calls in
  // the same millisecond advance nothing at all. Drive the clock instead.
  let now = 0;
  const run = (steps: number): void => {
    now += (steps * 1000) / STEPS_PER_SECOND;
    game.tick();
  };

  /** Where the empire sits, with a clearing around it. Built by hand so the
   *  test does not depend on what mapgen happened to put there. */
  const ownX = 5;
  const ownY = 5;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    game = new LocalGame({ seed: 7, bots: 1, teammates: 0, width: 32, height: 32 });
    const state = game.sim.state;
    empire = state.empires[0]!;

    for (let y = 4; y <= 8; y++) {
      for (let x = 4; x <= 8; x++) {
        const i = idx(x, y, state.width);
        state.terrain[i] = TERRAIN.PLAIN;
        state.item[i] = 0;
      }
    }
    const home = idx(ownX, ownY, state.width);
    state.owner[home] = empire.id;
    state.pop[home] = 1;
    empire.tilesOwned++;
    empire.popTotal++;
    empire.members[0]!.popTimer = 400;
  });

  afterEach(() => vi.restoreAllMocks());

  const tilesHeld = () => empire.tilesOwned;
  const terrainAt = (x: number, y: number) =>
    game.sim.state.terrain[idx(x, y, game.sim.state.width)];
  const ownerAt = (x: number, y: number) =>
    game.sim.state.owner[idx(x, y, game.sim.state.width)];

  it("plain ground beside the border is claimed", () => {
    const before = tilesHeld();
    boardClick(game, ownX + 1, ownY);
    run(4);
    expect(tilesHeld()).toBeGreaterThan(before);
  });

  describe("a river", () => {
    beforeEach(() => {
      game.sim.state.terrain[idx(ownX + 1, ownY, game.sim.state.width)] = TERRAIN.RIVER;
    });

    it("is bridged by a plain click when a bridge is in hand", () => {
      empire.bridges = 1;
      boardClick(game, ownX + 1, ownY);
      run(4);
      expect(terrainAt(ownX + 1, ownY)).toBe(TERRAIN.RIVER_BRIDGED);
    });

    it("and the board is claimable again straight afterwards", () => {
      empire.bridges = 1;
      boardClick(game, ownX + 1, ownY);
      run(4);

      empire.members[0]!.popTimer = 400;
      const before = tilesHeld();
      boardClick(game, ownX, ownY + 1);
      run(4);
      expect(tilesHeld()).toBeGreaterThan(before);
    });

    // Nothing is spent and nothing is stuck: the rules refuse it, and the next
    // click is an ordinary click again.
    it("stays a river when there is no bridge to spend", () => {
      empire.bridges = 0;
      boardClick(game, ownX + 1, ownY);
      run(4);
      expect(terrainAt(ownX + 1, ownY)).toBe(TERRAIN.RIVER);

      const before = tilesHeld();
      boardClick(game, ownX, ownY + 1);
      run(4);
      expect(tilesHeld()).toBeGreaterThan(before);
    });
  });

  it("a wall is laddered by a plain click when a ladder is in hand", () => {
    game.sim.state.terrain[idx(ownX + 1, ownY, game.sim.state.width)] = TERRAIN.WALL;
    empire.ladders = 1;
    boardClick(game, ownX + 1, ownY);
    run(4);
    expect(terrainAt(ownX + 1, ownY)).toBe(TERRAIN.WALL_LADDERED);
  });

  describe("marching", () => {
    it("a tile two out is marched to once march is bought", () => {
      empire.marchUnlocked = 1;
      boardClick(game, ownX + 2, ownY);
      run(4);
      expect(ownerAt(ownX + 2, ownY)).toBe(empire.id);
    });

    it("and the tile between comes with it", () => {
      empire.marchUnlocked = 1;
      boardClick(game, ownX + 2, ownY);
      run(4);
      expect(ownerAt(ownX + 1, ownY)).toBe(empire.id);
    });

    it("a tile on the border is an ordinary claim, not a wasted march", () => {
      empire.marchUnlocked = 1;
      const before = tilesHeld();
      boardClick(game, ownX + 1, ownY);
      run(4);
      expect(tilesHeld()).toBe(before + 1);
    });

    it("and without march the same click reaches nothing", () => {
      empire.marchUnlocked = 0;
      boardClick(game, ownX + 2, ownY);
      run(4);
      expect(ownerAt(ownX + 2, ownY)).toBe(0);
    });
  });

  describe("the shop", () => {
    it("offers march until it is bought, and never again", () => {
      const els = elementsFor();
      const controls = new Controls(game, els);

      controls.render(game.sim.state);
      expect(els.acts.innerHTML).toContain('data-buy="march"');

      empire.marchUnlocked = 1;
      controls.render(game.sim.state);
      expect(els.acts.innerHTML).not.toContain('data-buy="march"');
    });

    it("shows a bought modifier on the HUD instead", () => {
      const els = elementsFor();
      const controls = new Controls(game, els);

      controls.render(game.sim.state);
      expect(els.hud.innerHTML).not.toContain("Growth");

      empire.growthUnlocked = 1;
      controls.render(game.sim.state);
      expect(els.hud.innerHTML).toContain("Growth");
    });

    it("keeps bridges buyable however many are already held", () => {
      const els = elementsFor();
      const controls = new Controls(game, els);

      empire.bridges = 3;
      empire.diamonds = 99;
      controls.render(game.sim.state);
      expect(els.acts.innerHTML).toContain('data-buy="bridge"');
      expect(els.acts.innerHTML).toContain("&times;3");
    });
  });
});
