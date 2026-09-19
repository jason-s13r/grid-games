// An archive is self-proving, so nobody has to be trusted to have written one.
//
// `verifyArchive` re-hashes the genesis, rebuilds the roster from it, walks every
// amendment and claim, checks every signature against the roster as it stood,
// replays the whole log and compares the result to the hash the file claims. A
// file that survives that was produced by the game it says it was.
//
// So this store does not need to know who uploaded anything. No accounts, no API
// keys, no trusted set of host peers: it runs the same check a stranger would
// run and stores only what passes. That is the only design here that does not
// quietly introduce an authority, and it is available precisely because 0005 and
// 0006 made an archive checkable by somebody who was not there.
//
// The uploader is not identified, not signed, and not recorded, because nothing
// about who they are changes what the file proves.

import { gameIdOf } from "@tessera/protocol";
import { verifyArchive } from "@tessera/net";
import type { ArchivedGame, Verdict } from "@tessera/net";
import type { Blobs } from "./store.js";
import { contentHash } from "./store.js";

/** 64 MB, which is what the web client will accept on the way out
 *  (`ARCHIVE_CAP`), so it is the natural ceiling on the way in. */
export const ARCHIVE_CAP = 64_000_000;

/** How many games keep their blob. The row outlives it — a few hundred bytes
 *  against megabytes — and what that split buys is a table that can be
 *  recomputed over what is still here and a total that does not need its inputs
 *  back. The right number depends on what the window table is for. */
export const DEFAULT_KEEP = 500;

export type Status = "checking" | "held" | "refused";

export interface ArchiveRow {
  gameId: string;
  contentHash: string;
  format: number;
  /** How far this copy got. A claim until the replay confirms it, which is
   *  exactly why the dedupe gate cannot decide anything on its own. */
  steps: number;
  /** The archive's own claimed hash. */
  stateHash: string;
  winner: number | null;
  verdict: Verdict | null;
  bytes: number;
  status: Status;
  problems: string[];
  checkedAt: number | null;
  /** When the blob was dropped. The row is never dropped. */
  evictedAt: number | null;
}

export interface Corpus {
  rows: ArchiveRow[];
  next?: string;
}

/** The rows, and nothing about where the bytes are. */
export interface Archives {
  head(gameId: string): Promise<ArchiveRow | undefined>;
  put(row: ArchiveRow): Promise<void>;
  list(filter: { limit: number; cursor?: string; status?: Status }): Promise<Corpus>;
  /** Games whose blob is still held, oldest verdict first — what eviction walks. */
  evictable(keep: number): Promise<ArchiveRow[]>;
  /** Rows waiting on the queue, for picking work back up after a restart. */
  checking(): Promise<ArchiveRow[]>;
}

/** What `POST /archives` answers, before it is turned into a status code. */
export type Accepted =
  | { kind: "queued"; gameId: string }
  | { kind: "held"; gameId: string }
  | { kind: "refused"; gameId: string; problems: string[] }
  | { kind: "not an archive" };

export interface IngestOptions {
  archives: Archives;
  blobs: Blobs;
  keep?: number;
  now?: () => number;
  /** Reported rather than swallowed: a verification that threw is a bug in this
   *  service and not a verdict about somebody's file. */
  say?: (line: string) => void;
}

export class Ingest {
  private readonly archives: Archives;
  private readonly blobs: Blobs;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly say: (line: string) => void;
  /** One at a time, in order. A replay is CPU-bound and wholly synchronous
   *  inside `fastForward`, so running two would not make either finish sooner —
   *  it would only make the request thread wait behind both. */
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(options: IngestOptions) {
    this.archives = options.archives;
    this.blobs = options.blobs;
    this.keep = options.keep ?? DEFAULT_KEEP;
    this.now = options.now ?? (() => Date.now());
    this.say = options.say ?? (() => {});
  }

  /** How many games are queued or being replayed. For the health route, and for
   *  a test that wants to wait rather than sleep. */
  get pending(): number {
    return this.waiting;
  }

