// Shared types for the deterministic core.
//
// Constants are `as const` object literals rather than TS enums so the source
// stays erasable-syntax only — it runs under Node's native type stripping and
// under any bundler without a transform step.

export type EmpireId = number; // 0 = neutral, 1..N = empire
export type TileIndex = number;
export type MemberIndex = number;

export const TERRAIN = {
  PLAIN: 0,
  MOUNTAIN: 1,
  LAKE: 2,
  RIVER: 3,
  RIVER_BRIDGED: 4,
  WALL: 5,
  WALL_LADDERED: 6,
} as const;
export type Terrain = (typeof TERRAIN)[keyof typeof TERRAIN];

export const ITEM = {
  NONE: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  DIAMOND: 4,
} as const;
export type Item = (typeof ITEM)[keyof typeof ITEM];

export const MOVE = {
  PASS: 0,
  CLAIM: 1,
  BUY_BRIDGE: 2,
  BUY_LADDER: 3,
  PLACE_BRIDGE: 4,
  PLACE_LADDER: 5,
  ROSTER_AMEND: 6,
  HEARTBEAT: 7,
  /** Claim a tile two steps out, filling the tile in between from the same
   *  population spend. Available once the empire has bought the upgrade. */
  MARCH: 8,
  BUY_MARCH: 9,
  BUY_GROWTH: 10,
} as const;
export type MoveType = (typeof MOVE)[keyof typeof MOVE];

export const MEMBER = { HUMAN: 0, BOT: 1 } as const;
export type MemberKind = (typeof MEMBER)[keyof typeof MEMBER];

export const CONTROL = { HUMAN: 0, SIMBOT: 1 } as const;
export type Control = (typeof CONTROL)[keyof typeof CONTROL];

export const PHASE = { PLAYING: 0, ENDED: 1 } as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

export const ELIMINATION = { CAPITAL: 0, ANNIHILATION: 1 } as const;
export type Elimination = (typeof ELIMINATION)[keyof typeof ELIMINATION];

export const WIN = {
  NONE: 0,
  TIMEOUT: 1,
  LAST_EMPIRE: 2,
  LAST_ROSTER: 3,
} as const;
export type WinReason = (typeof WIN)[keyof typeof WIN];

export interface Rules {
  popMax: number;
  popRateNum: number;
  popRateDen: number;
  maxMultiplier: number;

  cascadeTileCap: number;
  coinIntervalMin: number;
  coinIntervalMax: number;
  coinWeights: Array<[Item, number]>;
  maxItemsOnMap: number;

  bridgeCost: number;
  ladderCost: number;
  /** One purchase, unlocked forever — a march is a change to how the empire
   *  moves, not a thing it carries. Priced accordingly. */
  marchCost: number;
  /** Also a one-off unlock. Population growth is a standing property of a
   *  connected empire, not a potion that wears off. */
  growthCost: number;
  growthAmount: number;

  /** Steps between upkeep passes: one connectivity sweep per empire that both
   *  decays what is cut off and grows what is not. */
  upkeepInterval: number;
  /** Fraction of a disconnected tile's population lost per upkeep pass. */
  decayNum: number;
  decayDen: number;
  decayMin: number;

  /** Percent chance a spawn probe hops off an owned tile rather than landing
   *  uniformly, so coins appear near the fighting. */
  coinNearBias: number;
  coinNearRadius: number;

  noobTiles: number;
  noobSteps: number;

  heartbeatInterval: number;
  livenessWindow: number;
  abandonWindow: number;
  elimination: Elimination;
  endStep: number;

  /** Default steps between a bot's claims, and the floor a headless bot is
   *  held to. A profile may ask for longer; nothing may ask for shorter, or an
   *  always-on seat would out-reflex the people it plays against. */
  botActionInterval: number;

  /** Seats one empire may ever hold, counted in the genesis record and enforced
   *  again on every ROSTER_AMEND.
   *
   *  This is the whole of team-size fairness. An empire is a set of seats
   *  sharing territory with a population timer each, so a side that can add
   *  seats freely simply out-accrues everyone else — and since a headless bot
   *  is an ordinary peer holding an ordinary seat, "add seats" costs nothing
   *  but processes. The cap is uniform across every empire in a game and it is
   *  in the genesis record, so it is agreed before anybody plays rather than
   *  argued about afterwards. */
  maxSeats: number;
}

