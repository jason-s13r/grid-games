// Storage, and the one table this app needs so far.
//
// `listing` is stored **whole and unaltered**: not normalised into columns, not
// re-serialised through a schema, not stripped of fields this build does not
// recognise. A row posted by a newer client carrying a field 0015 never heard of
// is a row that must survive to reach a reader who has. Storing the document and
// indexing beside it is the only shape with that property, and three columns are
// lifted out because the service genuinely needs them — the key to upsert on,
// the owner to check a write against, and the expiry to sweep on.
//
// `MemoryStore` is not a test double for something it approximates. It is the
// same interface, and the router is exercised against it so the HTTP contract is
// testable without a database; `PostgresStore` is what an operator runs.

// `pg` is CommonJS and its entry point is `module.exports = new PG(Client)` —
// an instance, so Node's ESM loader cannot see named exports on it and
// `import { Pool }` throws at startup even though the bundler-mode typechecker
// and vitest's interop both accept it. The default import is the module object.
import pg from "pg";
import type { Pool } from "pg";

import type { Row, Store } from "./board.js";
import type { ArchiveRow, Archives, Corpus, Status } from "./ingest.js";
import type { Applied, AppliedStore } from "./rank.js";

const { Pool: PgPool } = pg;

export const SCHEMA = `
create table if not exists rows (
  game_id     text        not null,
  ref         text        not null,
  owner       text        not null,
  listing     jsonb       not null,
  expires_at  timestamptz not null,
  updated_at  timestamptz not null,
  primary key (game_id, ref)
);
create index if not exists rows_expiry on rows (expires_at);
create index if not exists rows_owner on rows (owner);

create table if not exists archives (
  game_id      text        primary key,
  content_hash text        not null,
  format       integer     not null,
  steps        bigint      not null,
  state_hash   text        not null,
  winner       integer,
  verdict      jsonb,
  bytes        bigint      not null,
  status       text        not null,
  problems     jsonb       not null default '[]',
  checked_at   timestamptz,
  evicted_at   timestamptz
);
create index if not exists archives_checked on archives (checked_at desc);
create index if not exists archives_status on archives (status);

create table if not exists applied (
  game_id      text        primary key,
  steps        bigint      not null,
  contribution jsonb       not null,
  applied_at   timestamptz not null
);
create index if not exists applied_at on applied (applied_at);
`;

export class PostgresStore implements Store {
  constructor(readonly pool: Pool) {}

