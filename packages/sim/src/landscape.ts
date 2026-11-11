// Terrain for maps composed with `terrain: 2`: a landscape rather than
// scattered features.
//
// Mountains stand in ranges. Lakes lie in the low ground. Rivers rise at the
// foot of the mountains and in the hills, run downhill, meet each other, and
// end in a lake or run off the edge of the map, some lakes spilling on to the
// edge themselves. Walls are ruins: corners, short runs and broken rings.
//
// The ground has a height, from seeded value noise, and water follows it: a
// priority flood from the map's edge gives every tile the neighbour it drains
// to, so a river is a walk down those pointers, and two rivers that reach the
// same ground run together from there on. A confluence is where one walk meets
// a tile another has already made river.
//
// Integer arithmetic throughout, and a heap that breaks ties on the tile
// index, so every peer draws the same land. Runs once at genesis, from the
// shared seed, like the generator before it (see mapgen.ts), which games
// composed without `terrain` still use.

import { TERRAIN } from "./types.js";
import { ORTHO, idx, inBounds, xOf, yOf } from "./geometry.js";
import type { State } from "./state.js";

/** The eight ways a range can run, clockwise from north. */
const DIRS8: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function landscape(state: State): void {
  const height = ground(state);
  ranges(state, height);
  const lakeOf = lakes(state, height);
  // Two ways down: to a lake or the edge, which is where rivers go; and to the
  // edge alone, which is the way a lake spills.
  const down = drainage(state, height, true);
  const spill = drainage(state, height, false);
  rivers(state, height, down, spill, lakeOf);
  ruins(state);
}

// --- height ------------------------------------------------------------------

/** Value noise: a lattice of random heights `spacing` apart, smoothly
 *  interpolated between. Fixed point, so exact on every engine. */
function noise(state: State, spacing: number, amp: number, into: Int32Array): void {
  const { width, height, rng } = state;
  const gw = Math.floor(width / spacing) + 2;
  const gh = Math.floor(height / spacing) + 2;
  const lattice = new Int32Array(gw * gh);
  for (let k = 0; k < lattice.length; k++) lattice[k] = rng.int(amp + 1);

  const s3 = spacing * spacing * spacing;
  // Smoothstep on 0..spacing, scaled to 0..s3.
  const ease = (t: number) => t * t * (3 * spacing - 2 * t);
  for (let y = 0; y < height; y++) {
    const gy = Math.floor(y / spacing);
    const fy = ease(y - gy * spacing);
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / spacing);
      const fx = ease(x - gx * spacing);
      const a = lattice[gy * gw + gx]!;
      const b = lattice[gy * gw + gx + 1]!;
      const c = lattice[(gy + 1) * gw + gx]!;
      const d = lattice[(gy + 1) * gw + gx + 1]!;
      const top = a * (s3 - fx) + b * fx;
      const bottom = c * (s3 - fx) + d * fx;
      into[idx(x, y, width)]! += Math.floor((top * (s3 - fy) + bottom * fy) / (s3 * s3));
    }
  }
}

/** Rolling ground, with fine noise on top so water meanders across it rather
 *  than running in straight lines. */
function ground(state: State): Int32Array {
  const h = new Int32Array(state.width * state.height);
  noise(state, 16, 1000, h);
  noise(state, 5, 320, h);
  noise(state, 2, 90, h);
  return h;
}

// --- mountains ---------------------------------------------------------------

/** How many ranges a map has: scaled with its area, by way of `mountains`. */
const rangeCount = (state: State): number => {
  const m = state.genesis.map.mountains;
  return m > 0 ? Math.max(1, Math.round(m / 10)) : 0;
};

/** Ranges: a spine that wanders as it runs, a tile or two either side of it,
 *  with the odd spur.
 *  The ground is raised around them, so water runs away from the mountains
 *  rather than into them. About as much mountain as the old blobs made. */
