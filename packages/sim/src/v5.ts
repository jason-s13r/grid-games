// What protocol 5 adds: diamond mines, a ceiling on how strong a simulation
// bot's tiles may be, and limits on growth. Each piece reads
// `state.genesis.protocol`, never PROTOCOL_VERSION, so a v4 game in progress
// keeps the rules it started with.
//
// MINES. Diamonds stop lying about the map as coins. Instead a few tiles
// beside mountains are mines, placed with the map. A mine is dug by claiming it
// with a large enough bank (`mineDigCost`), and then gives its owner a diamond
// every few upkeep passes while the capital still reaches it, until it is
// worked out and has to be dug again. That makes diamonds something to hold
// and to fight over, rather than something found.
//
// The item layer carries a mine in the byte it already has for each tile:
// `ITEM.MINE` is a mine with nothing left, `ITEM.MINE + n` one with n diamonds
// to come. So the snapshot layout, and with it the hash of every v4 game, is
// untouched.

import { ITEM, CONTROL, TERRAIN } from "./types.js";
import type { Empire, EmpireId, Item } from "./types.js";
import { DEFAULT_RULES, hours } from "./constants.js";
import { ORTHO, idx, inBounds, xOf, yOf } from "./geometry.js";
import type { State } from "./state.js";

export const isV5 = (state: State): boolean => state.genesis.protocol >= 5;

/** A coin: something a claim sets off. Not a diamond, not a mine. */
export const isCoin = (item: number): boolean =>
  item === ITEM.BRONZE || item === ITEM.SILVER || item === ITEM.GOLD;

// --- mines -------------------------------------------------------------------

export const isMine = (item: number): boolean => item >= ITEM.MINE;

/** Diamonds a mine has left to give; 0 for a mine to dig, or no mine. */
export const mineLeft = (item: number): number => (item > ITEM.MINE ? item - ITEM.MINE : 0);

export const mineDigCost = (state: State): number =>
  state.genesis.rules.mineDigCost ?? DEFAULT_RULES.mineDigCost!;

/** Dig a worked-out mine, if `spent` (the bank behind the claim) is enough and
 *  the claimer holds the tile now. True if it did. */
export function digMine(state: State, i: number, empire: Empire, spent: number): boolean {
  if (state.item[i] !== ITEM.MINE) return false;
  if (state.owner[i] !== empire.id) return false;
  if (spent < mineDigCost(state)) return false;
  const yieldOf = Math.min(250, Math.max(1, state.genesis.rules.mineYield ?? DEFAULT_RULES.mineYield!));
  state.item[i] = (ITEM.MINE + yieldOf) as Item;
  return true;
}

/** Whether this upkeep pass is one on which mines give. Upkeep runs every
 *  `upkeepInterval` steps from step 0, so the pass number is a division. */
export function minesGiveNow(state: State): boolean {
  const rules = state.genesis.rules;
  const every = Math.max(1, rules.mineEvery ?? DEFAULT_RULES.mineEvery!);
  const pass = Math.floor(state.step / rules.upkeepInterval);
  return pass % every === 0;
}

/** Place the map's mines: plain tiles beside a mountain, away from capitals and
 *  from one another. Runs after everything else the map generator draws, so a
 *  v4 map, which never gets here, is the same map it always was. */
