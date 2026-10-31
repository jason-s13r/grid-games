// What a room tells the world outside the game: a row for a listing, who is
// playing, and how it ended.
//
// The room stays a room. It knows nothing about databases; it reports these
// through hooks, and whoever hosts it (a Durable Object writing to D1, a test)
// decides where they go. Each is small and rare: a listing row changes when
// somebody joins, picks, or the phase moves, never per move.

import { STEPS_PER_SECOND, summarise } from "@tessera/sim";
import type { Genesis, Sim, State } from "@tessera/sim";
import type { Stamped } from "./messages.js";

export type GamePhase = "lobby" | "playing" | "ended";

/** One game, as a listing shows it. Times are ms since the epoch. */
export interface GameSummary {
  roomId: string;
  creator: string;
  public: boolean;
  phase: GamePhase;
  createdAt: number;
  map: { width: number; height: number };
  empires: number;
  seatsPerEmpire: number;
  bots: number;
  /** People in the game: in the lobby, or holding a seat once it runs. */
  players: number;
  startsAt?: number;
  startedAt?: number;
  /** Until when a newcomer may still take or ask for a seat. */
  joinUntil?: number;
  endsAt?: number;
  endedAt?: number;
  /** The sim release the game was sealed with. */
  simVersion?: string;
}

/** Somebody arrived, picked, or was seated. `empire` is null while undecided
 *  in a lobby, and for a spectator. */
export interface PlayerRecord {
  roomId: string;
  key: string;
  name: string;
  empire: number | null;
  bot: boolean;
  at: number;
}

export interface SeatResult {
  key: string;
  /** In the earliest archives only. Names live in the records, by key. */
  name?: string;
  bot: boolean;
  member: number;
  moves: number;
  tilesTaken: number;
  /** This seat's largest coin cascade, in tiles. */
  cascadeTiles: number;
}

export interface EmpireResult {
  id: number;
  /** 1 for the winner, then by survival, tiles and population. */
  place: number;
  alive: boolean;
  tiles: number;
  peakTiles: number;
  peakPop: number;
  seats: SeatResult[];
}

export interface GameResult {
  roomId: string;
  gameId: string;
  endedAt: number;
  step: number;
  /** Empire id, or 0 when nobody won. */
  winner: number;
  reason: number;
  empires: EmpireResult[];
}

export interface RoomEvents {
  game?(summary: GameSummary): void;
  player?(record: PlayerRecord): void;
  ended?(result: GameResult): void;
}

/** Wall time of a step. */
export function timeOf(startedAt: number, step: number): number {
  return startedAt + Math.round((step * 1000) / STEPS_PER_SECOND);
}

/** Places by the sim's own measures: the winner, then whoever survived, then
 *  tiles, population, and how late an empire fell. */
export function places(sim: Sim): Map<number, number> {
  return placesOf(sim.state);
}

/** `places`, from a state alone: what a client showing the result reads, so
 *  the end of a game and the start page's "you came 4th" agree. */
export function placesOf(state: State): Map<number, number> {
  const order = state.empires
    .filter((e) => e.members.length > 0)
    .slice()
    .sort(
      (a, b) =>
        Number(b.id === state.winner) - Number(a.id === state.winner) ||
        Number(!!b.alive) - Number(!!a.alive) ||
        b.tilesOwned - a.tilesOwned ||
        b.popTotal - a.popTotal ||
        (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0) ||
        a.id - b.id,
    );
  return new Map(order.map((e, i) => [e.id, i + 1]));
}

export function resultOf(
  sim: Sim,
  roomId: string,
  seatOf: (empire: number, member: number) => { key: string; bot: boolean } | undefined,
): GameResult {
  const state = sim.state;
  const placed = places(sim);
  const empires: EmpireResult[] = [];
  for (const summary of summarise(state)) {
    const place = placed.get(summary.id);
    if (place === undefined) continue;
    const seats: SeatResult[] = [];
    for (const member of summary.members) {
      const who = seatOf(summary.id, member.index);
      if (!who) continue;
      seats.push({
        ...who,
        member: member.index,
        moves: member.moves,
        tilesTaken: member.tilesTaken,
        cascadeTiles: member.largestCascade.tiles,
      });
    }
    empires.push({
      id: summary.id,
      place,
      alive: summary.alive,
      tiles: summary.tilesOwned,
      peakTiles: summary.peakTiles,
      peakPop: summary.peakPop,
      seats,
    });
  }
  empires.sort((a, b) => a.place - b.place);
  return {
    roomId,
    gameId: state.genesis.gameId ?? "",
    endedAt: timeOf(state.genesis.startedAt, state.step),
    step: state.step,
    winner: state.winner,
    reason: state.winReason,
    empires,
  };
}

/** A finished game, whole: what a replay needs, in the shape the sim's own
 *  `replay --log` reads, so an archive can be checked from the command line.
 *  The moves keep their signatures, so it can be re-verified as well as
 *  replayed. */
export interface GameArchive {
  format: "tessera/archive/1";
  roomId: string;
  genesis: Genesis;
  /** Who held which seat, by key. Names are looked up in the records when the
   *  game is watched back; the earliest archives carried them here too. */
  players: Array<{ key: string; name?: string; empire: number; member: number; bot: boolean }>;
  moveLog: Stamped[];
  /** The step it ended at, and the state hash there. */
  steps: number;
  hash: string;
  result: GameResult;
}
