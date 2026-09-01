// One click on the board, and what it costs you.
//
// The bug this exists for: after placing a bridge the board stayed armed for
// "bridge" with nothing left to place, so every following click was a
// PLACE_BRIDGE that failed validation in silence. The player could not claim a
// tile again for the rest of the game, with no error and no clue why.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEPS_PER_SECOND, TERRAIN, idx } from "@tessera/sim";
import { LocalGame } from "../game/Local";
import { Controls } from "../view/Controls";
import { boardClick } from "../game/input";

/** Controls only needs somewhere to hang a listener and somewhere to write
 *  markup; the DOM itself is not what is under test here. */
const stub = () =>
  ({ addEventListener() {}, innerHTML: "", textContent: "", hidden: false }) as unknown as HTMLElement;

const controlsFor = (game: LocalGame): Controls =>
  new Controls(game, {
    you: stub(),
    standings: stub(),
    clock: stub(),
    banner: stub(),
    zoomhint: stub(),
  });

describe("clicking the board", () => {
  let game: LocalGame;
  let controls: Controls;
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
    controls = controlsFor(game);
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

  it("an unarmed click claims", () => {
    const before = tilesHeld();
    boardClick(game, controls, ownX + 1, ownY);
    run(4);
    expect(tilesHeld()).toBeGreaterThan(before);
    expect(controls.placeMode).toBe("none");
  });

  describe("placing a bridge", () => {
    beforeEach(() => {
      const river = idx(ownX + 1, ownY, game.sim.state.width);
      game.sim.state.terrain[river] = TERRAIN.RIVER;
      empire.bridges = 1;
      controls.placeMode = "bridge";
    });

    it("the placement is accepted", () => {
      boardClick(game, controls, ownX + 1, ownY);
      expect(controls.placeMode).toBe("none");
    });

    it("and the board is claimable again straight afterwards", () => {
      boardClick(game, controls, ownX + 1, ownY);
      run(4); // let the queued PLACE_BRIDGE apply
      expect(game.sim.state.terrain[idx(ownX + 1, ownY, game.sim.state.width)]).toBe(
        TERRAIN.RIVER_BRIDGED,
      );

      empire.members[0]!.popTimer = 400;
      const before = tilesHeld();
      boardClick(game, controls, ownX, ownY + 1);
      run(4);
      expect(tilesHeld()).toBeGreaterThan(before);
    });

    it("a miss keeps the arming, because the player meant to place", () => {
      boardClick(game, controls, ownX + 3, ownY + 3); // not a river tile
      expect(controls.placeMode).toBe("bridge");
    });
  });

  describe("running out of stock", () => {
    it("render disarms a mode nothing is left for", () => {
      empire.bridges = 0;
      controls.placeMode = "bridge";
      controls.render(game.sim.state);
      expect(controls.placeMode).toBe("none");
    });

    it("and leaves a mode that still has stock alone", () => {
      empire.ladders = 2;
      controls.placeMode = "ladder";
      controls.render(game.sim.state);
      expect(controls.placeMode).toBe("ladder");
    });
  });
});
