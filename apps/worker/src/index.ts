// The Worker at tessera.qot.nz.
//
//   POST /api/games            create a game, returns { id }
//   GET  /api/games?list=open  public games: open (default), running, ended
//   GET  /api/games/:id        whether a game exists, and its phase
//   GET  /api/games/:id/archive  a finished game, whole, for a replay
//   GET  /api/players/:key     one player's record and recent games
//   GET  /api/leaderboard?scope=total|game  the top ten for each stat: games
//                              won, area, population, coin cascade
//   GET  /api/config           settings the page needs: the default length
//                              and the tip link
//   GET  /game/:id/ws      the game's WebSocket, handed to its Durable Object
//   everything else        the web client, from static assets
//
// The Worker holds nothing. Each game is one GameRoom Durable Object, addressed
// by its room id; listings and results are in D1, written by the rooms.

import { configFrom, newRoomId } from "./create.js";
import type { Env } from "./env.js";
import { LEADER_STATS, leaderboard, listGames, playerStats } from "./records.js";
import type { LeaderScope, Listing } from "./records.js";
import { hasArchive, serveArchive } from "./archive.js";

export { GameRoom } from "./game-room.js";

const ROOM_ID = "([A-Za-z0-9_-]{1,64})";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/games") {
      if (request.method === "POST") return createGame(request, env);
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const which = url.searchParams.get("list") ?? "open";
      if (which !== "open" && which !== "running" && which !== "ended") {
        return json({ error: "list is open, running or ended" }, 400);
      }
      if (!env.DB) return json({ games: [] }, 200, 15);
      return json({ games: await listGames(env.DB, which as Listing, Date.now()) }, 200, 15);
    }

    const player = path.match(/^\/api\/players\/([A-Za-z0-9_-]{16,128})$/);
    if (player) {
      if (!env.DB) return json({ error: "no records here" }, 404);
      return json(await playerStats(env.DB, player[1]!), 200, 15);
    }

    if (path === "/api/config") {
      return json({ defaultMinutes: defaultMinutes(env), tipUrl: tipUrl(env) }, 200, 60);
    }

    if (path === "/api/leaderboard") {
      // Every list at once: the start page shows them side by side.
      const scope: LeaderScope = url.searchParams.get("scope") === "game" ? "game" : "total";
      if (!env.DB) return json({ scope, lists: {} }, 200, 60);
      const db = env.DB;
      const lists = Object.fromEntries(
        await Promise.all(LEADER_STATS.map(async (stat) => [stat, await leaderboard(db, stat, scope)] as const)),
      );
      return json({ scope, lists }, 200, 60);
    }

    const info = path.match(new RegExp(`^/api/games/${ROOM_ID}$`));
    if (info) {
      const result = await room(env, info[1]!).info();
      if (result) return json(result);
      // A finished game whose room has gone: its archive is all there is.
      if (env.ARCHIVE && (await hasArchive(env.ARCHIVE, info[1]!))) {
        return json({ roomId: info[1], phase: "ended", ended: true, archived: true });
      }
      return json({ error: "no such game" }, 404);
    }

    const archive = path.match(new RegExp(`^/api/games/${ROOM_ID}/archive$`));
    if (archive) {
      const served = env.ARCHIVE ? await serveArchive(env.ARCHIVE, archive[1]!, request, ctx) : null;
      return served ?? json({ error: "no archive for that game" }, 404);
    }

    const socket = path.match(new RegExp(`^/game/${ROOM_ID}/ws$`));
    if (socket) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "expected a WebSocket" }, 426);
      }
      return room(env, socket[1]!).fetch(request);
    }

    if (path.startsWith("/api/") || path.startsWith("/game/")) {
      return json({ error: "not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function createGame(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  const defaultHours = defaultMinutes(env) / 60;

  // A collision is astronomically unlikely, and init refuses one anyway.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newRoomId();
    const config = configFrom(body, id, defaultHours, Date.now());
    if (typeof config === "string") return json({ error: config }, 400);
    if (await room(env, id).init(config)) return json({ id }, 201);
  }
  return json({ error: "could not allocate a room" }, 503);
}

/** Where "Support the game" goes: TIP_URL from the dashboard, the maker's
 *  Ko-fi page when unset, or nowhere when it is "off". */
function tipUrl(env: Env): string {
  const set = (env.TIP_URL ?? "").trim();
  if (set === "off") return "";
  return /^https:\/\//.test(set) ? set : "https://ko-fi.com/jason_s13r";
}

/** The game length a form offers first: the dashboard's, or 15 minutes. */
function defaultMinutes(env: Env): number {
  const minutes = Number(env.DEFAULT_DURATION_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
}

function room(env: Env, id: string) {
  return env.GAMES.get(env.GAMES.idFromName(id));
}

/** `maxAge` lets a browser reuse a listing for a few seconds rather than ask
 *  D1 again on every render. */
function json(value: unknown, status = 200, maxAge = 0): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (maxAge) headers["cache-control"] = `public, max-age=${maxAge}`;
  return new Response(JSON.stringify(value), { status, headers });
}