function ranges(state: State, h: Int32Array): void {
  const { width, height, rng, terrain } = state;
  const cfg = state.genesis.map;
  const count = rangeCount(state);

  for (let r = 0; r < count; r++) {
    let x = rng.int(width);
    let y = rng.int(height);
    let dir = rng.int(8);
    let half = 1;
    // The same length on any map: a bigger map gets more ranges, not longer.
    const length = rng.range(18, 36);
    for (let step = 0; step < length; step++) {
      for (let dy = -half - 3; dy <= half + 3; dy++) {
        for (let dx = -half - 3; dx <= half + 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny, width, height)) continue;
          const i = idx(nx, ny, width);
          const d2 = dx * dx + dy * dy;
          if (d2 <= half * half + half) {
            if (terrain[i] !== TERRAIN.MOUNTAIN) h[i]! += 2400;
            terrain[i] = TERRAIN.MOUNTAIN;
          } else if (terrain[i] !== TERRAIN.MOUNTAIN) {
            // Foothills, highest nearest the range.
            h[i] = Math.max(h[i]!, h[i]! + 60 * (16 - Math.min(16, d2)));
          }
        }
      }
      // Now and then a spur off to one side, a few tiles long.
      // A tile thick, so it reads as ground and not a line drawn on it.
      if (rng.int(10) === 0) {
        const side = (dir + (rng.int(2) === 0 ? 2 : 6)) % 8;
        const reach = rng.range(2, 4);
        for (let k = 1; k <= reach; k++) {
          const sx = x + DIRS8[side]![0] * k;
          const sy = y + DIRS8[side]![1] * k;
          for (const [dx, dy] of [[0, 0], ...ORTHO] as const) {
            if (!inBounds(sx + dx, sy + dy, width, height)) continue;
            const i = idx(sx + dx, sy + dy, width);
            if (terrain[i] !== TERRAIN.MOUNTAIN) h[i]! += 2400;
            terrain[i] = TERRAIN.MOUNTAIN;
          }
        }
      }
      // Wander: now and then bend a point either way, and swell or thin.
      const turn = rng.int(6);
      if (turn === 0) dir = (dir + 7) % 8;
      else if (turn === 1) dir = (dir + 1) % 8;
      half = Math.max(1, Math.min(2, half + rng.range(-1, 1)));
      x += DIRS8[dir]![0];
      y += DIRS8[dir]![1];
      if (!inBounds(x, y, width, height)) break;
    }
  }
}

// --- lakes -------------------------------------------------------------------

/** Lakes in the low ground: each started at the lowest of a few spots tried,
 *  clear of the mountains, and grown outward lowest ground first, so it fills
 *  a hollow rather than a square. The ground under a lake is sunk, so rivers
 *  near it run into it. Returns each lake tile's lake, numbered from 1. A lake
 *  spills on to the edge of the map, or does not, decided as it is made. */
function lakes(state: State, h: Int32Array): Int16Array {
  const { width, height, rng, terrain } = state;
  const cfg = state.genesis.map;
  const lakeOf = new Int16Array(width * height);
  const clear = (x: number, y: number, r: number): boolean => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny, width, height)) continue;
        if (terrain[idx(nx, ny, width)] !== TERRAIN.PLAIN) return false;
      }
    }
    return true;
  };

  // Fewer and larger than the old blobs, so a lake is somewhere rivers go.
  const count = cfg.lakes > 0 ? Math.max(1, Math.round(cfg.lakes / 2)) : 0;
  for (let l = 1; l <= count; l++) {
    let best = -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = rng.range(2, width - 3);
      const y = rng.range(2, height - 3);
      if (!clear(x, y, 3)) continue;
      const i = idx(x, y, width);
      if (best < 0 || h[i]! < h[best]!) best = i;
    }
    const size = rng.range(cfg.blobMin * 2, cfg.blobMax * 2);
    const spills = rng.int(2) === 0;
    if (best < 0) continue;

    // Lowest ground first, but the further from the middle the higher it
    // counts, so a lake fills its hollow roundly rather than up a valley.
    const cx = xOf(best, width);
    const cy = yOf(best, width);
    const key = new Map<number, number>();
    const keyOf = (i: number) => {
      const dx = xOf(i, width) - cx;
      const dy = yOf(i, width) - cy;
      return h[i]! + 5 * (dx * dx + dy * dy);
    };
    const heap = new Heap({ at: (i) => key.get(i) ?? 0 });
    const seen = new Set<number>([best]);
    key.set(best, keyOf(best));
    heap.push(best);
    let filled = 0;
    while (filled < size && heap.size > 0) {
      const i = heap.pop();
      if (terrain[i] !== TERRAIN.PLAIN) continue;
      const x = xOf(i, width);
      const y = yOf(i, width);
      // Off the edge rows, so a lake keeps a shore all round.
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      terrain[i] = TERRAIN.LAKE;
      lakeOf[i] = spills ? l : -l;
      filled++;
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny, width, height)) continue;
        const ni = idx(nx, ny, width);
        if (seen.has(ni)) continue;
        seen.add(ni);
        key.set(ni, keyOf(ni));
        heap.push(ni);
      }
    }
  }
  for (let i = 0; i < h.length; i++) if (terrain[i] === TERRAIN.LAKE) h[i] = -1000;
  return lakeOf;
}

