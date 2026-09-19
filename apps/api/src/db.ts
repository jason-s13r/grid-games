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

import { Pool } from "pg";
import type { Row, Store } from "./board.js";

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
`;

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}

  static open(url: string): PostgresStore {
    return new PostgresStore(new Pool({ connectionString: url }));
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
