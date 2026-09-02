// What one click on the board means.
//
// There are no modes. A river is a river whether or not you remembered to arm
// a button first, so the click says where and the board says what: bridges go
// on rivers, ladders go on walls, and a claim that reaches one tile too far is
// a march if the empire has bought one. Arming was a step between deciding and
// doing that only ever existed to disambiguate something the map already knew,
// and it cost a whole class of bug — a mode left armed with nothing in stock
// swallowed every later click in silence.
//
// The dispatch deliberately does not re-check stock or adjacency. Those are
// validation's business, and stating them twice is how the two drift apart;
// an unaffordable bridge is refused by the rules exactly as it was before.

import { MOVE, TERRAIN, adjacentToOwned, idx } from "@tessera/sim";
import type { Driver } from "./Driver";

export function boardClick(game: Driver, x: number, y: number): void {
  const state = game.sim.state;
  const empire = state.empires[game.empire - 1];
  if (!empire) return;

  // TERRAIN.RIVER and TERRAIN.WALL are the *uncrossed* forms — once bridged or
  // laddered they become their own passable terrain and fall through to a
  // claim, which is what you want the second click on a bridge to do.
  switch (state.terrain[idx(x, y, state.width)]) {
    case TERRAIN.RIVER:
      game.act(MOVE.PLACE_BRIDGE, x, y);
      return;
    case TERRAIN.WALL:
      game.act(MOVE.PLACE_LADDER, x, y);
      return;
  }

  // A march is refused outright on a tile already touching the border, so
  // adjacency is what separates the two rather than anything the player sets.
  if (!adjacentToOwned(state, x, y, game.empire) && empire.marchUnlocked) {
    game.act(MOVE.MARCH, x, y);
    return;
  }
  game.claim(x, y);
}
