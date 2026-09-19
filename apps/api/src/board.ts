// Rows, and the one rule a board is allowed to enforce.
//
// A board does not verify a game. It does not recompute a game id, does not
// decide which games are joinable, does not merge two announcers' rows, does not
// reorder refs or drop witnesses it cannot check. Every one of those is a
// helpful thing to do and every one of them breaks a client that is already
// written to do it itself — `Directory.read` re-derives the id from the sealed
// genesis, tallies the witnesses against the roster, and drops what does not
// survive. Checking here would not add a guarantee; it would add a second place
// for the two to disagree.
//
// So this file enforces exactly one thing, and it is access control rather than
// adjudication: a row is owned by the key that announced it, so a refresh or a
// withdrawal needs that key's signature. The signature says who posted a row,
// never that the row is true.
//
// The rate limits at the bottom are the only other opinion, and they are an
// operator's rather than a protocol's. 0007 deferred them in as many words.

import { verifyWrite } from "@tessera/net";
import type { Listing, SignedListing, SignedWithdrawal } from "@tessera/net";

/** One door, as the service holds it. The `listing` is the posted document,
 *  whole and unaltered — see `Store.upsert`. */
export interface Row {
  gameId: string;
  ref: string;
  /** A `MemberKey`: base64url of the P-256 point that signed the write. */
  owner: string;
  listing: Listing;
  expiresAt: number;
  updatedAt: number;
}

/** What a board needs out of its storage, and nothing else. Injected so the
 *  rules above can be tested without a database and run against Postgres in
 *  production — the same seam `apps/host`'s `serve()` uses for the disk. */
export interface Store {
  /** The current owners of the `(gameId, ref)` pairs named, for the ownership
   *  check. Rows that have expired are not owned by anybody: a key may take
   *  over a row only after its lease has run out. */
  owners(gameId: string, refs: readonly string[], now: number): Promise<Map<string, string>>;
  /** N rows for one post, replacing whatever stood at those keys. */
  upsert(rows: readonly Row[]): Promise<void>;
  /** Delete the named `(gameId, ref)` pairs that `owner` holds. Returns nothing:
   *  telling a stranger which of the refs they named exist is information the
   *  board has no reason to hand out. */
  remove(gameId: string, refs: readonly string[], owner: string): Promise<void>;
  /** Unexpired rows, most recently updated first. */
  list(limit: number, now: number): Promise<Row[]>;
  /** The same, narrowed to one game. A board may hold several doors into it. */
  forGame(gameId: string, now: number): Promise<Row[]>;
  /** How many unexpired rows this key holds, and this game has. Two numbers
   *  from one call because the write path always wants both. */
  counts(owner: string, gameId: string, now: number): Promise<{ byOwner: number; byGame: number }>;
  /** Drop what has expired. A read excludes expired rows anyway; this is what
   *  stops the table growing. */
  sweep(now: number): Promise<number>;
}

/** What an operator bounds. Invisible to the client except as a shorter list or
 *  a status code it reports verbatim.
 *
 *  Said plainly, because the table reads like a defence and is not one: a key is
 *  free to mint, so a per-key limit alone bounds nothing. What actually bounds a
 *  public board is something in front of the process — a per-IP limiter, or a
 *  price on a row — and neither is here. */
export interface Limits {
  /** A host runs one game per process; 32 is generous and finite. */
  rowsPerOwner: number;
  /** 0006's redundancy is a handful of doors, not a thousand. */
  rowsPerGame: number;
  /** Heartbeats are every 90 s. 20 a minute is two orders of headroom. */
  writesPerMinute: number;
  /** A row nobody refreshes should not outlive the process that posted it by
   *  much. The web announcer asks for 3 minutes and the host peer for `--ttl`,
   *  default the same; 15 minutes is five times either. */
  ttlCeilingMs: number;
}

