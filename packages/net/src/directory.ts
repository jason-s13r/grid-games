// Finding a game, from a board that is allowed to lie.
//
// The board holds connection parameters and nothing else. It is not asked to be
// honest, only to be reachable: every row it hands back is re-derived from the
// sealed genesis record inside it, and a row that does not survive that is
// dropped without being shown. Any implementation qualifies — a static JSON file
// for a friends-only book, a small service for a public one, a host peer serving
// its own row — because the client is where the checking is.
//
// What that checking is worth, stated plainly, because the obvious reading is
// too generous. `gameIdOf` and `inspectGenesis` establish that a record is well
// formed. They do not establish that a game exists: a spammer with a key can
// compose ten thousand real records and every one of them passes. The one field
// on a row a stranger cannot manufacture is the witnesses — a majority of a
// game's own seats signing (step, hash) — which is 0005's artifact carried
// without its snapshot. A row with witnesses is a game; a row without them is a
// rumour, and the client returns both and says which is which, because a game
// that has not reached its first snapshot is exactly the game that most needs to
// be listed.
//
// This is the first HTTP client in the repository, which is why the fetch
// discipline below is spelled out rather than assumed.

import { DEFAULT_RULES, STEPS_PER_SECOND, playsProtocol, shelfLife } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import {
  Identity,
  canonicalJson,
  gameIdOf,
  inspectGenesis,
  utf8,
  verify,
} from "@tessera/protocol";
import type { MemberKey, SignedAmendment, SignedCheckpoint, SignedDrop } from "@tessera/protocol";
import { formatRef, parseRef } from "./ref.js";
import type { ConnectionRef } from "./ref.js";
import { verifyResumePoint } from "./resume.js";
import type { ResumeTally } from "./resume.js";

/** `fetch` has no default timeout, so a board that accepts a connection and
 *  never answers hangs a lobby screen for as long as the page is open. */
export const BOARD_TIMEOUT_MS = 8_000;

/** A hostile board can stream indefinitely and `response.json()` will happily
 *  buffer all of it. One cap per shape of answer, because the shapes differ by
 *  four orders of magnitude and a single generous number protects nothing. */
export const CAPS = {
  /** ~100 rows at the 2–4 kB a row with a genesis and witnesses costs. */
  list: 1_000_000,
  get: 64_000,
  /** A resume point carries a snapshot, which is the one thing here that is
   *  legitimately large. */
  point: 8_000_000,
} as const;

/** What a board is asked for when the caller does not say. A board with ten
 *  thousand rows is twenty megabytes; a client that asks for all of them has
 *  made the board's spam problem into the player's. */
export const DEFAULT_LIMIT = 100;

/** One door, as it sits on the board. */
export interface Listing {
  gameId: string;
  /** The sealed record. Required: without it there is nothing to verify and the
   *  row is a string somebody typed. */
  genesis: Genesis;
  /** `formatRef` output, one per entry. Strings rather than `ConnectionRef`s,
   *  so a row carrying a ref this build cannot parse is still a row. */
  refs: string[];
  /** Where a resume point can be fetched — 0006's `/room/:code/resume`. */
  resume?: string;
  /** (step, hash) signed by seats, and the only field below that costs a
   *  stranger a quorum of somebody else's keys. */
  witnesses?: SignedCheckpoint[];
  /** Needed to check the witnesses against the roster as it stood. Each is
   *  re-verified by the reader anyway. */
  amendments?: SignedAmendment[];
  drops?: SignedDrop[];
  /** What the witnesses are claimed to be about. A row whose step and hash do
   *  not match its witnesses has no proof, which is the same as having none. */
  step?: number;
  hash?: number;
  /** Live occupancy. A claim, permanently: it moves by amendment and by drop
   *  and the board sees neither. */
  seatsUsed?: number;
  /** The board's TTL, advisory, compared against the reader's own clock. */
  expiresAt?: number;
}

/** A game, as a caller sees it: the rows for it merged, everything derivable
 *  derived, and every claim still marked as one. */
