// Seeded terrain generation and capital placement.
//
// Runs once at genesis from the shared seed, so every peer generates a
// byte-identical map without anyone transmitting it.

import { TERRAIN } from "./types.js";
import { PASSABLE } from "./constants.js";
import { ORTHO, idx, xOf, yOf, inBounds, dist2 } from "./geometry.js";
import { EVENT } from "./events.js";
import type { State } from "./state.js";

export function generate(state: State): State {
  const cfg = state.genesis.map;
  state.terrain.fill(TERRAIN.PLAIN);

  for (let i = 0; i < cfg.mountains; i++) blob(state, TERRAIN.MOUNTAIN);
  for (let i = 0; i < cfg.lakes; i++) blob(state, TERRAIN.LAKE);
  for (let i = 0; i < cfg.rivers; i++) river(state);
  for (let i = 0; i < cfg.walls; i++) wall(state);

  placeCapitals(state, mainland(state));
  scheduleSpawn(state, 0);
  scheduleUpkeep(state, 0);
  return state;
}

/** Random-walk blob: O(size), never O(map). */
function blob(state: State, kind: number): void {
  const { width, height, rng, terrain } = state;
  const cfg = state.genesis.map;
  const size = rng.range(cfg.blobMin, cfg.blobMax);
  let x = rng.int(width);
  let y = rng.int(height);

  for (let i = 0; i < size; i++) {
    if (inBounds(x, y, width, height)) terrain[idx(x, y, width)] = kind;
    const [dx, dy] = ORTHO[rng.int(4)]!;
    x += dx;
    y += dy;
    if (!inBounds(x, y, width, height)) {
      x = rng.int(width);
      y = rng.int(height);
    }
  }
}

/** Runs edge to edge, then has fords punched through it.
 *
 *  An unbroken edge-to-edge river reads well on the map and plays badly: it
 *  seals each side off entirely, so an empire that spawns behind one is
 *  isolated until it can afford three diamonds, and the pressure that makes
 *  this game interesting never arrives. Fords keep the river a real obstacle —
 *  a long way around, and a chokepoint worth holding — while a bridge stays
 *  the shortcut rather than the only door. */
function river(state: State): void {
  const { width, height, rng, terrain } = state;
  const vertical = rng.int(2) === 0;
  let x = vertical ? rng.int(width) : 0;
  let y = vertical ? 0 : rng.int(height);

  const steps = vertical ? height : width;
  const path: number[] = [];

  for (let i = 0; i < steps; i++) {
    if (inBounds(x, y, width, height)) {
      const i2 = idx(x, y, width);
      if (terrain[i2] !== TERRAIN.MOUNTAIN) {
        terrain[i2] = TERRAIN.RIVER;
        path.push(i2);
      }
    }
    if (vertical) {
      y += 1;
      x = Math.max(0, Math.min(width - 1, x + rng.int(3) - 1));
    } else {
      x += 1;
      y = Math.max(0, Math.min(height - 1, y + rng.int(3) - 1));
    }
  }

  ford(state, path, vertical);
}

/** Two tiles wide, so a ford is walkable rather than a single-file gate that a
 *  neighbour plugs with one claim. Cut at even spacing with a jittered offset:
 *  spacing keeps the fords apart, jitter keeps them off a predictable line. */
function ford(state: State, path: number[], vertical: boolean): void {
  const { width, rng, terrain } = state;
  const gaps = state.genesis.map.riverGaps;
  if (gaps <= 0 || path.length === 0) return;

  const spacing = Math.floor(path.length / (gaps + 1));
  if (spacing <= 0) return;

  for (let g = 1; g <= gaps; g++) {
    const at = g * spacing + rng.range(-Math.floor(spacing / 4), Math.floor(spacing / 4));
    for (let k = 0; k < 2; k++) {
      const i = path[Math.max(0, Math.min(path.length - 1, at + k))]!;
      terrain[i] = TERRAIN.PLAIN;
      // The walk can double back on itself, so a diagonal step leaves a tile
      // beside the ford that still blocks it. Clear the sideways neighbour too.
      const nx = xOf(i, width) + (vertical ? 1 : 0);
      const ny = yOf(i, width) + (vertical ? 0 : 1);
      if (!inBounds(nx, ny, width, state.height)) continue;
      const ni = idx(nx, ny, width);
      if (terrain[ni] === TERRAIN.RIVER) terrain[ni] = TERRAIN.PLAIN;
    }
  }
}