export const LIMITS: Limits = {
  rowsPerOwner: 32,
  rowsPerGame: 8,
  writesPerMinute: 20,
  ttlCeilingMs: 15 * 60_000,
};

/** What a route hands back to the HTTP layer. Prose bodies in lowercase, which
 *  is the house style `apps/host/src/serve.ts` set. */
export interface Answer {
  status: number;
  body: unknown;
}

export interface BoardOptions {
  store: Store;
  now?: () => number;
  limits?: Limits;
}

export class Board {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly limits: Limits;
  /** Write timestamps per key, for the per-minute limit. In memory on purpose:
   *  it is a throttle rather than a ledger, and a restart forgetting it costs a
   *  minute of headroom to somebody who was already inside the limit. */
  private readonly recent = new Map<string, number[]>();

  constructor(options: BoardOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.limits = options.limits ?? LIMITS;
  }

  /** `POST {base}` — an announcement, or a heartbeat, which are the same thing.
   *
   *  `present` is not a separate endpoint and could not be: `directory.ts:245`
   *  is `async present(...) { await this.announce(identity, listing); }`, and
   *  the service cannot tell a first announcement from a refresh. Both are an
   *  upsert, which is the point. */
  async announce(write: unknown): Promise<Answer> {
    if (!plausibleListing(write)) return { status: 400, body: { error: "not a listing" } };
    if (!(await verifyWrite(write))) {
      return { status: 403, body: { error: "that was not signed by the key it claims" } };
    }

    const now = this.now();
    const { listing, by } = write;
    const refs = [...new Set(listing.refs)];
    if (refs.length === 0) return { status: 400, body: { error: "a row with no door" } };

    const throttled = this.throttle(by, now);
    if (throttled) return throttled;

    const owners = await this.store.owners(listing.gameId, refs, now);
    for (const [ref, owner] of owners) {
      // Access control, not adjudication. A row belongs to whoever put it up
      // until its lease runs out, because otherwise anyone can clear a public
      // board — and anyone could redirect a game's door at their own relay.
      if (owner !== by) {
        return { status: 403, body: { error: "that door belongs to another key", ref } };
      }
    }

    const counts = await this.store.counts(by, listing.gameId, now);
    // Only the refs that are not already this key's rows count as new ones,
    // or a heartbeat at the ceiling would be refused forever.
    const fresh = refs.filter((ref) => !owners.has(ref)).length;
    if (counts.byOwner + fresh > this.limits.rowsPerOwner) {
      return { status: 429, body: { error: "too many rows for one key" } };
    }
    if (counts.byGame + fresh > this.limits.rowsPerGame) {
      return { status: 429, body: { error: "too many doors into one game" } };
    }

    // The client's expiry, clamped rather than issued. A client that had to ask
    // for a lease would need a round trip before it could hold a game open, and
    // a board that shortened every row would be deciding how long a game lives.
    // A row that arrives already expired is stored as given and swept, because
    // "stores what it is given" is easier to reason about than a special case,
    // and it is never read: both this service and the client check the expiry.
    const asked = listing.expiresAt ?? now + this.limits.ttlCeilingMs;
    const expiresAt = Math.min(asked, now + this.limits.ttlCeilingMs);

    // One POST, N refs, N rows — each holding the same document. The
    // alternative, one row holding the whole `refs` array, breaks the property
    // the keying exists for: two hosts announcing two doors into one game would
    // overwrite each other, and 0006 is explicit that redundancy for the door is
    // the address book's job.
    await this.store.upsert(
      refs.map((ref) => ({ gameId: listing.gameId, ref, owner: by, listing, expiresAt, updatedAt: now })),
    );
    return { status: 200, body: { ok: true } };
  }