  static open(url: string): PostgresStore {
    return new PostgresStore(new PgPool({ connectionString: url }));
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async owners(gameId: string, refs: readonly string[], now: number): Promise<Map<string, string>> {
    const found = await this.pool.query<{ ref: string; owner: string }>(
      `select ref, owner from rows where game_id = $1 and ref = any($2) and expires_at > $3`,
      [gameId, [...refs], new Date(now)],
    );
    return new Map(found.rows.map((row) => [row.ref, row.owner]));
  }

  async upsert(rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) return;
    // One statement for the whole fan-out, so N refs from one POST land or fail
    // together rather than leaving a game half-announced.
    const values = rows
      .map((_, index) => {
        const at = index * 6;
        return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6})`;
      })
      .join(", ");
    const params = rows.flatMap((row) => [
      row.gameId,
      row.ref,
      row.owner,
      JSON.stringify(row.listing),
      new Date(row.expiresAt),
      new Date(row.updatedAt),
    ]);
    await this.pool.query(
      `insert into rows (game_id, ref, owner, listing, expires_at, updated_at)
       values ${values}
       on conflict (game_id, ref) do update set
         owner = excluded.owner,
         listing = excluded.listing,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      params,
    );
  }

  async remove(gameId: string, refs: readonly string[], owner: string): Promise<void> {
    await this.pool.query(`delete from rows where game_id = $1 and ref = any($2) and owner = $3`, [
      gameId,
      [...refs],
      owner,
    ]);
  }

  async list(limit: number, now: number): Promise<Row[]> {
    const found = await this.pool.query<Stored>(
      `select game_id, ref, owner, listing, expires_at, updated_at from rows
       where expires_at > $1 order by updated_at desc limit $2`,
      [new Date(now), limit],
    );
    return found.rows.map(asRow);
  }

  async forGame(gameId: string, now: number): Promise<Row[]> {
    const found = await this.pool.query<Stored>(
      `select game_id, ref, owner, listing, expires_at, updated_at from rows
       where game_id = $1 and expires_at > $2 order by updated_at desc`,
      [gameId, new Date(now)],
    );
    return found.rows.map(asRow);
  }

  async counts(
    owner: string,
    gameId: string,
    now: number,
  ): Promise<{ byOwner: number; byGame: number }> {
    const found = await this.pool.query<{ by_owner: string; by_game: string }>(
      `select
         count(*) filter (where owner = $1)   as by_owner,
         count(*) filter (where game_id = $2) as by_game
       from rows where expires_at > $3`,
      [owner, gameId, new Date(now)],
    );
    return {
      byOwner: Number(found.rows[0]?.by_owner ?? 0),
      byGame: Number(found.rows[0]?.by_game ?? 0),
    };
  }

  async sweep(now: number): Promise<number> {
    const done = await this.pool.query(`delete from rows where expires_at <= $1`, [new Date(now)]);
    return done.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Keyed on the pair, serialised rather than concatenated: a ref is a URL and
 *  can hold very nearly anything, and a separator that can appear inside a key
 *  is a collision waiting to be found. */
export class MemoryStore implements Store {
  private readonly rows = new Map<string, Row>();

  async owners(gameId: string, refs: readonly string[], now: number): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const ref of refs) {
      const row = this.rows.get(key(gameId, ref));
      if (row && row.expiresAt > now) found.set(ref, row.owner);
    }
    return found;
  }

  async upsert(rows: readonly Row[]): Promise<void> {
    for (const row of rows) this.rows.set(key(row.gameId, row.ref), row);
  }

  async remove(gameId: string, refs: readonly string[], owner: string): Promise<void> {
    for (const ref of refs) {
      const at = key(gameId, ref);
      if (this.rows.get(at)?.owner === owner) this.rows.delete(at);
    }
  }

  async list(limit: number, now: number): Promise<Row[]> {
    return this.live(now)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async forGame(gameId: string, now: number): Promise<Row[]> {
    return this.live(now)
      .filter((row) => row.gameId === gameId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async counts(
    owner: string,
    gameId: string,
    now: number,
  ): Promise<{ byOwner: number; byGame: number }> {
    const live = this.live(now);
    return {
      byOwner: live.filter((row) => row.owner === owner).length,
      byGame: live.filter((row) => row.gameId === gameId).length,
    };
  }

  async sweep(now: number): Promise<number> {
    let gone = 0;
    for (const [at, row] of this.rows) {
      if (row.expiresAt <= now) {
        this.rows.delete(at);
        gone++;
      }
    }
    return gone;
  }

  private live(now: number): Row[] {
    return [...this.rows.values()].filter((row) => row.expiresAt > now);
  }
}

const key = (gameId: string, ref: string): string => JSON.stringify([gameId, ref]);

interface Stored {
  game_id: string;
  ref: string;
  owner: string;
  listing: Row["listing"];
  expires_at: Date;
  updated_at: Date;
}

const asRow = (record: Stored): Row => ({
  gameId: record.game_id,
  ref: record.ref,
  owner: record.owner,
  // `jsonb` comes back parsed, and it comes back as it went in. Nothing here
  // reaches into it.
  listing: record.listing,
  expiresAt: record.expires_at.getTime(),
  updatedAt: record.updated_at.getTime(),
});

/** The corpus, in the same two shapes the board's rows come in.
 *
 *  `evictable` is the whole of retention: the blob goes and the row stays. A row
 *  is a few hundred bytes against megabytes, and that split is what lets a table
 *  be recomputed over what is still held while a total keeps a contribution from
 *  a game whose file is long gone. */
export class PostgresArchives implements Archives {
  constructor(private readonly pool: Pool) {}

  async head(gameId: string): Promise<ArchiveRow | undefined> {
    const found = await this.pool.query<Kept>(`${SELECT} where game_id = $1`, [gameId]);
    return found.rows[0] ? asArchive(found.rows[0]) : undefined;
  }

  async put(row: ArchiveRow): Promise<void> {
    await this.pool.query(
      `insert into archives
         (game_id, content_hash, format, steps, state_hash, winner, verdict, bytes,
          status, problems, checked_at, evicted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (game_id) do update set
         content_hash = excluded.content_hash,
         format = excluded.format,
         steps = excluded.steps,
         state_hash = excluded.state_hash,
         winner = excluded.winner,
         verdict = excluded.verdict,
         bytes = excluded.bytes,
         status = excluded.status,
         problems = excluded.problems,
         checked_at = excluded.checked_at,
         evicted_at = excluded.evicted_at`,
      [
        row.gameId,
        row.contentHash,
        row.format,
        row.steps,
        row.stateHash,
        row.winner,
        row.verdict === null ? null : JSON.stringify(row.verdict),
        row.bytes,
        row.status,
        JSON.stringify(row.problems),
        row.checkedAt === null ? null : new Date(row.checkedAt),
        row.evictedAt === null ? null : new Date(row.evictedAt),
      ],
    );
  }

  async list(filter: { limit: number; cursor?: string; status?: Status }): Promise<Corpus> {
    // Keyset rather than offset: the corpus grows at the head, and an offset
    // page would repeat or skip a row every time something was ingested
    // mid-read. One row over the limit is fetched to decide whether to hand
    // back a cursor at all.
    const where = ["true"];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.cursor) {
      params.push(filter.cursor);
      where.push(`game_id > $${params.length}`);
    }
    params.push(filter.limit + 1);
    const found = await this.pool.query<Kept>(
      `${SELECT} where ${where.join(" and ")} order by game_id asc limit $${params.length}`,
      params,
    );
    const rows = found.rows.slice(0, filter.limit).map(asArchive);
    const more = found.rows.length > filter.limit;
    return { rows, ...(more && rows.length > 0 ? { next: rows[rows.length - 1]!.gameId } : {}) };
  }

  async evictable(keep: number): Promise<ArchiveRow[]> {
    const found = await this.pool.query<Kept>(
      `${SELECT} where status = 'held' and evicted_at is null
       order by checked_at desc offset $1`,
      [keep],
    );
    return found.rows.map(asArchive);
  }

  async checking(): Promise<ArchiveRow[]> {
    const found = await this.pool.query<Kept>(`${SELECT} where status = 'checking'`);
    return found.rows.map(asArchive);
  }
}

export class MemoryArchives implements Archives {
  private readonly kept = new Map<string, ArchiveRow>();

  async head(gameId: string): Promise<ArchiveRow | undefined> {
    return this.kept.get(gameId);
  }

  async put(row: ArchiveRow): Promise<void> {
    this.kept.set(row.gameId, row);
  }

  async list(filter: { limit: number; cursor?: string; status?: Status }): Promise<Corpus> {
    const all = [...this.kept.values()]
      .filter((row) => (filter.status ? row.status === filter.status : true))
      .filter((row) => (filter.cursor ? row.gameId > filter.cursor : true))
      .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0));
    const rows = all.slice(0, filter.limit);
    const more = all.length > filter.limit;
    return { rows, ...(more && rows.length > 0 ? { next: rows[rows.length - 1]!.gameId } : {}) };
  }

  async evictable(keep: number): Promise<ArchiveRow[]> {
    return [...this.kept.values()]
      .filter((row) => row.status === "held" && row.evictedAt === null)
      .sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))
      .slice(keep);
  }

  async checking(): Promise<ArchiveRow[]> {
    return [...this.kept.values()].filter((row) => row.status === "checking");
  }
}

