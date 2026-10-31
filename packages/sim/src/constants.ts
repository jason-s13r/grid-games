// Tunables. Enums live in types.ts; this file is the balance sheet.

import { ITEM, ELIMINATION } from "./types.js";
import type { Genesis, Rules, MapConfig } from "./types.js";
import { SIM_VERSION } from "./version.js";

/** Stamped into every genesis this build composes. New games are always
 *  current: nothing anywhere downgrades this.
 *
 *  The sim's major version, so a hash-moving change and a protocol bump are the
 *  same release. See version.ts. */
export const PROTOCOL_VERSION: number = Number(SIM_VERSION.split(".")[0]);

/** Every version this build can play, verify and replay, newest first.
 *  PROTOCOL_VERSION is always its first entry — written out rather than derived,
 *  so a major release that forgets to list itself here fails a test instead of
 *  silently dropping the version before it. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [5, 4];

/** The day each superseded version stops being played, ISO. Written by hand at
 *  the bump — the release date plus the longest duration preset — and checked
 *  by a test that fails once a date has passed. Retirement is an alarm clock,
 *  not something somebody has to remember. */
export const PROTOCOL_SUNSET: Readonly<Record<number, string>> = {
  // Release day + 90. From v4 on this is arithmetic — a version's longest
  // possible game is fixed the moment it stops being current, so the date is
  // its successor's release plus MAX_DURATION plus slack, and raising the cap
  // later can never invalidate a date already published.
  //
  // v5's release (31 October 2026) plus the 31-day cap plus two weeks.
  4: "2026-12-15",
};

/** Whether this build will play a game stamped with `version`.
 *
 *  The set is a parameter with a default rather than a closed-over constant.
 *  On the day this ships the constant has one entry, and a predicate that can
 *  only be asked about that entry is a predicate no test can move. */
export function playsProtocol(
  version: number,
  supported: readonly number[] = SUPPORTED_PROTOCOLS,
): boolean {
  return supported.includes(version);
}

/** What to tell a player whose game is on a superseded version: null while the
 *  game is current, which is every game until the first bump. */
export function shelfLife(
  genesis: Genesis,
): { version: number; until: string } | null {
  const until = PROTOCOL_SUNSET[genesis.protocol];
  return until === undefined ? null : { version: genesis.protocol, until };
}

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

// Exported so a caller can say `durationRules(hours(6))` rather than doing its
// own arithmetic on STEPS_PER_SECOND. They stay here rather than moving to
// duration.ts because DEFAULT_RULES uses them three lines later, and moving
// them would put a cycle between the two files for no gain.
export const seconds = (n: number) => Math.floor(n * STEPS_PER_SECOND);
export const minutes = (n: number) => seconds(n * 60);
export const hours = (n: number) => minutes(n * 60);
export const days = (n: number) => hours(n * 24);

export const DEFAULT_RULES: Rules = {
  popMax: 999,
  popRateNum: 1,
  popRateDen: 1,
  maxMultiplier: 4,

  cascadeTileCap: 4096,
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

  // Most coins land within six steps of somebody's ground or another coin,
  // which is where cascades happen.
  coinNearBias: 85,
  coinNearRadius: 6,

  // v5. 5,000 a tile for the first three hours, 10,000 for the next three, and
  // so on to 50,000 thirty hours in.
  botTileStep: 5000,
  botTilePeriod: hours(3),
  botTileMax: 50_000,
  // One full bank: growth makes every connected tile worth one click to take,
  // which is a defence, and stops there, which keeps it from being the army.
  growthCeiling: 999,
  // A diamond every five minutes, three to a dig (a bridge's worth), and a dig
  // costs most of a full bank.
  mineDigCost: 800,
  mineYield: 3,
  mineEvery: 15,
  marchTakesCoins: true,

  noobTiles: 40,
  noobSteps: minutes(3),

  heartbeatInterval: seconds(30),
  livenessWindow: minutes(2),
  // Deliberately long: being asleep is not being defeated, and a short window
  // would reward waiting until an opponent's team is offline.
  abandonWindow: hours(3),
  elimination: ELIMINATION.CAPITAL,
  endStep: 0, // 0 = no timeout

  // The floor rather than the norm: a difficulty profile names its own tempo,
  // and this is the fastest any of them may ask to be.
  botActionInterval: seconds(2),

  // Three people rotating shifts, plus a bot to hold the seat overnight. Big
  // enough for the team game this is for, small enough that adding seats is not
  // a strategy.
  maxSeats: 4,
};

/** The rules a game with unclaimed empires needs, and **deliberately not part of
 *  `DEFAULT_RULES`.**
 *
 *  This is the whole of why vacancies need no protocol bump, and it is a
 *  narrower argument than "a vacancy is an empty members array" on its own.
 *  That array is already an error to every older build, so a record containing
 *  one is *declined* rather than desynced — but a field in `rules` is read
 *  straight past by that same build. Two of the fields below change
 *  `isProtected` for any game at all, not only one with a vacancy in it: an old
 *  peer handed a record carrying `graceCapitalPop` would ignore it, keep a
 *  capital protected that this build has stopped protecting, and disagree about
 *  a move three hours in.
 *
 *  So they travel **together with the thing an old build refuses**. A game
 *  composed with no vacancies carries none of them and its rules are
 *  byte-identical to what every build before this one composed; a game composed
 *  with vacancies carries all of them and is declined wholesale by anything that
 *  would misread them. Neither build is ever in the position of half-agreeing.
 *
 *  The numbers:
 *
 *  - `graceSteps`/`graceTiles` are the same three minutes and forty tiles under
 *    their new names, because this changes what the clock is measured *from* and
 *    not how long protection lasts.
 *  - `graceCapitalPop`/`gracePopTotal` are the bars that make "established" mean
 *    more than "owns ground" — a claimant handed a whole pocket owns forty tiles
 *    of one population each on the step they arrive, which is not an empire that
 *    can defend anything. Set so a genesis-seated empire still crosses the tile
 *    bar first, exactly as it does today; `rules.test.ts` measures that rather
 *    than assuming it.
 *  - `vacancyRadius: 6` is 85 tiles granted, a ring of 24 for an attacker to
 *    wall, and 5.5% of the default map held per vacancy. Chosen from the side of
 *    the ledger the cost falls on: the camper is hypothetical and the players
 *    staring at ground they cannot enter are not.
 *  - `vacancyGrant: 1` is one population a tile — enough to hold the pocket
 *    against a probe and not enough to walk out of it, which is what makes the
 *    grant a border rather than an army. */
export const VACANCY_RULES = {
  graceSteps: minutes(3),
  graceTiles: 40,
  graceCapitalPop: 60,
  gracePopTotal: 400,
  vacancyRadius: 6,
  vacancyGrant: 1,
} as const;

/** The most seats any rule may allow. Empire and member ids ride in single
 *  bytes of every signed move, and 32 members is already an empire nobody could
 *  coordinate — the ceiling exists so a hand-rolled genesis cannot ask for a
 *  number the wire cannot carry. */
export const SEAT_CEILING = 32;

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