export interface GameListing {
  gameId: string;
  genesis: Genesis;
  /** Parsed, deduplicated, in the order they were announced. */
  refs: ConnectionRef[];
  /** Refs that were on the board and this build could not read. Kept so a
   *  client can say "one of its doors needs a newer version" rather than quietly
   *  showing fewer ways in than exist. */
  unreadable: string[];
  resume: string[];
  /** Derived from the record, never read from the board. `keyed` is the seats
   *  that came with a key; the difference is the vacancies 0010 will create. */
  seats: { total: number; keyed: number };
  endsAt?: number;
  joinableUntil?: number;
  /** Whether this build can play it at all. A game this build cannot join is
   *  *shown as unplayable*, not hidden — a lobby that silently omits a game the
   *  player is in is the worst possible answer. */
  playable: boolean;
  sunset?: { version: number; until: string };
  /** Absent when no row carried witnesses. `ok` means a majority of this game's
   *  seats signed that it reached `step`. */
  proof?: ResumeTally & { step: number };
  /** The board's claim about live occupancy, forwarded so a client can render
   *  it as the claim it is. Nothing filters on it: a `joinable` filter that
   *  trusted this would be a hostile board deciding which games a player sees. */
  seatsUsed?: number;
}

export interface DirectoryOptions {
  /** The whole of the test seam: `directory.test.ts` hands in a function and
   *  never opens a socket. */
  fetch?: typeof fetch;
  now?: () => number;
  /** The deadline, injectable only so a test can prove it exists without
   *  waiting eight seconds for it — `AbortSignal.timeout` is native and no fake
   *  clock reaches inside it. */
  timeoutMs?: number;
}

/** The envelope a board stores a row under. The board verifies nothing about
 *  *games*; it verifies one thing about *writes* — that a row is refreshed and
 *  withdrawn by the key that first announced it — because otherwise anyone can
 *  clear a public board.
 *
 *  This says who posted a row and nothing about whether the row is true. The
 *  poster can be anyone, and `read()` never looks at it. */
export interface SignedListing {
  listing: Listing;
  by: MemberKey;
  sig: string;
}

export interface SignedWithdrawal {
  gameId: string;
  refs: string[];
  expiresAt: number;
  by: MemberKey;
  sig: string;
}

const WRITE_VERSION = 1;

/** What an announcer signs: the door, not the game. Canonical JSON so a board
 *  and a client in different languages agree on the bytes, and refs sorted so
 *  the order a host happened to list them in cannot change the signature. */
function writeBytes(
  kind: "announce" | "withdraw",
  gameId: string,
  refs: readonly string[],
  expiresAt: number,
): Uint8Array {
  return utf8(
    canonicalJson({ v: WRITE_VERSION, kind, gameId, refs: [...refs].sort(), expiresAt }),
  );
}

/** Whether a write was signed by the key it claims. Exported for whoever
 *  implements a board: the rule is one `verify` call and it should not be
 *  reimplemented from the paragraph above. */
export async function verifyWrite(
  write: SignedListing | SignedWithdrawal,
): Promise<boolean> {
  const kind = "listing" in write ? "announce" : "withdraw";
  const gameId = "listing" in write ? write.listing.gameId : write.gameId;
  const refs = "listing" in write ? write.listing.refs : write.refs;
  const expiresAt = ("listing" in write ? write.listing.expiresAt : write.expiresAt) ?? 0;
  if (typeof gameId !== "string" || !Array.isArray(refs) || typeof write.sig !== "string") {
    return false;
  }
  return verify(write.by, write.sig, writeBytes(kind, gameId, refs, expiresAt));
}

export class Directory {
  /** Borrowed by `resolve`, so one injected fetch covers a whole lookup —
   *  the board's rows and the host peer's resume points are read under the same
   *  discipline and, in a test, through the same function. */
  readonly http: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(url: string, options: DirectoryOptions = {}) {
    this.base = url.replace(/\/+$/, "");
    this.http = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? BOARD_TIMEOUT_MS;
  }

  /** Every game the board will admit to, merged and checked.
   *
   *  `joinable` is derived from the record — the join window against our own
   *  clock — and never from the board's occupancy claim. There is deliberately
   *  no `open` filter: whether anybody is still in a room is not something a
   *  board can know, and `resolve` answers it by dialling. */
  async list(filter: { limit?: number; joinable?: boolean } = {}): Promise<GameListing[]> {
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const url = `${this.base}?limit=${limit}`;
    const rows = asRows(await this.readJson(url, CAPS.list));
    const listings = await this.merge(rows.slice(0, limit));
    if (!filter.joinable) return listings;
    const now = this.now();
    return listings.filter((one) => one.joinableUntil === undefined || one.joinableUntil > now);
  }

  /** One game by id. A board may answer with a single row or with every door it
   *  holds for that game; both are merged the same way. */
  async get(gameId: string): Promise<GameListing | undefined> {
    const url = `${this.base}/${encodeURIComponent(gameId)}`;
    const body = await this.readJson(url, CAPS.get, { cache: "no-store" });
    const merged = await this.merge(asRows(body));
    // A board that answers /games/<id> with somebody else's game has answered
    // the wrong question, and the id we asked for is the only thing we know.
    return merged.find((one) => one.gameId === gameId);
  }