function wall(state: State): void {
  const { width, height, rng, terrain } = state;
  const horizontal = rng.int(2) === 0;
  const length = rng.range(4, 12);
  let x = rng.int(width);
  let y = rng.int(height);

  for (let i = 0; i < length; i++) {
    if (inBounds(x, y, width, height)) {
      const i2 = idx(x, y, width);
      if (terrain[i2] === TERRAIN.PLAIN) terrain[i2] = TERRAIN.WALL;
    }
    if (horizontal) x += 1;
    else y += 1;
  }
}

/** The largest connected region of passable ground, as a mask.
 *
 *  Rivers and mountains do not only divide the map, they can pinch a corner
 *  off it — and an empire that starts inside a twenty-tile pocket has no game
 *  to play at all: nowhere to expand, no front, and nobody to fight until it
 *  can afford a bridge out. Fords answer the general case; this answers the
 *  case a ford cannot reach, by refusing to put a capital there in the first
 *  place. Every empire starts on the mainland, so every empire starts able to
 *  reach every other one.
 *
 *  Scanned in flat-index order, so the labelling is identical on every peer. */
function mainland(state: State): Uint8Array {
  const { width, height, terrain } = state;
  const region = new Int32Array(terrain.length).fill(-1);
  const sizes: number[] = [];

  for (let start = 0; start < terrain.length; start++) {
    if (region[start] >= 0 || !PASSABLE[terrain[start]!]) continue;
    const id = sizes.length;
    const queue = [start];
    region[start] = id;

    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = xOf(i, width);
      const y = yOf(i, width);
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny, width, height)) continue;
        const ni = idx(nx, ny, width);
        if (region[ni] >= 0 || !PASSABLE[terrain[ni]!]) continue;
        region[ni] = id;
        queue.push(ni);
      }
    }
    sizes.push(queue.length);
  }

  let biggest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[biggest]!) biggest = i;

  const mask = new Uint8Array(terrain.length);
  for (let i = 0; i < mask.length; i++) mask[i] = region[i] === biggest ? 1 : 0;
  return mask;
}

/** Greedy max-min separation over sampled candidates: deterministic, and keeps
 *  empires from starting on top of each other. */
function placeCapitals(state: State, mask: Uint8Array): void {
  const { width, rng } = state;
  const chosen: number[] = [];

  for (const empire of state.empires) {
    let best = -1;
    let bestScore = -1;

    for (let attempt = 0; attempt < 256; attempt++) {
      const x = rng.int(width);
      const y = rng.int(state.height);
      if (!isOpenGround(state, x, y, mask)) continue;

      let score = 1 << 30;
      for (const c of chosen) {
        score = Math.min(score, dist2(x, y, xOf(c, width), yOf(c, width)));
      }
      if (score > bestScore) {
        bestScore = score;
        best = idx(x, y, width);
      }
    }

    if (best < 0) best = firstOpen(state, mask);
    chosen.push(best);

    empire.capital = best;
    state.owner[best] = empire.id;
    state.pop[best] = 1;
    empire.tilesOwned = 1;
    empire.popTotal = 1;
  }
}

/** A capital needs room to expand, so require mostly open ground around it —
 *  and it must be on the mainland, not in a pocket the map generator pinched
 *  off behind a river. */
function isOpenGround(state: State, x: number, y: number, mask: Uint8Array): boolean {
  const { width, height, terrain } = state;
  const i = idx(x, y, width);
  if (!mask[i]) return false;
  if (state.owner[i] !== 0) return false;

  let open = 0;
  for (const [dx, dy] of ORTHO) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, width, height)) continue;
    const ni = idx(nx, ny, width);
    if (PASSABLE[terrain[ni]!] && state.owner[ni] === 0) open++;
  }
  return open >= 3;
}

function firstOpen(state: State, mask: Uint8Array): number {
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (isOpenGround(state, x, y, mask)) return idx(x, y, state.width);
    }
  }
  return 0;
}

export function scheduleSpawn(state: State, from: number): void {
  const { rules } = state.genesis;
  const delay = state.rng.range(rules.coinIntervalMin, rules.coinIntervalMax);
  state.events.push(from + delay, EVENT.SPAWN, 0);
}

/** Fixed interval, no RNG: upkeep is a metronome, and drawing for it would put
 *  a third consumer on the shared stream for no gain. */
export function scheduleUpkeep(state: State, from: number): void {
  state.events.push(from + state.genesis.rules.upkeepInterval, EVENT.UPKEEP, 0);
}
