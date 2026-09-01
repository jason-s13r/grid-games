// Tunables. Enums live in types.ts; this file is the balance sheet.

import { ITEM, ELIMINATION } from "./types.js";
import type { Rules, MapConfig } from "./types.js";

/** Bumped whenever a change moves the state hash. Genesis records it, and a
 *  peer refuses to join a game whose major differs. */
export const PROTOCOL_VERSION = 2;

/** Indexed by Terrain. Mountains and lakes are permanent; rivers and walls
 *  open once bridged or laddered. */
export const PASSABLE: readonly boolean[] = [
  true, false, false, false, true, false, true,
];

/** Claim radius per Item, as a von Neumann ball: 5, 13 and 25 tiles. */
export const COIN_RADIUS: readonly number[] = [0, 1, 2, 3, 0];

export const STAT = {
  PEAK_POP: 0,
  PEAK_TILES: 1,
  CASCADE_TILES: 2,
  CASCADE_POP: 3,
  COINS_BRONZE: 4,
  COINS_SILVER: 5,
  COINS_GOLD: 6,
  DIAMONDS: 7,
  TILES_ONE_MOVE: 8,
  BRIDGES: 9,
  LADDERS: 10,
  MOVES: 11,
  POP_SPENT: 12,
  TILES_TAKEN: 13,
  MARCHES: 14,
  ANNEXED: 15,
} as const;
export const STAT_SLOTS = 16;

export const STEPS_PER_SECOND = 12;

const seconds = (n: number) => Math.floor(n * STEPS_PER_SECOND);
const minutes = (n: number) => seconds(n * 60);
const hours = (n: number) => minutes(n * 60);

export const DEFAULT_RULES: Rules = {
  popMax: 999,
  popRateNum: 1,
  popRateDen: 1,
  // A PeerBot holds the line but cannot match a human, or night cover would be
  // strictly free and therefore overpowered.
  botPopMax: 499,
  botPopRateNum: 1,
  botPopRateDen: 2,
  maxMultiplier: 4,

  cascadeTileCap: 4096,
  // 0 = a bot's coin claim fires but triggered coins never re-trigger, so
  // cascade mastery stays the human skill expression.
  botCascadeDepth: 0,
  coinIntervalMin: seconds(1.5),
  coinIntervalMax: seconds(4),
  // Diamonds buy every item in the shop at three apiece, so the replacement
  // rate has to keep up with spending or the shop is decoration.
  coinWeights: [
    [ITEM.BRONZE, 52],
    [ITEM.SILVER, 24],
    [ITEM.GOLD, 9],
    [ITEM.DIAMOND, 15],
  ],
  maxItemsOnMap: 360,

  bridgeCost: 3,
  ladderCost: 3,
  marchCost: 6,
  growthCost: 6,
  growthAmount: 1,

  upkeepInterval: seconds(20),
  // An eighth per pass: a pocket cut off behind enemy lines withers over a
  // couple of minutes rather than vanishing, so it can still be relieved.
  decayNum: 1,
  decayDen: 8,
  decayMin: 1,

  coinNearBias: 72,
  coinNearRadius: 4,

  noobTiles: 40,
  noobSteps: minutes(3),

  heartbeatInterval: seconds(30),
  livenessWindow: minutes(2),
  // Deliberately long: being asleep is not being defeated, and a short window
  // would reward waiting until an opponent's team is offline.
  abandonWindow: hours(3),
  elimination: ELIMINATION.CAPITAL,
  endStep: 0, // 0 = no timeout

  botActionInterval: seconds(2),
};

export const DEFAULT_MAP: MapConfig = {
  width: 96,
  height: 64,
  mountains: 14,
  lakes: 8,
  rivers: 2,
  riverGaps: 3,
  walls: 6,
  blobMin: 6,
  blobMax: 40,
};