  /** Post a door. The listing is signed, because a board that cannot tell a
   *  heartbeat from a hijack lets anyone withdraw every game on it. */
  async announce(identity: Identity, listing: Listing): Promise<void> {
    const write: SignedListing = {
      listing,
      by: identity.key,
      sig: await identity.sign(
        writeBytes("announce", listing.gameId, listing.refs, listing.expiresAt ?? 0),
      ),
    };
    await this.post(this.base, write);
  }

  /** The same POST, and a different word for what the caller is doing: keeping
   *  a row alive, and carrying whatever witnesses have accumulated since the
   *  last one. A door's TTL is the only thing that removes it when its host
   *  dies without saying so. */
  async present(identity: Identity, listing: Listing): Promise<void> {
    await this.announce(identity, listing);
  }

  /** Take a door down. Signed by the key that put it up; a board that ignores
   *  the signature is a board anyone can clear, which is its own choice to
   *  make and not something a client can enforce. */
  async withdraw(identity: Identity, gameId: string, refs: readonly string[]): Promise<void> {
    const write: SignedWithdrawal = {
      gameId,
      refs: [...refs],
      expiresAt: 0,
      by: identity.key,
      sig: await identity.sign(writeBytes("withdraw", gameId, refs, 0)),
    };
    await this.post(`${this.base}/withdraw`, write);
  }

  /** Rows to games. Several announcers may hold doors into one game, and a
   *  client showing two entries for one gameId would be showing the board's
   *  bookkeeping rather than the world. */
  private async merge(rows: unknown[]): Promise<GameListing[]> {
    const games = new Map<string, GameListing>();
    for (const row of rows) {
      const read = await this.read(row);
      if (!read) continue;
      const found = games.get(read.gameId);
      if (!found) {
        games.set(read.gameId, read);
        continue;
      }
      for (const ref of read.refs) {
        if (!found.refs.some((one) => formatRef(one) === formatRef(ref))) found.refs.push(ref);
      }
      for (const text of read.unreadable) {
        if (!found.unreadable.includes(text)) found.unreadable.push(text);
      }
      for (const url of read.resume) if (!found.resume.includes(url)) found.resume.push(url);
      if (better(read.proof, found.proof)) found.proof = read.proof;
      found.seatsUsed ??= read.seatsUsed;
    }
    return [...games.values()];
  }

  /** One row, checked. The order matters: shape, then identity, then the
   *  record's own rules, then the parts that are only claims. */
  private async read(row: unknown): Promise<GameListing | undefined> {
    if (!plausible(row)) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt <= this.now()) return undefined;

    const genesis = row.genesis;
    if (row.gameId !== (await gameIdOf(genesis))) return undefined;

    const problems = await inspectGenesis(genesis);
    // "protocol" is not a reason to hide a game — it is a reason to say so.
    // Every other problem means the record is one no peer would agree to play,
    // so there is nothing behind the row to reach.
    if (problems.some((problem) => problem !== "protocol")) return undefined;

    const refs: ConnectionRef[] = [];
    const unreadable: string[] = [];
    for (const text of row.refs) {
      if (typeof text !== "string") continue;
      try {
        const ref = parseRef(text);
        if (!refs.some((one) => formatRef(one) === formatRef(ref))) refs.push(ref);
      } catch {
        // A door this build cannot open is still a door, and a client that
        // dropped it would report fewer ways in than the game has.
        if (!unreadable.includes(text)) unreadable.push(text);
      }
    }

    const rules = { ...DEFAULT_RULES, ...(genesis.rules ?? {}) };
    const endStep = whole(rules.endStep);
    const joinWindow = whole(rules.joinWindow);
    const startedAt = whole(genesis.startedAt) ?? 0;
    const sunset = shelfLife(genesis);

