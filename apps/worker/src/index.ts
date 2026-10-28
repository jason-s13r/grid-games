// The Worker at tessera.qot.nz.
//
//   POST /api/games        create a game, returns { id }
//   GET  /api/games/:id    whether a game exists, and its phase
//   GET  /game/:id/ws      the game's WebSocket, handed to its Durable Object
//   everything else        the web client, from static assets
//
// The Worker holds nothing. Each game is one GameRoom Durable Object, addressed
// by its room id.

import { configFrom, newRoomId } from "./create.js";
import type { Env } from "./env.js";

export { GameRoom } from "./game-room.js";

const ROOM_ID = "([A-Za-z0-9_-]{1,64})";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/games") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return createGame(request, env);
    }

    const info = path.match(new RegExp(`^/api/games/${ROOM_ID}$`));
    if (info) {
      const result = await room(env, info[1]!).info();
      return result ? json(result) : json({ error: "no such game" }, 404);
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
  const defaultDays = Number(env.DEFAULT_DURATION_DAYS) || 10;

  // A collision is astronomically unlikely, and init refuses one anyway.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newRoomId();
    const config = configFrom(body, id, defaultDays, Date.now());
    if (typeof config === "string") return json({ error: config }, 400);
    if (await room(env, id).init(config)) return json({ id }, 201);
  }
  return json({ error: "could not allocate a room" }, 503);
}

function room(env: Env, id: string) {
  return env.GAMES.get(env.GAMES.idFromName(id));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