export interface MapConfig {
  width: number;
  height: number;
  mountains: number;
  lakes: number;
  rivers: number;
  /** Passable gaps punched through each river. Without them a river seals the
   *  map and an empire is isolated until it can afford a bridge. */
  riverGaps: number;
  walls: number;
  blobMin: number;
  blobMax: number;
}

export interface MemberSpec {
  kind?: MemberKind;
  /** Public key in Phase C. The sim never inspects it; the net layer maps a
   *  verified signature to a member index before the move reaches here. */
  key?: string;
  /** How this seat plays, when a program is playing it. Absent means a person
   *  is, and the seat runs on the plain rules. */
  bot?: BotProfile;
}

/** What makes one bot easier than another.
 *
 *  A bot is not handicapped any more. It accrues at the same rate as a person,
 *  its coins chain like a person's, and everything below is a way of *playing*
 *  rather than a penalty for being a program — which is what makes difficulty a
 *  scale rather than a discount.
 *
 *  The two numeric knobs interact, and the interaction is the design. In
 *  `interval` steps a seat banks `interval` population, so a claim spends
 *  `min(interval, popMax)`: an interval longer than the cap is accrual poured
 *  away, and an interval shorter than it is a bot that never banks. So
 *
 *    - popMax >= interval  — every claim spends everything it grew. Thick tiles
 *      at a slow tempo when both are large, thin tiles at a fast one when both
 *      are small; either way the empire grows at full speed.
 *    - popMax < interval   — the seat fills up and then idles, throwing the
 *      rest away. This is the genuinely weak bot: fewer tiles per minute *and*
 *      thin ones, because it is losing growth it never spends.
 *
 *  Everything here is in the genesis record and therefore agreed before the
 *  game starts. A bot's difficulty is something every peer can check, not
 *  something the peer running it asserts. */
export interface BotProfile {
  /** Population this seat banks to, never above `rules.popMax`. The ceiling on
   *  how expensive a tile it can leave behind. */
  popMax?: number;
  /** Steps between claims. Longer is a slower, heavier player. */
  interval?: number;
  /** Relative appetite for each phase, in MODES order: expand, attack, defend,
   *  home. A bot that mostly sits at home is easy; one that mostly expands and
   *  attacks is not. Zero is allowed; all-zero falls back to even. */
  weights?: [number, number, number, number];
  /** Percent chance of taking an adjacent coin instead of following the phase.
   *  The spidering-outward appetite: coins are where the population is. */
  coins?: number;
}

export interface EmpireSpec {
  control?: Control;
  members: MemberSpec[];
}

export interface Genesis {
  /** Major of the sim that produced it. A peer refuses a mismatched major
   *  rather than desyncing silently hours later. */
  protocol: number;
  gameId?: string;
  seed: number;
  startedAt: number;
  map: MapConfig;
  rules: Rules;
  empires: EmpireSpec[];
}

export interface Move {
  step: number;
  empire: EmpireId;
  member: MemberIndex;
  seq: number;
  type: MoveType;
  x: number;
  y: number;
}

export interface Member {
  kind: MemberKind;
  /** This seat's population ceiling. `rules.popMax` for a person and for any
   *  seat that did not ask for less; lower for a bot dialled down. In state
   *  rather than read from the genesis on demand because a seat can arrive by
   *  amendment, and a snapshot has to carry what it grew. */
  popMax: number;
  popTimer: number;
  popAcc: number;
  lastBeat: number;
  joinedAt: number;
  stats: Uint32Array;
}

export interface Empire {
  id: EmpireId;
  control: Control;
  capital: TileIndex;
  bridges: number;
  ladders: number;
  /** 1 once the empire has bought the march upgrade. Permanent, and inherited
   *  by whoever takes the capital. */
  marchUnlocked: number;
  /** 1 once the empire has bought population growth. Permanent, and inherited
   *  by whoever takes the capital. */
  growthUnlocked: number;
  diamonds: number;
  tilesOwned: number;
  popTotal: number;
  alive: number;
  eliminatedAt: number;
  members: Member[];
  stats: Uint32Array;
}