const SELECT = `select game_id, content_hash, format, steps, state_hash, winner, verdict,
                       bytes, status, problems, checked_at, evicted_at from archives`;

interface Kept {
  game_id: string;
  content_hash: string;
  format: number;
  steps: string;
  state_hash: string;
  winner: number | null;
  verdict: ArchiveRow["verdict"];
  bytes: string;
  status: Status;
  problems: string[];
  checked_at: Date | null;
  evicted_at: Date | null;
}

/** `bigint` comes back as a string, because it does not fit a double in
 *  general. A step count does, and a byte count does, so both are narrowed
 *  here rather than carried as strings through the rest of the service. */
const asArchive = (kept: Kept): ArchiveRow => ({
  gameId: kept.game_id,
  contentHash: kept.content_hash,
  format: kept.format,
  steps: Number(kept.steps),
  stateHash: kept.state_hash,
  winner: kept.winner,
  verdict: kept.verdict,
  bytes: Number(kept.bytes),
  status: kept.status,
  problems: kept.problems ?? [],
  checkedAt: kept.checked_at?.getTime() ?? null,
  evictedAt: kept.evicted_at?.getTime() ?? null,
});


/** Every game ever counted, with what it contributed.
 *
 *  Keyed on the game id and never on a hash of the file: two observers archiving
 *  one game produce two different files that both verify and describe the same
 *  game, and keyed on bytes they would be two rows and a doubled `games` for
 *  every key in that game.
 *
 *  Kept forever, because it is what makes the all-time table auditable at all —
 *  the totals are a pure function of this list, published at
 *  `GET /rankings/applied`, so an arithmetic error is visible to anybody without
 *  holding a single archive. It is also the only repair path: a bug that gets
 *  into a total is fixed by refolding this from the beginning, which works
 *  exactly as long as `contribution` was stored correctly and not at all if the
 *  bug was in what was stored. */
