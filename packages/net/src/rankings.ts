// The table, and what makes it worth reading.
//
// A leaderboard is normally the least trustworthy thing a game has: a number a
// client reported, kept by a server nobody can audit, and true only if both
// behaved. Here it is neither reported nor kept. Every figure below is read out
// of hashed state after replaying a signed log — so the table is not a record
// of what happened, it is a *derivation* of it, and anyone holding the same
// files derives the same one.
//
// Which means the interesting work is refusal rather than arithmetic. A game
// only counts once it has survived `verifyArchive`: genesis re-hashed, roster
// rebuilt from it, every signature checked against that roster, and the whole
// log replayed to the hash it claims. A fragment does not count, because the
// stats depend on the part that is missing. A game with an unsigned move does
// not count. And a game counts *once* however many observers archived it,
// which is not a corner case at all — two observers on one game is the normal
// way to keep an archive safe.

import { MEMBER } from "@tessera/sim";
import type { MemberKind } from "@tessera/sim";
import { Roster } from "@tessera/protocol";
import type { MemberKey, Seat } from "@tessera/protocol";
import { verifyArchive } from "./archive.js";
import type { ArchivedGame } from "./archive.js";

/** One key's record across every game counted.
 *
 *  Keyed by the member key rather than by a name, because a key is the only
 *  identity this game has: seat numbers are per game and there are no accounts.
 *  Whoever is showing the table can put a face to it; nothing here can. */
export interface Standing {
  key: MemberKey;
  /** BOT only if every seat this key ever held was a bot seat. A key that has
   *  played as both is a person who also ran night cover, and the games it
   *  played itself are not a bot's. */
  kind: MemberKind;
  games: number;
  wins: number;
  moves: number;
  popSpent: number;
  tilesTaken: number;
  /** Most tiles taken by a single claim. The one number in the table that is
   *  about a moment rather than an accumulation. */
  bestMove: number;
  /** Largest cascade, in tiles. */
  bestCascade: number;
  /** The largest this key's empire ever grew, in any counted game. An empire
   *  figure rather than a personal one, and shared with its teammates. */
  peakTiles: number;
}

export interface Leaderboard {
  /** Ranked. See `rankArchives` for the ordering, which is deliberately plain
   *  arithmetic rather than a rating: a table nobody can explain is a table
   *  nobody can check, which would give back exactly what the signatures were
   *  for. */
  standings: Standing[];
  /** Game ids counted, in the order they were counted. */
  counted: string[];
  /** Counted games that have not ended. They contribute stats and no wins,
   *  which is worth saying out loud: a table of zeroes is otherwise indistinct
   *  from a table of losses. */
  unfinished: number;
  /** Everything not counted, and why. `index` is its position in the archives
   *  handed in, which is how a caller names the *file* rather than the game: two
   *  archives of one game share a game id, and telling somebody which of them
   *  was the duplicate is the entire point of saying so. */
  refused: Array<{ index: number; game: string; problems: string[] }>;
}

/** Seats by "empire:member", amendments included.
 *
 *  Amendments are applied without re-checking their quorum because verification
 *  has already refused any game whose amendments lacked one — this only ever
 *  runs over archives that passed. */
function seatsByIndex(game: ArchivedGame): Map<string, Seat> {
  const roster = Roster.fromGenesis(game.genesis);
  for (const signed of game.amendments ?? []) {
    const { empire, key, kind, step } = signed.amendment;
    roster.amend(empire, key, kind, step);
  }
  const byIndex = new Map<string, Seat>();
  for (const seat of roster.all()) byIndex.set(`${seat.empire}:${seat.member}`, seat);
  return byIndex;
}

function blank(key: MemberKey, kind: MemberKind): Standing {
  return {
    key,
    kind,
    games: 0,
    wins: 0,
    moves: 0,
    popSpent: 0,
    tilesTaken: 0,
    bestMove: 0,
    bestCascade: 0,
    peakTiles: 0,
  };
}

/** Rank a pile of archives.
 *
 *  Ordering is wins, then tiles taken, then the best single move, then the key
 *  itself so that two identical records still come out in the same order on
 *  every machine that computes the table. Nothing here is weighted or tuned:
 *  every column is a count taken from hashed state, and the sort is the only
 *  opinion in the file.
 *
 *  Give it every archive you have, including several of the same game. It
 *  verifies each and counts each game once. */
export async function rankArchives(games: Iterable<ArchivedGame>): Promise<Leaderboard> {
  const rows = new Map<MemberKey, Standing>();
  const counted: string[] = [];
  const refused: Leaderboard["refused"] = [];
  const seen = new Set<string>();
  let unfinished = 0;

  let index = -1;
  for (const game of games) {
    index++;
    const id = game?.genesis?.gameId ?? "unknown";
    const verdict = await verifyArchive(game);
    if (!verdict.ok) {
      refused.push({ index, game: id, problems: verdict.problems });
      continue;
    }
    if (seen.has(id)) {
      refused.push({ index, game: id, problems: ["already counted from another archive"] });
      continue;
    }
    seen.add(id);
    counted.push(id);
    if (!verdict.winner) unfinished++;

    const seats = seatsByIndex(game);
    for (const empire of verdict.summary) {
      for (const member of empire.members) {
        const seat = seats.get(`${empire.id}:${member.index}`);
        // A SimBot holds no key, so there is nobody to credit. That is the
        // whole reason a seat's key is what the table is built on: the players
        // are exactly the seats somebody signs for.
        if (!seat) continue;

        let row = rows.get(seat.key);
        if (!row) rows.set(seat.key, (row = blank(seat.key, seat.kind)));
        if (seat.kind !== MEMBER.BOT) row.kind = seat.kind;

        row.games++;
        if (verdict.winner === empire.id) row.wins++;
        row.moves += member.moves;
        row.popSpent += member.popSpent;
        row.tilesTaken += member.tilesTaken;
        row.bestMove = Math.max(row.bestMove, member.bestSingleMove);
        row.bestCascade = Math.max(row.bestCascade, member.largestCascade.tiles);
        row.peakTiles = Math.max(row.peakTiles, empire.peakTiles);
      }
    }
  }

  const standings = [...rows.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      b.tilesTaken - a.tilesTaken ||
      b.bestMove - a.bestMove ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  return { standings, counted, unfinished, refused };
}