  /** `POST {base}/withdraw` — a door taken down by the key that put it up.
   *
   *  Rows the caller does not own are left standing and the answer is still
   *  200. A withdrawal is not a query. */
  async withdraw(write: unknown): Promise<Answer> {
    if (!plausibleWithdrawal(write)) return { status: 400, body: { error: "not a withdrawal" } };
    if (!(await verifyWrite(write))) {
      return { status: 403, body: { error: "that was not signed by the key it claims" } };
    }
    const throttled = this.throttle(write.by, this.now());
    if (throttled) return throttled;
    await this.store.remove(write.gameId, [...new Set(write.refs)], write.by);
    return { status: 200, body: { ok: true } };
  }

  /** `GET {base}?limit=n`.
   *
   *  No `joinable` filter, no `open` filter, and no ordering a caller can ask
   *  for. `Directory.list` derives joinability from the record's join window
   *  against the reader's own clock, and whether anybody is still in a room is
   *  not something a board can know — `resolve` answers that by dialling.
   *  `seatsUsed` is forwarded verbatim and never read here: it is a claim
   *  permanently, and a filter that trusted it would be a hostile board
   *  deciding which games a player sees. */
  async list(limit: number): Promise<Answer> {
    const rows = await this.store.list(limit, this.now());
    return { status: 200, body: { games: rows.map((row) => row.listing) } };
  }

  /** `GET {base}/{gameId}`. The client does `merged.find(one => one.gameId ===
   *  gameId)` and refuses a board that answers the wrong game, so there is no
   *  point in being clever here. */
  async get(gameId: string): Promise<Answer> {
    const rows = await this.store.forGame(gameId, this.now());
    return { status: 200, body: { games: rows.map((row) => row.listing) } };
  }

  /** Expired rows are excluded from reads as well, because a sweeper on a timer
   *  serves a dead door until it next runs. This only stops the table growing. */
  async sweep(): Promise<number> {
    const now = this.now();
    for (const [key, times] of this.recent) {
      const kept = times.filter((at) => at > now - 60_000);
      if (kept.length === 0) this.recent.delete(key);
      else this.recent.set(key, kept);
    }
    return this.store.sweep(now);
  }

  private throttle(by: string, now: number): Answer | undefined {
    const times = (this.recent.get(by) ?? []).filter((at) => at > now - 60_000);
    if (times.length >= this.limits.writesPerMinute) {
      this.recent.set(by, times);
      return { status: 429, body: { error: "too many writes from one key" } };
    }
    times.push(now);
    this.recent.set(by, times);
    return undefined;
  }
}

/** Shape only, and deliberately nothing about the genesis.
 *
 *  A row whose genesis is nonsense is a row the *reader* drops — `gameIdOf` and
 *  `inspectGenesis` do that in `Directory.read` — and a board that pre-filtered
 *  them would be adjudicating. What is checked is what this service itself has
 *  to touch: an id to key on, refs to fan out over, and a key and signature to
 *  check ownership with. */
function plausibleListing(write: unknown): write is SignedListing & { listing: Listing } {
  if (!write || typeof write !== "object") return false;
  const one = write as Record<string, unknown>;
  if (typeof one.by !== "string" || !one.by) return false;
  if (typeof one.sig !== "string" || !one.sig) return false;
  const listing = one.listing;
  if (!listing || typeof listing !== "object") return false;
  const row = listing as Record<string, unknown>;
  if (typeof row.gameId !== "string" || !row.gameId) return false;
  if (!Array.isArray(row.refs) || !row.refs.every((ref) => typeof ref === "string" && ref)) {
    return false;
  }
  return row.expiresAt === undefined || typeof row.expiresAt === "number";
}

function plausibleWithdrawal(write: unknown): write is SignedWithdrawal {
  if (!write || typeof write !== "object") return false;
  const one = write as Record<string, unknown>;
  if (typeof one.by !== "string" || !one.by) return false;
  if (typeof one.sig !== "string" || !one.sig) return false;
  if (typeof one.gameId !== "string" || !one.gameId) return false;
  return Array.isArray(one.refs) && one.refs.every((ref) => typeof ref === "string");
}