export function placeMines(state: State): void {
  const { width, height, terrain, item, rng } = state;
  const cfg = state.genesis.map;
  const want = Math.max(0, cfg.mines ?? Math.round((width * height) / 1024));
  const placed: number[] = [];
  const capitals = state.empires.map((e) => e.capital);
  const far = (i: number, others: number[], d: number): boolean =>
    others.every((o) => Math.abs(xOf(o, width) - xOf(i, width)) + Math.abs(yOf(o, width) - yOf(i, width)) >= d);

  const fits = (i: number): boolean => {
    if (terrain[i] !== TERRAIN.PLAIN || item[i] !== ITEM.NONE) return false;
    const x = xOf(i, width);
    const y = yOf(i, width);
    let mountain = false;
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(nx, ny, width, height) && terrain[idx(nx, ny, width)] === TERRAIN.MOUNTAIN) mountain = true;
    }
    return mountain && far(i, capitals, 6) && far(i, placed, 6);
  };
  const put = (i: number) => {
    item[i] = ITEM.MINE;
    placed.push(i);
  };

  // First one within reach of each capital: a short game is over before an
  // empire grows to a mine on the far side of the map, and without a mine there
  // are no diamonds and no shop. Capitals are placed on open ground, so often
  // there is no mountain in reach; then the mine gets an outcrop of its own,
  // one mountain tile beside it.
  const near = (cx: number, cy: number, x: number, y: number): boolean => {
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    return d >= 6 && d <= REACH && inBounds(x, y, width, height);
  };
  for (const capital of capitals) {
    const cx = xOf(capital, width);
    const cy = yOf(capital, width);
    let found = false;
    for (let attempt = 0; attempt < 200 && !found; attempt++) {
      const x = cx + rng.range(-REACH, REACH);
      const y = cy + rng.range(-REACH, REACH);
      if (!near(cx, cy, x, y) || !fits(idx(x, y, width))) continue;
      put(idx(x, y, width));
      found = true;
    }
    for (let attempt = 0; attempt < 200 && !found; attempt++) {
      const x = cx + rng.range(-REACH, REACH);
      const y = cy + rng.range(-REACH, REACH);
      const [dx, dy] = ORTHO[rng.int(4)]!;
      if (!near(cx, cy, x, y) || !inBounds(x + dx, y + dy, width, height)) continue;
      const i = idx(x, y, width);
      const rock = idx(x + dx, y + dy, width);
      if (terrain[i] !== TERRAIN.PLAIN || item[i] !== ITEM.NONE || !far(i, placed, 6)) continue;
      if (terrain[rock] !== TERRAIN.PLAIN || !far(rock, capitals, 2)) continue;
      terrain[rock] = TERRAIN.MOUNTAIN;
      put(i);
      found = true;
    }
  }

  // Then the rest anywhere.
  for (let attempt = 0; attempt < want * 60 && placed.length < want; attempt++) {
    const i = rng.int(width * height);
    if (fits(i)) put(i);
  }
}

/** How far, in steps, the mine near a capital may be from it. */
const REACH = 12;

// --- how strong a bot's tile may be ------------------------------------------

/** The most population a tile of `empireId` may hold, or Infinity. A ceiling
 *  for empires the simulation plays, from v5; nobody else has one. */
export function tileCeiling(state: State, empireId: EmpireId): number {
  if (!isV5(state) || empireId <= 0) return Infinity;
  const empire = state.empires[empireId - 1];
  if (!empire || empire.control !== CONTROL.SIMBOT) return Infinity;
  const rules = state.genesis.rules;
  const step = rules.botTileStep ?? DEFAULT_RULES.botTileStep!;
  const period = Math.max(1, rules.botTilePeriod ?? DEFAULT_RULES.botTilePeriod ?? hours(3));
  const max = rules.botTileMax ?? DEFAULT_RULES.botTileMax!;
  return Math.min(max, step * (1 + Math.floor(state.step / period)));
}

// --- growth ------------------------------------------------------------------

export const growthCeiling = (state: State): number =>
  state.genesis.rules.growthCeiling ?? DEFAULT_RULES.growthCeiling!;

/** Somebody is minding the empire: the simulation plays it, or a seat has
 *  moved or sent a heartbeat within the liveness window. */
export function isAttended(state: State, empire: Empire): boolean {
  if (empire.control === CONTROL.SIMBOT) return true;
  const window = state.genesis.rules.livenessWindow;
  return empire.members.some((m) => state.step - m.lastBeat <= window);
}
