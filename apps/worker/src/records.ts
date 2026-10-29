// What the rooms report, written to D1, and the questions asked of it.
//
// A room calls these through its hooks; the Durable Object collects the
// promises and waits for them before its handler returns. A write that fails
// is logged and dropped: a listing a little out of date is a nuisance, a game
// that stops because a database hiccupped would be a disaster.

import type { GameResult, GameSummary, PlayerRecord } from "@tessera/room";

export function writeGame(db: D1Database, game: GameSummary, now: number): Promise<unknown> {
  return db
    .prepare(
      `INSERT INTO games (id, creator, public, phase, created_at, starts_at, started_at, join_until, ends_at,
         ended_at, width, height, empires, seats_per_empire, bots, players, sim_version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT (id) DO UPDATE SET
         phase = excluded.phase, starts_at = excluded.starts_at, started_at = excluded.started_at,
         join_until = excluded.join_until, ends_at = excluded.ends_at, ended_at = excluded.ended_at,
         players = excluded.players, sim_version = excluded.sim_version, updated_at = excluded.updated_at`,
    )
    .bind(
      game.roomId,
      game.creator,
      game.public ? 1 : 0,
      game.phase,
      game.createdAt || now,
      game.startsAt ?? null,
      game.startedAt ?? null,
      game.joinUntil ?? null,
      game.endsAt ?? null,
      game.endedAt ?? null,
      game.map.width,
      game.map.height,
      game.empires,
      game.seatsPerEmpire,
      game.bots,
      game.players,
      game.simVersion ?? null,
      now,
    )
    .run();
}

export function writePlayer(db: D1Database, player: PlayerRecord): Promise<unknown> {
  const name = player.name || `player ${player.key.slice(0, 6)}`;
  return db.batch([
    db
      .prepare(
        `INSERT INTO seats (game_id, key, name, empire, bot, joined_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (game_id, key) DO UPDATE SET name = excluded.name, empire = excluded.empire, bot = excluded.bot`,
      )
      .bind(player.roomId, player.key, name, player.empire, player.bot ? 1 : 0, player.at),
    db
      .prepare(
        `INSERT INTO players (key, name, first_seen, last_seen) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      )
      .bind(player.key, name, player.at),
  ]);
}

export function writeResult(db: D1Database, result: GameResult): Promise<unknown> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE games SET winner = ?2, win_reason = ?3 WHERE id = ?1`)
      .bind(result.roomId, result.winner, result.reason),
  ];
  const placed = result.empires.length;
  for (const empire of result.empires) {
    for (const seat of empire.seats) {
      statements.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO results (game_id, key, empire, place, won, empires, tiles, peak_tiles, moves,
               tiles_taken, bot, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            result.roomId,
            seat.key,
            empire.id,
            empire.place,
            empire.id === result.winner ? 1 : 0,
            placed,
            empire.tiles,
            empire.peakTiles,
            seat.moves,
            seat.tilesTaken,
            seat.bot ? 1 : 0,
            result.endedAt,
          ),
      );
    }
  }
  return db.batch(statements);
}

// --- reading -----------------------------------------------------------------

export interface ListedGame {
  id: string;
  phase: string;
  createdAt: number;
  startsAt: number | null;
  startedAt: number | null;
  joinUntil: number | null;
  endsAt: number | null;
  endedAt: number | null;
  width: number;
  height: number;
  empires: number;
  seatsPerEmpire: number;
  bots: number;
  players: number;
  winner: number | null;
}

const GAME_COLUMNS = `g.id, g.phase, g.created_at AS createdAt, g.starts_at AS startsAt, g.started_at AS startedAt,
  g.join_until AS joinUntil, g.ends_at AS endsAt, g.ended_at AS endedAt, g.width, g.height, g.empires,
  g.seats_per_empire AS seatsPerEmpire, g.bots, g.players, g.winner`;

export type Listing = "open" | "running" | "ended";

/** Public games: open (a lobby, or running with its join window open), running,
 *  or recently ended. */
export async function listGames(db: D1Database, which: Listing, now: number): Promise<ListedGame[]> {
  const where =
    which === "open"
      ? `g.public = 1 AND (g.phase = 'lobby' OR (g.phase = 'playing' AND g.join_until > ?1))`
      : which === "running"
        ? `g.public = 1 AND g.phase = 'playing' AND (g.ends_at IS NULL OR g.ends_at > ?1)`
        : `g.public = 1 AND g.phase = 'ended' AND ?1 > 0`;
  const { results } = await db
    .prepare(`SELECT ${GAME_COLUMNS} FROM games g WHERE ${where} ORDER BY g.updated_at DESC LIMIT 50`)
    .bind(now)
    .all<ListedGame>();
  return results;
}

export interface PlayerGame extends ListedGame {
  empire: number | null;
  place: number | null;
  won: number | null;
}

export interface PlayerStats {
  key: string;
  name: string | null;
  played: number;
  won: number;
  bestPlace: number | null;
  tilesTaken: number;
  games: PlayerGame[];
}

/** One key's record, and its recent games (public or not: whoever holds the
 *  key was in them). */
export async function playerStats(db: D1Database, key: string): Promise<PlayerStats> {
  const [named, totals, games] = await db.batch([
    db.prepare(`SELECT name FROM players WHERE key = ?1`).bind(key),
    db
      .prepare(
        `SELECT COUNT(*) AS played, COALESCE(SUM(won), 0) AS won, MIN(place) AS bestPlace,
           COALESCE(SUM(tiles_taken), 0) AS tilesTaken
         FROM results WHERE key = ?1`,
      )
      .bind(key),
    db
      .prepare(
        `SELECT ${GAME_COLUMNS}, s.empire, r.place, r.won FROM seats s
           JOIN games g ON g.id = s.game_id
           LEFT JOIN results r ON r.game_id = s.game_id AND r.key = s.key
         WHERE s.key = ?1 ORDER BY g.updated_at DESC LIMIT 30`,
      )
      .bind(key),
  ]);
  const name = (named!.results[0] as { name: string } | undefined)?.name ?? null;
  const total = totals!.results[0] as { played: number; won: number; bestPlace: number | null; tilesTaken: number };
  return { key, name, ...total, games: games!.results as PlayerGame[] };
}

export interface Leader {
  key: string;
  name: string;
  played: number;
  won: number;
  /** Mean of 1 for first down to 0 for last, so a second of eight beats a
   *  second of two. */
  score: number;
}

/** People only: a bot's wins are its team's, and already counted there. */
export async function leaderboard(db: D1Database): Promise<Leader[]> {
  const { results } = await db
    .prepare(
      `SELECT r.key, p.name, COUNT(*) AS played, SUM(r.won) AS won,
         AVG(CASE WHEN r.empires > 1 THEN 1.0 * (r.empires - r.place) / (r.empires - 1) ELSE 1.0 END) AS score
       FROM results r JOIN players p ON p.key = r.key
       WHERE r.bot = 0
       GROUP BY r.key
       ORDER BY won DESC, score DESC, played DESC
       LIMIT 50`,
    )
    .all<Leader>();
  return results;
}