// --- drainage ----------------------------------------------------------------

/** Where each tile's water goes: the neighbour it drains to, or -1 where water
 *  leaves: the edge of the map, and with `toLakes` a lake. Grown inward from
 *  those, the lowest
 *  ground first, so every tile drains, hollows included, along the low ground.
 *  On the ground's own height rather than filled to a level: a filled hollow
 *  is flat, and water across flat ground runs in a ruled line. */
function drainage(state: State, h: Int32Array, toLakes: boolean): Int32Array {
  const { width, height } = state;
  const n = width * height;
  const down = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const heap = new Heap(h);
  for (let i = 0; i < n; i++) {
    const x = xOf(i, width);
    const y = yOf(i, width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || (toLakes && state.terrain[i] === TERRAIN.LAKE)) {
      seen[i] = 1;
      heap.push(i);
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    const x = xOf(i, width);
    const y = yOf(i, width);
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny, width, height)) continue;
      const ni = idx(nx, ny, width);
      if (seen[ni]) continue;
      seen[ni] = 1;
      down[ni] = i;
      heap.push(ni);
    }
  }
  return down;
}

// --- rivers ------------------------------------------------------------------

/** Rivers from the foot of the mountains, then tributaries from the hills,
 *  each walked downhill until it reaches a lake, the edge, or a river already
 *  made, which it joins. A walk through a lake that spills carries on out of
 *  the other side to the edge; one that does not ends in it. A long river has
 *  the odd bridge built over it already, so it is a long way round and not a
 *  wall. */
function rivers(state: State, h: Int32Array, down: Int32Array, spill: Int32Array, lakeOf: Int16Array): void {
  const { width, height, rng, terrain } = state;
  const cfg = state.genesis.map;
  // With the ranges, so a bigger map has more of both: two rivers rising off
  // each range and one in the hills. Nothing at all with `rivers` at 0.
  const ranges = Math.max(1, rangeCount(state));
  const main = cfg.rivers > 0 ? ranges * 2 : 0;
  const tributaries = cfg.rivers > 0 ? ranges : 0;
  const sources: number[] = [];
  const spaced = (i: number) =>
    sources.every((s) => Math.abs(xOf(s, width) - xOf(i, width)) + Math.abs(yOf(s, width) - yOf(i, width)) >= 8);

  const springs: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== TERRAIN.PLAIN) continue;
    const x = xOf(i, width);
    const y = yOf(i, width);
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(nx, ny, width, height) && terrain[idx(nx, ny, width)] === TERRAIN.MOUNTAIN) {
        springs.push(i);
        break;
      }
    }
  }

  const walk = (src: number): void => {
    const path: number[] = [];
    let i = src;
    let joined = false;
    // Once through a lake, on the way to the edge.
    let way = down;
    for (let guard = 0; guard < terrain.length && i >= 0; guard++) {
      const t = terrain[i];
      if (t === TERRAIN.RIVER) {
        joined = true;
        break;
      }
      if (t === TERRAIN.LAKE) {
        joined = true;
        if (lakeOf[i]! <= 0 || way === spill) break;
        // Through the lake and out of the far side.
        way = spill;
        while (i >= 0 && terrain[i] === TERRAIN.LAKE) i = way[i]!;
        continue;
      }
      if (t !== TERRAIN.PLAIN) break;
      path.push(i);
      i = way[i]!;
    }
    // A stub is no river: a short walk counts only if it joins something.
    if (path.length < (joined ? 3 : 6)) return;
    for (const p of path) terrain[p] = TERRAIN.RIVER;
    ford(state, path);
  };

  for (let attempt = 0; attempt < main * 20 && sources.length < main && springs.length > 0; attempt++) {
    const i = springs[rng.int(springs.length)]!;
    if (terrain[i] !== TERRAIN.PLAIN || !spaced(i)) continue;
    sources.push(i);
    walk(i);
  }

  // Tributaries rise in the high ground away from the mountains.
  let made = 0;
  for (let attempt = 0; attempt < tributaries * 30 && made < tributaries; attempt++) {
    const i = rng.int(terrain.length);
    if (terrain[i] !== TERRAIN.PLAIN || h[i]! < 800 || !spaced(i)) continue;
    sources.push(i);
    walk(i);
    made++;
  }
}

