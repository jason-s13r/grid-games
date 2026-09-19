// Two tables, audited differently, and the difference is the whole file.
//
// `rankArchives` opens by naming the thing it is trying not to be: a number a
// client reported, kept by a server nobody can audit. Putting that derivation
// behind a URL is the one move most likely to turn it back into exactly that,
// and the answer is not a promise — it is an endpoint. **The table ships with
// its corpus.** A reader who wants to check the window table fetches the ids in
// `counted` from `GET /archives/:gameId`, runs `rankArchives` locally, and gets
// the same table or finds out why not. A falsifiable claim is a different kind
// of object from a leaderboard.
//
// That works while the archives are there, and 0016 does not keep them forever.
// So:
//
//   window   over the archives still held      recomputable entirely by anyone
//   all-time over every game ever applied      checkable against a published list
//
// Nothing here is weighted, tuned, decayed or seasoned. Every column is a count
// from hashed state and the sort is the only opinion, because a rating nobody
// can explain is a table nobody can check — which would give back exactly what
// the signatures were for.

import { standingsFrom } from "@tessera/net";
import type { Counted, Leaderboard } from "@tessera/net";
import type { Archives } from "./ingest.js";

/** A game's contribution to the totals, kept forever.
 *
 *  Keyed on `gameId` and **not** on a hash of the uploaded file. This is the one
 *  choice that would silently break the accumulator: two observers archiving one
 *  game produce two different files — different message sets, different `steps`,
 *  different byte counts — that both verify and describe the same game. Keyed on
 *  bytes they are two rows and every key in that game is counted twice; keyed on
 *  the game id they are one, which is what `rankArchives` already dedupes on. */
export interface Applied {
  gameId: string;
  /** How far the copy this contribution came from got. A later archive of the
   *  same game with *more* steps supersedes: whichever copy happened to be
   *  uploaded first must not become the game's contribution forever. */
  steps: number;
  contribution: Counted;
  appliedAt: number;
}

export interface AppliedStore {
  put(row: Applied): Promise<void>;
  get(gameId: string): Promise<Applied | undefined>;
  /** Every contribution, oldest first. The fold's whole input. */
  all(): Promise<Applied[]>;
  page(limit: number, cursor?: string): Promise<{ rows: Applied[]; next?: string }>;
  /** When the first game was applied, for the all-time scope sentence. */
  since(): Promise<number | null>;
}

export type Window = "held" | "all";

export interface Table extends Leaderboard {
  /** The corpus — a list of ids for the window, `null` for all-time, because an
   *  all-time corpus is unbounded and shipping it inline would eventually be the
   *  largest response this service has. `GET /rankings/applied` is the paged
   *  form, and it is the thing that keeps the all-time table auditable at all. */
  counted: string[];
  games: number;
  derivedAt: number;
  /** The sentence that bounds this table. A deliverable rather than copy: a
   *  hosted leaderboard that quietly drops the qualifier is the failure mode,
   *  and it fails silently — the table looks identical. */
  scope: string;
}

export interface RankingsOptions {
  archives: Archives;
  applied: AppliedStore;
  now?: () => number;
}

export class Rankings {
  private readonly archives: Archives;
  private readonly applied: AppliedStore;
  private readonly now: () => number;

  constructor(options: RankingsOptions) {
    this.archives = options.archives;
    this.applied = options.applied;
    this.now = options.now ?? (() => Date.now());
  }

  /** Apply a verified game, or supersede the copy already applied.
   *
   *  Idempotent on the game id, so a second archive of a game already counted
   *  does not double anybody's `games` — including one whose *bytes* differ,
   *  which is the case a file hash would have got wrong. */
  async apply(gameId: string, steps: number, contribution: Counted): Promise<void> {
    const already = await this.applied.get(gameId);
    if (already && steps <= already.steps) return;
    await this.applied.put({ gameId, steps, contribution, appliedAt: this.now() });
  }

  /** The window table: recomputed, over the archives this service still holds.
   *
   *  Folded from the contributions rather than by replaying the files, because
   *  the replay was already paid for at ingest — but it is over exactly the
   *  games whose files are still here, so a reader can fetch them and derive the
   *  same numbers. That is the property the endpoint exists for. */
  async table(window: Window): Promise<Table> {
    const applied = await this.applied.all();
    const rows = window === "all" ? applied : await this.held(applied);
    const board = standingsFrom(
      rows.map((row) => row.contribution),
      await this.refusals(),
    );
    return {
      ...board,
      // Held ships its corpus inline. All-time does not and cannot: the list is
      // unbounded, and `GET /rankings/applied` is where it is published.
      counted: window === "all" ? [] : board.counted,
      games: rows.length,
      derivedAt: this.now(),
      scope: window === "all" ? await this.allTimeScope() : HELD_SCOPE,
    };
  }

