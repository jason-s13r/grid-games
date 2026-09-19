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
import { ARCHIVE_CAP, summarise } from "./ingest.js";
import type { Ingest, Status } from "./ingest.js";
import type { Rankings, Window } from "./rank.js";

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

/** A page of the corpus. Smaller than the board's, because a corpus is paged
 *  with a cursor rather than truncated. */
export const CORPUS_LIMIT = 100;

export interface ServeOptions {
  board: Board;
  /** Absent, and the archive routes 404. A board on its own is a whole
   *  deployment and 0015 shipped one. */
  ingest?: Ingest;
  /** The two tables, which exist only where there is a corpus to be over. */
  rankings?: Rankings;
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

    if (path[0] === "archives" && options.ingest) {
      return archives(options.ingest, request, response, path.slice(1), query);
    }
    if (path[0] === "rankings" && options.rankings) {
      if (request.method !== "GET") return end(response, 405, { error: "read only" });
      return rankings(options.rankings, response, path.slice(1), query);
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
    if (options.ingest) {
      options.say(`archives http://${options.bind}:${options.port}/archives`);
    }
    if (options.rankings) {
      options.say(`table    http://${options.bind}:${options.port}/rankings`);
    }
  });
  return server;
}

/** The store's three routes.
 *
 *  `GET /archives/:gameId` must satisfy `fetchArchive` in the web client, which
 *  sends `accept: application/json` and a 30 s deadline and nothing else. So:
 *  a JSON content type, the CORS header set above, and a body under
 *  `ARCHIVE_CAP`. No conditional request ever arrives — the client sends no
 *  `If-None-Match` — but the ETag is served anyway for anything else that
 *  fetches this, and it is the archive's own content hash rather than a live
 *  step, so it is correct forever. */
async function archives(
  ingest: Ingest,
  request: IncomingMessage,
  response: ServerResponse,
  path: readonly string[],
  query: string | undefined,
): Promise<void> {
  if (request.method === "POST" && path.length === 0) {
    const body = await collect(request, ARCHIVE_CAP);
    if (body === TOO_LARGE) return end(response, 413, { error: "that is more than a game" });
    const answer = await ingest.accept(body as Buffer);
    switch (answer.kind) {
      case "queued":
        return end(response, 202, { gameId: answer.gameId, status: "checking" });
      case "held":
        return end(response, 200, { gameId: answer.gameId, status: "held" });
      case "refused":
        return end(response, 422, { gameId: answer.gameId, problems: answer.problems });
      default:
        return end(response, 400, { error: "that is not a saved game" });
    }
  }

  if (request.method !== "GET") return end(response, 405, { error: "not a method this store takes" });

  if (path.length === 0) {
    // The plain index that makes a hosted table recomputable by a stranger: the
    // list of what this service holds, so anyone can fetch the same files and
    // derive the same numbers. It makes no claim about completeness — there is
    // no index of finished games anywhere, and this one is over what was
    // uploaded to it.
    const asked = new URLSearchParams(query ?? "");
    const status = asked.get("status");
    const corpus = await ingest.list({
      limit: limitOf(query, CORPUS_LIMIT, CORPUS_LIMIT),
      ...(asked.get("cursor") ? { cursor: asked.get("cursor")! } : {}),
      ...(isStatus(status) ? { status } : {}),
    });
    return end(response, 200, {
      archives: corpus.rows.map(summarise),
      ...(corpus.next ? { next: corpus.next } : {}),
    });
  }

  if (path.length > 1) return end(response, 404, { error: "not found" });
  const found = await ingest.read(decodeURIComponent(path[0]!));
  switch (found.kind) {
    case "held": {
      if (request.headers["if-none-match"] === found.tag) {
        response.setHeader("ETag", found.tag);
        return end(response, 304, null);
      }
      // Bytes out are bytes in. Not re-serialised, not key-sorted, not stripped
      // of anything — the file is handed back exactly as it was posted.
      response.setHeader("Content-Type", "application/json");
      response.setHeader("ETag", found.tag);
      response.writeHead(200);
      response.end(found.body);
      return;
    }
    case "checking":
      return end(response, 202, { status: "checking" });
    case "refused":
      return end(response, 422, { status: "refused", problems: found.problems });
    case "gone":
      // A different thing from the 404 below, and the distinction matters to a
      // reader deciding whether to look elsewhere for a copy.
      return end(response, 410, { error: "no longer held", checkedAt: found.checkedAt });
    default:
      return end(response, 404, { error: "never seen here" });
  }
}

const isStatus = (value: string | null): value is Status =>
  value === "checking" || value === "held" || value === "refused";

/** The two tables, and the list that makes the second one checkable.
 *
 *  Both responses carry `scope`, which is a deliverable rather than copy: a
 *  hosted leaderboard that quietly drops the qualifier is the failure mode, and
 *  it fails silently, because the table looks identical either way. */
async function rankings(
  tables: Rankings,
  response: ServerResponse,
  path: readonly string[],
  query: string | undefined,
): Promise<void> {
  const asked = new URLSearchParams(query ?? "");

  if (path[0] === "applied") {
    const page = await tables.page(
      limitOf(query, CORPUS_LIMIT, CORPUS_LIMIT),
      asked.get("cursor") ?? undefined,
    );
    return end(response, 200, page);
  }
  if (path.length > 0) return end(response, 404, { error: "not found" });

  const window: Window = asked.get("window") === "all" ? "all" : "held";
  const table = await tables.table(window);
  return end(response, 200, {
    ...table,
    // Null rather than an empty list for all-time, so a reader cannot mistake
    // "not shipped inline, fetch /rankings/applied" for "nothing was counted".
    counted: window === "all" ? null : table.counted,
    derivedAt: new Date(table.derivedAt).toISOString(),
  });
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

function limitOf(query: string | undefined, fallback = DEFAULT_LIMIT, most = MAX_LIMIT): number {
  const asked = Number(new URLSearchParams(query ?? "").get("limit"));
  if (!Number.isFinite(asked) || asked <= 0) return fallback;
  return Math.min(Math.floor(asked), most);
}

const TOO_LARGE = Symbol("too large");
const NOT_JSON = Symbol("not json");

/** A board write, parsed. */
async function read(request: IncomingMessage): Promise<unknown> {
  const body = await collect(request, WRITE_CAP);
  if (body === TOO_LARGE) return TOO_LARGE;
  try {
    return JSON.parse((body as Buffer).toString("utf8"));
  } catch {
    return NOT_JSON;
  }
}

/** The bytes, through a cap. A caller that sends 200 and then never stops is a
 *  caller that fills this process's memory while `json()` waits politely for
 *  the end — the same attack a hostile board runs on the client, pointed the
 *  other way, and it has to bite while the body is arriving rather than after. */
async function collect(
  request: IncomingMessage,
  cap: number,
): Promise<Buffer | typeof TOO_LARGE> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part = chunk as Buffer;
    size += part.byteLength;
    if (size > cap) {
      request.destroy();
      return TOO_LARGE;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
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
