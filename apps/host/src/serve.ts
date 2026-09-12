// The relay, and the three things a stranger may read.
//
// One port carries both: `ws` does the upgrade and hands each connection to the
// room bus, and plain HTTP answers the reads. The bus is closed to rooms this
// process is not a peer in, because a bus that creates any room asked for is an
// open relay for other people's traffic — a different product from a host peer
// serving the game it is in — and "no game is running here" is the answer a
// joiner actually wants rather than an empty room they sit in forever.
//
// Everything served is public and self-verifying: a resume point is checked
// against its witnesses, an archive is replayed. Nothing accepts a write. That is
// worth enumerating rather than implying, because this is the first component in
// Tessera with a URL, and the first thing anyone will want to add to it is an
// endpoint that accepts something.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { RoomBus, isRoomName } from "@tessera/net";
import type { BusSocket } from "@tessera/net";

export interface Room {
  /** The archive directory, which is where `/resume` and `/archive` are read
   *  from. Named by the game id, as the observer names its own. */
  dir(): string | undefined;
  /** For `GET /room/:code`. */
  status(): { gameId: string; step: number; peers: number; ended: boolean };
}

export interface ServeOptions {
  bus: RoomBus;
  bind: string;
  port: number;
  /** The rooms this process is a peer in. A `:code` is looked up here and never
   *  joined to a path: the alternative is a directory traversal in the one
   *  component of this system that takes a string from a stranger. */
  rooms: Map<string, Room>;
  /** Read the resume point and the archive off disk. Injected so the HTTP layer
   *  has no opinion about the file format. */
  read: {
    resume(dir: string): Promise<unknown | null>;
    archive(dir: string): Promise<unknown | null>;
  };
  say: (line: string) => void;
}

/** Cached because a multi-day log is megabytes of JSON parsing per request, and
 *  a poller should cost nothing. The tag is the archive's own head figures, so a
 *  fetch that matches gets a 304 and never touches the disk. */
interface Cached {
  tag: string;
  body: string;
}

export function serve(options: ServeOptions): Server {
  const archives = new Map<string, Cached>();

  const server = createServer((request, response) => {
    void answer(request, response).catch(() => end(response, 500, { error: "server" }));
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (ws) => attach(ws));
  });

  /** One connection, handed to the bus and nothing else. The bus never learns
   *  what is under a `BusSocket`, which is what keeps it the same object the
   *  tests drive. */
  const attach = (ws: WebSocket): void => {
    const far: BusSocket = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: () => ws.close(),
    };
    ws.on("message", (data) => options.bus.deliver(far, String(data)));
    ws.on("close", () => options.bus.gone(far));
    // A socket-level error is always followed by a close, so one report is
    // enough and the close is where the bookkeeping happens.
    ws.on("error", () => {});
  };

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Nothing here accepts a write, so there is nothing for a cross-origin one
    // to reach — and 0008's client fetches these from a page served elsewhere
    // entirely.
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      return end(response, 204, null);
    }
    if (request.method !== "GET") return end(response, 405, { error: "read only" });

    const path = (request.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
    if (path[0] !== "room" || !path[1]) return end(response, 404, { error: "not found" });

    const code = decodeURIComponent(path[1]);
    // Checked before the lookup as well as by it: one of these is a whitelist and
    // the other is a map, and both refusing a `../` is worth the duplication.
    if (!isRoomName(code)) return end(response, 404, { error: "not a room" });
    const room = options.rooms.get(code);
    if (!room) return end(response, 404, { error: "no game is running here" });

    const what = path[2] ?? "";
    if (what === "") return end(response, 200, room.status());

    const dir = room.dir();
    if (!dir) return end(response, 404, { error: "nothing written yet" });

    if (what === "resume") {
      const point = await options.read.resume(dir);
      if (!point) return end(response, 404, { error: "no resume point yet" });
      return end(response, 200, point);
    }

    if (what === "archive") {
      const status = room.status();
      const tag = `"${status.step}"`;
      if (request.headers["if-none-match"] === tag) return end(response, 304, null, tag);
      const cached = archives.get(code);
      if (cached?.tag === tag) return send(response, 200, cached.body, tag);
      const game = await options.read.archive(dir);
      if (!game) return end(response, 404, { error: "nothing written yet" });
      const body = JSON.stringify(game);
      archives.set(code, { tag, body });
      return send(response, 200, body, tag);
    }

    return end(response, 404, { error: "not found" });
  }

  server.listen(options.port, options.bind, () => {
    options.say(`serving  http://${options.bind}:${options.port}/room/<room>`);
  });
  return server;
}

function end(response: ServerResponse, status: number, body: unknown, tag?: string): void {
  if (body === null) {
    if (tag) response.setHeader("ETag", tag);
    response.writeHead(status);
    response.end();
    return;
  }
  send(response, status, JSON.stringify(body), tag);
}

function send(response: ServerResponse, status: number, body: string, tag?: string): void {
  response.setHeader("Content-Type", "application/json");
  if (tag) response.setHeader("ETag", tag);
  response.writeHead(status);
  response.end(body);
}
