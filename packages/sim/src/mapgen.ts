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

  placeCapitals(state);
  scheduleSpawn(state, 0);
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

/** Runs edge to edge, so it genuinely divides the map and must be bridged
 *  rather than walked around. */
function river(state: State): void {
  const { width, height, rng, terrain } = state;
  const vertical = rng.int(2) === 0;
  let x = vertical ? rng.int(width) : 0;
  let y = vertical ? 0 : rng.int(height);

  const steps = vertical ? height : width;
  for (let i = 0; i < steps; i++) {
    if (inBounds(x, y, width, height)) {
      const t = terrain[idx(x, y, width)]!;
      if (t !== TERRAIN.MOUNTAIN) terrain[idx(x, y, width)] = TERRAIN.RIVER;
    }
    if (vertical) {
      y += 1;
      x = Math.max(0, Math.min(width - 1, x + rng.int(3) - 1));
    } else {
      x += 1;
      y = Math.max(0, Math.min(height - 1, y + rng.int(3) - 1));
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

/** Greedy max-min separation over sampled candidates: deterministic, and keeps
 *  empires from starting on top of each other. */
function placeCapitals(state: State): void {
  const { width, rng } = state;
  const chosen: number[] = [];

  for (const empire of state.empires) {
    let best = -1;
    let bestScore = -1;

    for (let attempt = 0; attempt < 256; attempt++) {
      const x = rng.int(width);
      const y = rng.int(state.height);
      if (!isOpenGround(state, x, y)) continue;

      let score = 1 << 30;
      for (const c of chosen) {
        score = Math.min(score, dist2(x, y, xOf(c, width), yOf(c, width)));
      }
      if (score > bestScore) {
        bestScore = score;
        best = idx(x, y, width);
      }
    }

    if (best < 0) best = firstOpen(state);
    chosen.push(best);

    empire.capital = best;
    state.owner[best] = empire.id;
    state.pop[best] = 1;
    empire.tilesOwned = 1;
    empire.popTotal = 1;
  }
}

/** A capital needs room to expand, so require mostly open ground around it. */
function isOpenGround(state: State, x: number, y: number): boolean {
  const { width, height, terrain } = state;
  const i = idx(x, y, width);
  if (!PASSABLE[terrain[i]!]) return false;
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

function firstOpen(state: State): number {
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (isOpenGround(state, x, y)) return idx(x, y, state.width);
    }
  }
  return 0;
}

export function scheduleSpawn(state: State, from: number): void {
  const { rules } = state.genesis;
  const delay = state.rng.range(rules.coinIntervalMin, rules.coinIntervalMax);
  state.events.push(from + delay, EVENT.SPAWN, 0);
}