    return {
      gameId: row.gameId,
      genesis,
      refs,
      unreadable,
      resume: typeof row.resume === "string" ? [row.resume] : [],
      seats: seatsOf(genesis),
      ...(endStep ? { endsAt: startedAt + msOf(endStep) } : {}),
      ...(joinWindow ? { joinableUntil: startedAt + msOf(joinWindow) } : {}),
      playable: playsProtocol(genesis.protocol),
      ...(sunset ? { sunset } : {}),
      ...(await this.prove(row, genesis)),
      ...(typeof row.seatsUsed === "number" ? { seatsUsed: row.seatsUsed } : {}),
    };
  }

  /** The tally over a claim with no bytes attached. Absent rather than false
   *  when the row carried nothing to check: "no proof" and "a proof that failed"
   *  are different things to show a player. */
  private async prove(
    row: Listing,
    genesis: Genesis,
  ): Promise<{ proof?: ResumeTally & { step: number } }> {
    if (!Array.isArray(row.witnesses) || row.witnesses.length === 0) return {};
    const step = whole(row.step);
    if (step === undefined || typeof row.hash !== "number") return {};
    const tally = await verifyResumePoint(genesis, {
      step,
      hash: row.hash,
      amendments: Array.isArray(row.amendments) ? row.amendments : [],
      drops: Array.isArray(row.drops) ? row.drops : [],
      witnesses: row.witnesses,
    });
    return { proof: { ...tally, step } };
  }

  private async readJson(url: string, cap: number, extra: RequestInit = {}): Promise<unknown> {
    const response = await this.send(url, {
      method: "GET",
      // There is nothing to authenticate with and nothing to send. Reading a
      // board should say what you want, not who you are — no identity, no key,
      // no fingerprint, and no custom header to fingerprint the client by.
      credentials: "omit",
      ...extra,
    });
    if (!response.ok) {
      throw new Error(`that board answered ${response.status} for ${url}`);
    }
    return parse(await capped(response, cap), url);
  }

  private async post(url: string, body: unknown): Promise<void> {
    const response = await this.send(url, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // A static-file board is read-only, and this is what that looks like from
      // here: the server's own status, said plainly, rather than a retry loop
      // against something that will never accept a write.
      throw new Error(`that board answered ${response.status} — it may be read-only`);
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(reach(error, url, this.timeoutMs));
    }
  }
}

/** A hostile board can be slow, absent, or on the wrong side of a CORS policy,
 *  and `fetch` reports the last two identically and opaquely by design. A
 *  `TypeError: Failed to fetch` in a lobby is not a message. */
function reach(error: unknown, url: string, timeoutMs: number): string {
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `that board did not answer within ${timeoutMs / 1000}s (${url})`;
  }
  return `could not read that board — it may be unreachable, or it may not allow this page to read it (${url})`;
}

/** Read through a cap. The body is a stream from a stranger: a board that
 *  answers 200 and then never stops is a board that fills the tab's memory
 *  while `json()` waits politely for the end. */
async function capped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > cap) throw new Error(`that board sent more than ${cap} bytes`);
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`that board sent more than ${cap} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parse(text: string, url: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`that board did not answer with JSON (${url})`);
  }
}

/** Boards answer in whichever shape their author liked: a bare array, `{ games }`,
 *  `{ listings }`, or one row. Everything below `read()` treats each entry as
 *  `unknown` regardless, so being generous here costs nothing. */
function asRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["games", "listings", "rows"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return record.gameId !== undefined ? [body] : [];
}

/** Shape only, exactly as `decodeFrame` treats the wire. Everything a row
 *  asserts about itself is checked after this, by something that can. */
function plausible(row: unknown): row is Listing {
  if (!row || typeof row !== "object") return false;
  const one = row as Record<string, unknown>;
  if (typeof one.gameId !== "string" || !one.gameId) return false;
  if (!Array.isArray(one.refs)) return false;
  if (one.expiresAt !== undefined && typeof one.expiresAt !== "number") return false;
  const genesis = one.genesis;
  if (!genesis || typeof genesis !== "object") return false;
  const record = genesis as Record<string, unknown>;
  return typeof record.protocol === "number" && Array.isArray(record.empires);
}

/** Seats as the record says, which is the only place they can be counted
 *  honestly: `Roster.fromGenesis` skips a member with no key, so the keyed
 *  count and the total differ by exactly the seats that came empty. A derived
 *  number cannot be lied about, which is why neither of these is on the wire. */
function seatsOf(genesis: Genesis): { total: number; keyed: number } {
  let total = 0;
  let keyed = 0;
  for (const empire of genesis.empires) {
    for (const member of empire.members ?? []) {
      total++;
      if (member.key) keyed++;
    }
  }
  return { total, keyed };
}

const msOf = (steps: number): number => Math.round((steps / STEPS_PER_SECOND) * 1000);

const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Which of two proofs to keep for a merged game. Endorsed beats unendorsed,
 *  and among equals the later step wins: a row is a snapshot of what its
 *  announcer had seen, and the one that had seen more of the game is the one
 *  worth showing. */
function better(
  candidate: (ResumeTally & { step: number }) | undefined,
  against: (ResumeTally & { step: number }) | undefined,
): boolean {
  if (!candidate) return false;
  if (!against) return true;
  if (candidate.ok !== against.ok) return candidate.ok;
  return candidate.step > against.step;
}