/** Bridges built into the map along a long river, one or two, at even
 *  spacing with a jitter: a crossing that costs nothing, far enough apart that
 *  a bridge of your own is still the short way over. Clear of the last few
 *  tiles before a confluence, so rivers still meet, and of the first few, so a
 *  river does not start with one. */
function ford(state: State, path: number[]): void {
  if (state.genesis.map.riverGaps <= 0 || path.length < 24) return;
  const { rng, terrain } = state;
  // One on a river of 24 tiles or more, a second from 64, and no more.
  const crossings = path.length >= 64 ? 2 : 1;
  const spacing = Math.floor(path.length / (crossings + 1));
  for (let c = 1; c <= crossings; c++) {
    const p = c * spacing + rng.range(-3, 3);
    if (p >= 4 && p < path.length - 4) terrain[path[p]!] = TERRAIN.RIVER_BRIDGED;
  }
}

// --- walls -------------------------------------------------------------------

/** Ruins: a corner, a short run, or a ring with its gates fallen in. Laid on
 *  open ground only, so a ruin never dams a river or walls up a lake. */
function ruins(state: State): void {
  const { width, height, rng, terrain } = state;
  const cfg = state.genesis.map;
  const put = (x: number, y: number) => {
    if (!inBounds(x, y, width, height)) return;
    const i = idx(x, y, width);
    if (terrain[i] === TERRAIN.PLAIN) terrain[i] = TERRAIN.WALL;
  };

  for (let w = 0; w < cfg.walls; w++) {
    const x = rng.int(width);
    const y = rng.int(height);
    const shape = rng.int(3);
    if (shape === 0) {
      // A corner: two arms from one point.
      const a = rng.range(3, 7);
      const b = rng.range(3, 7);
      const sx = rng.int(2) === 0 ? 1 : -1;
      const sy = rng.int(2) === 0 ? 1 : -1;
      for (let k = 0; k < a; k++) put(x + k * sx, y);
      for (let k = 1; k < b; k++) put(x, y + k * sy);
    } else if (shape === 1) {
      // A short run.
      const length = rng.range(4, 8);
      const across = rng.int(2) === 0;
      for (let k = 0; k < length; k++) put(across ? x + k : x, across ? y : y + k);
    } else {
      // A ring, open where its gates were.
      const w2 = rng.range(5, 9);
      const h2 = rng.range(4, 7);
      const ring: Array<[number, number]> = [];
      for (let k = 0; k < w2; k++) ring.push([x + k, y]);
      for (let k = 1; k < h2; k++) ring.push([x + w2 - 1, y + k]);
      for (let k = w2 - 2; k >= 0; k--) ring.push([x + k, y + h2 - 1]);
      for (let k = h2 - 2; k >= 1; k--) ring.push([x, y + k]);
      const gateA = rng.int(ring.length);
      const gateB = (gateA + Math.floor(ring.length / 2) + rng.range(-2, 2) + ring.length) % ring.length;
      ring.forEach(([rx, ry], k) => {
        if (k === gateA || k === (gateA + 1) % ring.length || k === gateB || k === (gateB + 1) % ring.length) return;
        put(rx, ry);
      });
    }
  }
}

// --- a heap of tiles, lowest first -------------------------------------------

/** Tiles ordered by a key, ties broken by index, so the order is the same on
 *  every peer. */
class Heap {
  private items: number[] = [];

  private readonly key: { at(i: number): number };

  constructor(key: Int32Array | { at(i: number): number }) {
    this.key = key instanceof Int32Array ? { at: (i) => key[i]! } : key;
  }

  get size(): number {
    return this.items.length;
  }

  private less(a: number, b: number): boolean {
    const ka = this.key.at(a);
    const kb = this.key.at(b);
    return ka < kb || (ka === kb && a < b);
  }

  push(i: number): void {
    const items = this.items;
    items.push(i);
    let c = items.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(items[c]!, items[p]!)) break;
      [items[c], items[p]] = [items[p]!, items[c]!];
      c = p;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < items.length && this.less(items[l]!, items[m]!)) m = l;
        if (r < items.length && this.less(items[r]!, items[m]!)) m = r;
        if (m === p) break;
        [items[m], items[p]] = [items[p]!, items[m]!];
        p = m;
      }
    }
    return top;
  }
}
