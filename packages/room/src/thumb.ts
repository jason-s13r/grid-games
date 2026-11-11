// A game's map, small: what the listings draw beside each game.
//
// One byte per cell, a cell being a square of tiles, each cell taking
// whatever covers most of its square. The room builds it from the state it
// already has; the host decides where it is kept.

import { TERRAIN } from "@tessera/sim";
import type { BannerId, State } from "@tessera/sim";

/** Cells across, at most. A map narrower than this is drawn a tile a cell. */
export const THUMB_WIDTH = 96;

/** Cell values from here up are unowned ground of terrain `value - TERRAIN_BASE`.
 *  Below it, 0 is open plain and anything else is the empire that holds it. */
export const TERRAIN_BASE = 240;

export interface MapThumb {
  width: number;
  height: number;
  /** `width * height` cells, row by row. */
  cells: Uint8Array;
  /** The house each empire flies, by empire id from 1, so the map can be
   *  coloured without the genesis. */
  banners: BannerId[];
  /** The step it shows. */
  step: number;
}

/** The value a tile contributes to its cell. */
function code(state: State, i: number): number {
  const owner = state.owner[i]!;
  if (owner > 0) return owner;
  const terrain = state.terrain[i]!;
  return terrain === TERRAIN.PLAIN ? 0 : TERRAIN_BASE + terrain;
}

export function thumbnail(state: State, banners: BannerId[], step: number): MapThumb {
  const scale = Math.max(1, Math.ceil(state.width / THUMB_WIDTH));
  const width = Math.ceil(state.width / scale);
  const height = Math.ceil(state.height / scale);
  const cells = new Uint8Array(width * height);
  const counts = new Uint16Array(256);
  const seen: number[] = [];

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      seen.length = 0;
      const y1 = Math.min(state.height, (cy + 1) * scale);
      const x1 = Math.min(state.width, (cx + 1) * scale);
      for (let y = cy * scale; y < y1; y++) {
        for (let x = cx * scale; x < x1; x++) {
          const value = code(state, y * state.width + x);
          if (counts[value]++ === 0) seen.push(value);
        }
      }
      // The commonest, and on a tie the first seen, so the same state always
      // gives the same picture.
      let best = seen[0]!;
      for (const value of seen) if (counts[value]! > counts[best]!) best = value;
      cells[cy * width + cx] = best;
      for (const value of seen) counts[value] = 0;
    }
  }
  return { width, height, cells, banners, step };
}