  /** The all-time corpus, paged. What keeps the accumulated table auditable: the
   *  totals are a pure function of a list this service publishes, so an
   *  arithmetic error is visible to anybody without holding a single archive. */
  async page(limit: number, cursor?: string): Promise<{ applied: Applied[]; next?: string }> {
    const found = await this.applied.page(limit, cursor);
    return { applied: found.rows, ...(found.next ? { next: found.next } : {}) };
  }

  /** Games whose archive is still here. An evicted game drops out of the window
   *  entirely — that table is defined as *over the archives this service holds*
   *  — and keeps its contribution to the total, because a monoid does not need
   *  its inputs back. */
  private async held(applied: readonly Applied[]): Promise<Applied[]> {
    const kept: Applied[] = [];
    for (const row of applied) {
      const head = await this.archives.head(row.gameId);
      if (head?.status === "held" && head.evictedAt === null) kept.push(row);
    }
    return kept;
  }

  /** Refusals are served, not swallowed. `index` is a position in an input list,
   *  meaningful to a local caller and meaningless across a wire; it is kept only
   *  so `Leaderboard` does not fork into two types, and a hosted reader should
   *  use `game` instead. */
  private async refusals(): Promise<Leaderboard["refused"]> {
    const found = await this.archives.list({ limit: 500, status: "refused" });
    return found.rows.map((row, index) => ({
      index,
      game: row.gameId,
      problems: row.problems,
    }));
  }

  private async allTimeScope(): Promise<string> {
    const first = await this.applied.since();
    const when = first === null ? "this service started" : new Date(first).toISOString().slice(0, 10);
    return (
      `Over every game applied here since ${when}. Archives for older games are ` +
      `no longer held, so those figures can be checked against the published ` +
      `list of what was counted, but not replayed from here.`
    );
  }
}

/** The web client already renders this under any table it draws, and it is
 *  still true of a hosted one: an index of what was uploaded to one service is
 *  not an index of finished games. */
export const HELD_SCOPE = "Over the archives this service holds — not every game ever played.";

/** Contributions, in memory.
 *
 *  Note what is *not* here: a running total kept beside the rows. The all-time
 *  table is folded from these on demand instead, and the reason is that it costs
 *  nothing to be right. A fold is nine lines of arithmetic over a few hundred
 *  bytes a game, against an ingest that replays ten million steps to produce one
 *  of them — so the fold is free relative to the thing that triggers it, and it
 *  is exactly the computation a reader does over `GET /rankings/applied` to
 *  check this service's answer.
 *
 *  A kept total would need the supersede case to subtract sums and recompute the
 *  three maxima for the affected keys, because a max cannot be un-maxed. That is
 *  more code for an identical answer, and its repair path — when a bug does get
 *  into the total — is to refold the applied-set from the beginning, which is
 *  what this does every time. If the corpus ever outgrows the fold, an
 *  incremental total is the optimisation and this stays the check on it. */
export class MemoryApplied implements AppliedStore {
  private readonly rows = new Map<string, Applied>();

  async put(row: Applied): Promise<void> {
    this.rows.set(row.gameId, row);
  }

  async get(gameId: string): Promise<Applied | undefined> {
    return this.rows.get(gameId);
  }

  async all(): Promise<Applied[]> {
    return [...this.rows.values()].sort((a, b) => a.appliedAt - b.appliedAt);
  }

  async page(limit: number, cursor?: string): Promise<{ rows: Applied[]; next?: string }> {
    const ordered = [...this.rows.values()]
      .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0))
      .filter((row) => (cursor ? row.gameId > cursor : true));
    const rows = ordered.slice(0, limit);
    const more = ordered.length > limit;
    return { rows, ...(more && rows.length > 0 ? { next: rows[rows.length - 1]!.gameId } : {}) };
  }

  async since(): Promise<number | null> {
    let first: number | null = null;
    for (const row of this.rows.values()) {
      if (first === null || row.appliedAt < first) first = row.appliedAt;
    }
    return first;
  }
}
