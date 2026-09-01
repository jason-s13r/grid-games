// What one click on the board means.
//
// Pulled out of main.ts because this is where the arming bug lived and there
// was nowhere to test it: the dispatch was welded into the module body next to
// the pointer listeners, so proving that a placed bridge hands the board back
// meant opening two tabs and trying it.

import { MOVE } from "@tessera/sim";
import type { Driver } from "./Driver";
import type { Controls } from "../view/Controls";

/** Spend a click on the tile at (x, y), whatever the sidebar has armed.
 *
 *  Every armed mode disarms on a placement that actually took. Leaving it
 *  armed was the bug that made a bought bridge unplayable: the next click was
 *  another PLACE_BRIDGE against an empty stock, it failed validation in
 *  silence, and the game looked frozen. A rejected click keeps the arming,
 *  because the player almost certainly just missed the tile they meant. */
export function boardClick(game: Driver, controls: Controls, x: number, y: number): void {
  switch (controls.placeMode) {
    case "bridge":
      if (game.act(MOVE.PLACE_BRIDGE, x, y)) controls.disarm();
      return;

    case "ladder":
      if (game.act(MOVE.PLACE_LADDER, x, y)) controls.disarm();
      return;

    default:
      game.claim(x, y);
  }
}
