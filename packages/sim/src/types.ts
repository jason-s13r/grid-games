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
  botPopMax: number;
  botPopRateNum: number;
  botPopRateDen: number;
  maxMultiplier: number;

  cascadeTileCap: number;
  botCascadeDepth: number;
  coinIntervalMin: number;
  coinIntervalMax: number;
  coinWeights: Array<[Item, number]>;
  maxItemsOnMap: number;

  bridgeCost: number;
  ladderCost: number;

  /** Steps between upkeep passes: one connectivity sweep per empire. */
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

  botActionInterval: number;
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
  diamonds: number;
  tilesOwned: number;
  popTotal: number;
  alive: number;
  eliminatedAt: number;
  members: Member[];
  stats: Uint32Array;
}