  /** Settles when the queue is empty. */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** The four gates, cheapest first.
   *
   *  The size gate is above this, in the router, because it has to bite while
   *  the body is arriving rather than after. */
  async accept(body: Buffer): Promise<Accepted> {
    let game: unknown;
    try {
      game = JSON.parse(body.toString("utf8"));
    } catch {
      return { kind: "not an archive" };
    }
    // Shape, and deliberately not verification. The web client keeps these
    // separate for the same reason: "this is not a saved game" and "this saved
    // game does not check out" are different sentences.
    if (!isArchive(game)) return { kind: "not an archive" };

    // The recomputed id, never the `gameId` field as posted. This is the whole
    // of the content addressing, and taking the claimed one would let anybody
    // file a game under somebody else's name.
    const gameId = await gameIdOf(game.genesis);
    const steps = whole(game.steps) ?? 0;

    // The cheap path, and the common one: two observers on one game is the
    // normal way to keep an archive safe rather than a corner case.
    //
    // A *longer* copy falls through to the replay. Two honest archives of one
    // game can cover different amounts of it — an observer that closed its
    // laptop at step 40,000 and one that ran to 120,000 both produce a
    // verifiable archive of the same game — and the longer one supersedes. That
    // is also why this gate cannot decide anything on its own: `steps` is a
    // claim until the replay confirms it.
    //
    // And an evicted game is recognised here rather than verified again, so
    // re-uploading one is a no-op and not a resurrection. Restoring the blob
    // would let anybody pin a game in the store forever by re-posting it, and
    // the retention would stop meaning anything.
    const already = await this.archives.head(gameId);
    if (already && steps <= already.steps) {
      if (already.status === "refused") {
        return { kind: "refused", gameId, problems: already.problems };
      }
      if (already.status === "checking") return { kind: "queued", gameId };
      return { kind: "held", gameId };
    }

    // A staging blob and a row saying so. `verifyArchive` replays the game —
    // `fastForward` advances once per step over the whole map at 12 steps a
    // second, so a ten-day game is on the order of ten million steps, plus one
    // ECDSA verify per move and per message. That cannot run on a request
    // thread, so the caller gets an id and polls.
    await this.blobs.put(gameId, body);
    await this.archives.put({
      gameId,
      contentHash: contentHash(body),
      format: whole(game.format) ?? 0,
      steps,
      stateHash: typeof game.hash === "string" ? game.hash : "",
      winner: null,
      verdict: null,
      bytes: body.byteLength,
      status: "checking",
      problems: [],
      checkedAt: null,
      evictedAt: null,
    });

    this.waiting++;
    this.queue = this.queue.then(() => this.check(gameId, game)).finally(() => {
      this.waiting--;
    });
    return { kind: "queued", gameId };
  }

  /** The replay, off the request thread. */
  private async check(gameId: string, game: ArchivedGame): Promise<void> {
    let verdict: Verdict;
    try {
      verdict = await verifyArchive(game);
    } catch (error) {
      this.say(`warning: verifying ${gameId} threw — ${(error as Error).message}`);
      return;
    }
    const row = await this.archives.head(gameId);
    if (!row) return;

    if (!verdict.ok) {
      // The blob goes; the row stays, saying why. The store holds verified
      // games, and a file that failed is a row saying so — which is what makes
      // a refusal auditable without making the store a dump.
      await this.blobs.remove(gameId);
      await this.archives.put({
        ...row,
        status: "refused",
        problems: verdict.problems,
        verdict,
        checkedAt: this.now(),
      });
      return;
    }

    await this.archives.put({
      ...row,
      status: "held",
      problems: [],
      verdict,
      // Both off the replay rather than off the file: `winner` is a result
      // nobody had the chance to assert, and `steps` was only a claim until now.
      winner: verdict.winner,
      steps: verdict.steps,
      checkedAt: this.now(),
    });
    await this.evict();
  }

  /** The blob is evicted and the row is not.
   *
   *  By `checkedAt` rather than by the game's own `startedAt`: a game uploaded
   *  late is new to this service whatever its age, and the store has no business
   *  deciding a game is uninteresting because it was played last year. */
  async evict(): Promise<number> {
    const over = await this.archives.evictable(this.keep);
    for (const row of over) {
      await this.blobs.remove(row.gameId);
      await this.archives.put({ ...row, evictedAt: this.now() });
    }
    return over.length;
  }

  /** The corpus. A plain index, and the thing that makes a hosted table
   *  checkable: anyone can fetch the same files and derive the same numbers. */
  async list(filter: { limit: number; cursor?: string; status?: Status }): Promise<Corpus> {
    return this.archives.list(filter);
  }

  /** One archive as it was posted, or why it cannot be had. */
  async read(
    gameId: string,
  ): Promise<
    | { kind: "held"; body: Buffer; tag: string }
    | { kind: "gone"; checkedAt: number | null }
    | { kind: "checking" }
    | { kind: "refused"; problems: string[] }
    | { kind: "unknown" }
  > {
    const row = await this.archives.head(gameId);
    if (!row) return { kind: "unknown" };
    if (row.status === "checking") return { kind: "checking" };
    if (row.status === "refused") return { kind: "refused", problems: row.problems };
    const body = await this.blobs.get(gameId);
    // A different thing from the 404 for a game never seen, and the distinction
    // matters to a reader deciding whether to look elsewhere.
    if (!body) return { kind: "gone", checkedAt: row.checkedAt };
    return { kind: "held", body, tag: `"${row.contentHash}"` };
  }
}

/** The shape check, and only the shape — `isArchive` in the web client, from
 *  the other side. */
export function isArchive(value: unknown): value is ArchivedGame {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<ArchivedGame>;
  if (!game.genesis || typeof game.genesis !== "object") return false;
  return Array.isArray(game.moveLog);
}

/** How a row is shown in the corpus. `verdict` is not here: it is a few
 *  kilobytes per game and the corpus is a page of a hundred. */
export const summarise = (
  row: ArchiveRow,
): {
  gameId: string;
  steps: number;
  winner: number | null;
  bytes: number;
  checkedAt: number | null;
  status: Status;
  held: boolean;
  problems?: string[];
} => ({
  gameId: row.gameId,
  steps: row.steps,
  winner: row.winner,
  bytes: row.bytes,
  checkedAt: row.checkedAt,
  status: row.status,
  held: row.status === "held" && row.evictedAt === null,
  // Refusals are listed with their reasons. A store that hid what it could not
  // check would be making the same mistake a leaderboard makes when it drops a
  // row silently.
  ...(row.problems.length > 0 ? { problems: row.problems } : {}),
});

const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