export class PostgresApplied implements AppliedStore {
  constructor(private readonly pool: Pool) {}

  async put(row: Applied): Promise<void> {
    await this.pool.query(
      `insert into applied (game_id, steps, contribution, applied_at)
       values ($1, $2, $3, $4)
       on conflict (game_id) do update set
         steps = excluded.steps,
         contribution = excluded.contribution,
         applied_at = excluded.applied_at`,
      [row.gameId, row.steps, JSON.stringify(row.contribution), new Date(row.appliedAt)],
    );
  }

  async get(gameId: string): Promise<Applied | undefined> {
    const found = await this.pool.query<Contribution>(
      `select game_id, steps, contribution, applied_at from applied where game_id = $1`,
      [gameId],
    );
    return found.rows[0] ? asApplied(found.rows[0]) : undefined;
  }

  async all(): Promise<Applied[]> {
    const found = await this.pool.query<Contribution>(
      `select game_id, steps, contribution, applied_at from applied order by applied_at asc`,
    );
    return found.rows.map(asApplied);
  }

  async page(limit: number, cursor?: string): Promise<{ rows: Applied[]; next?: string }> {
    const params: unknown[] = [];
    let where = "true";
    if (cursor) {
      params.push(cursor);
      where = `game_id > $${params.length}`;
    }
    params.push(limit + 1);
    const found = await this.pool.query<Contribution>(
      `select game_id, steps, contribution, applied_at from applied
       where ${where} order by game_id asc limit $${params.length}`,
      params,
    );
    const rows = found.rows.slice(0, limit).map(asApplied);
    const more = found.rows.length > limit;
    return { rows, ...(more && rows.length > 0 ? { next: rows[rows.length - 1]!.gameId } : {}) };
  }

  async since(): Promise<number | null> {
    const found = await this.pool.query<{ first: Date | null }>(
      `select min(applied_at) as first from applied`,
    );
    return found.rows[0]?.first?.getTime() ?? null;
  }
}

interface Contribution {
  game_id: string;
  steps: string;
  contribution: Applied["contribution"];
  applied_at: Date;
}

const asApplied = (row: Contribution): Applied => ({
  gameId: row.game_id,
  steps: Number(row.steps),
  contribution: row.contribution,
  appliedAt: row.applied_at.getTime(),
});
