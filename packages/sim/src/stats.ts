// Stats live inside hashed state, so end-of-game figures are consensus by
// construction rather than something a client reports and a server must trust.
// Tracked per member as well as per empire, so in a shared empire you can see
// who actually landed the big cascade.

import type { Empire, Member } from "./types.js";
import { STAT } from "./constants.js";
import type { State } from "./state.js";

export function bump(
  empire: Empire,
  member: Member | null,
  slot: number,
  amount = 1,
): void {
  empire.stats[slot] = (empire.stats[slot]! + amount) >>> 0;
  if (member) member.stats[slot] = (member.stats[slot]! + amount) >>> 0;
}

export function raise(
  empire: Empire,
  member: Member | null,
  slot: number,
  value: number,
): void {
  if (value > empire.stats[slot]!) empire.stats[slot] = value >>> 0;
  if (member && value > member.stats[slot]!) member.stats[slot] = value >>> 0;
}

export interface EmpireSummary {
  id: number;
  alive: boolean;
  tilesOwned: number;
  popTotal: number;
  peakTiles: number;
  peakPop: number;
  largestCascade: { tiles: number; pop: number };
  coins: { bronze: number; silver: number; gold: number };
  diamonds: number;
  bridges: number;
  ladders: number;
  marches: number;
  /** Tiles taken by capturing a capital rather than one at a time. */
  annexed: number;
  members: Array<{
    index: number;
    kind: number;
    moves: number;
    popSpent: number;
    tilesTaken: number;
    largestCascade: { tiles: number; pop: number };
    bestSingleMove: number;
  }>;
}

/** Readable summary for the end-of-game screen and the archive peer. Derived
 *  entirely from hashed state, so any peer computes the same awards. */
export function summarise(state: State): EmpireSummary[] {
  return state.empires.map((empire) => ({
    id: empire.id,
    alive: !!empire.alive,
    tilesOwned: empire.tilesOwned,
    popTotal: empire.popTotal,
    peakTiles: empire.stats[STAT.PEAK_TILES]!,
    peakPop: empire.stats[STAT.PEAK_POP]!,
    largestCascade: {
      tiles: empire.stats[STAT.CASCADE_TILES]!,
      pop: empire.stats[STAT.CASCADE_POP]!,
    },
    coins: {
      bronze: empire.stats[STAT.COINS_BRONZE]!,
      silver: empire.stats[STAT.COINS_SILVER]!,
      gold: empire.stats[STAT.COINS_GOLD]!,
    },
    diamonds: empire.stats[STAT.DIAMONDS]!,
    bridges: empire.stats[STAT.BRIDGES]!,
    ladders: empire.stats[STAT.LADDERS]!,
    marches: empire.stats[STAT.MARCHES]!,
    annexed: empire.stats[STAT.ANNEXED]!,
    members: empire.members.map((m, i) => ({
      index: i,
      kind: m.kind,
      moves: m.stats[STAT.MOVES]!,
      popSpent: m.stats[STAT.POP_SPENT]!,
      tilesTaken: m.stats[STAT.TILES_TAKEN]!,
      largestCascade: {
        tiles: m.stats[STAT.CASCADE_TILES]!,
        pop: m.stats[STAT.CASCADE_POP]!,
      },
      bestSingleMove: m.stats[STAT.TILES_ONE_MOVE]!,
    })),
  }));
}
