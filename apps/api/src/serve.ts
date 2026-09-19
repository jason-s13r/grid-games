// The four endpoints, and the headers without which none of them work.
//
// Routing is hand-rolled string splitting, exactly as `apps/host/src/serve.ts`
// does it, because adding the first framework to this tree for four routes would
// be a larger change than the feature.
//
// There is no fifth endpoint. `present` is not one — `directory.ts` is
// `async present(...) { await this.announce(identity, listing); }` and the
// service cannot tell a first announcement from a heartbeat, which is the point.
//
// CORS is not optional here and it is not the host peer's. That server accepts
// no writes, so its preflight answers `GET, OPTIONS` and names no headers; this
// one takes a POST carrying `Content-Type: application/json`, which is not a
// CORS-simple type, so a missing `Access-Control-Allow-Headers` would leave
// reads working, writes failing, and the browser console the only place that
// says why.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { DEFAULT_LIMIT } from "@tessera/net";
import type { Answer, Board } from "./board.js";

/** A body bigger than this is a body no honest announcer sends: a `Listing`
 *  carries a genesis and a handful of witnesses and costs a few kilobytes.
 *  Cut off rather than buffered, which is the discipline `Directory.readJson`
 *  already uses against a hostile board, from the other side. */
export const WRITE_CAP = 512_000;

/** What a caller may ask for at once. The client's own `CAPS.list` is 1 MB and
 *  it truncates locally as well, so a board that ignored `limit` would merely
 *  be wasteful — until it crossed that cap somewhere around three hundred rows
 *  and the client cut the answer off mid-stream. Honouring it is not optional
 *  in practice. */
export const MAX_LIMIT = 500;

export interface ServeOptions {
  board: Board;
  bind: string;
  port: number;
  say: (line: string) => void;
}

export function serve(options: ServeOptions): Server {
  const server = createServer((request, response) => {
    void answer(request, response).catch(() => end(response, 500, { error: "server" }));
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Set before routing, on every response including the errors. The web client
    // is served from GitHub Pages and a board is somewhere else, so every
    // request here is cross-origin and a missing header fails opaquely.
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Max-Age", "86400");
      return end(response, 204, null);
    }

    const [target, query] = (request.url ?? "/").split("?");
    const path = target!.split("/").filter(Boolean);

    if (request.method === "GET" && path.length === 0) {
      // Not a route the client ever asks for; a health check for whatever is in
      // front of the process.
      return end(response, 200, { service: "tessera-api", ok: true });
    }

    if (path[0] !== "games") return end(response, 404, { error: "not found" });
    const rest = path.slice(1);

    if (request.method === "GET") {
      if (rest.length === 0) return done(response, await options.board.list(limitOf(query)));
      if (rest.length === 1) {
        return done(response, await options.board.get(decodeURIComponent(rest[0]!)));
      }
      return end(response, 404, { error: "not found" });
    }

    if (request.method === "POST") {
      const body = await read(request);
      if (body === TOO_LARGE) return end(response, 413, { error: "that is too much board" });
      if (body === NOT_JSON) return end(response, 400, { error: "that was not json" });
      if (rest.length === 0) return done(response, await options.board.announce(body));
      if (rest.length === 1 && rest[0] === "withdraw") {
        return done(response, await options.board.withdraw(body));
      }
      return end(response, 404, { error: "not found" });
    }

    return end(response, 405, { error: "not a method this board takes" });
  }

  server.listen(options.port, options.bind, () => {
    options.say(`board    http://${options.bind}:${options.port}/games`);
  });
  return server;
}

/** The answer envelope, for both GETs.
 *
 *  An object rather than a bare array, so a field can be added later without
 *  changing the type of the response, and `games` because it is the key
 *  `asRows` tries first. All four shapes it accepts are legal and a body that
 *  is none of them yields **zero rows and no error** — which means a service bug
 *  answering `{"data": [...]}` would look exactly like an empty board. That is
 *  why the tests assert on rows read back through `Directory` and never on the
 *  JSON emitted here. */
function done(response: ServerResponse, answer: Answer): void {
  end(response, answer.status, answer.body);
}

function limitOf(query: string | undefined): number {
  const asked = Number(new URLSearchParams(query ?? "").get("limit"));
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(asked), MAX_LIMIT);
}

const TOO_LARGE = Symbol("too large");
const NOT_JSON = Symbol("not json");

/** A write body, read through a cap. A caller that sends 200 and then never
 *  stops is a caller that fills this process's memory while `json()` waits
 *  politely for the end — the same attack a hostile board runs on the client,
 *  pointed the other way. */
async function read(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part = chunk as Buffer;
    size += part.byteLength;
    if (size > WRITE_CAP) {
      request.destroy();
      return TOO_LARGE;
    }
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return NOT_JSON;
  }
}

function end(response: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.writeHead(status);
  response.end(JSON.stringify(body));
}
