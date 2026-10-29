// A room's store in its Durable Object's SQLite database.
//
// Synchronous, as the room expects: the Durable Object SQL API runs in the same
// thread as the object, so a write is done when the call returns, and the
// runtime makes the object's writes durable before its output is sent.
//
// Every query here reads only the rows it returns, because SQLite storage is
// billed by rows read and written, rows scanned included. A game wakes this
// object thousands of times a day, so what one wake costs is what matters:
// one read of the small values, one of the snapshot, and the moves since it.
//
//   kv     small values, read once per wake and cached
//   moves  one row per stamp (every move the room stamped at one step), keyed
//          by (step, n) so a range of steps is a range of the primary key
//
// Both are WITHOUT ROWID: the key is the table, so a write is one row rather
// than a row and an index entry.

import type { RoomStore, Stamped, StoredSnapshot } from "@tessera/room";

const SCHEMA = 2;

/** Rows read and written since this object woke, for /api/games/:id. */
export interface StoreUsage {
  rowsRead: number;
  rowsWritten: number;
  since: number;
}

export class SqlStore implements RoomStore {
  private readonly cache = new Map<string, string>();
  /** The last stamp's step and number within it, for the next key. */
  private last: { step: number; n: number } | undefined;
  readonly usage: StoreUsage = { rowsRead: 0, rowsWritten: 0, since: Date.now() };

  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    storage.transactionSync(() => this.migrate());
    for (const row of this.exec<{ key: string; value: string }>(`SELECT key, value FROM kv`)) {
      this.cache.set(row.key, row.value);
    }
    const last = this.exec<{ step: number; n: number }>(`SELECT step, n FROM moves ORDER BY step DESC, n DESC LIMIT 1`)[0];
    if (last) this.last = { step: last.step, n: last.n };
  }

  get<T>(key: string): T | undefined {
    const text = this.cache.get(key);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  put(key: string, value: unknown): void {
    if (value === undefined) {
      if (!this.cache.delete(key)) return;
      this.exec(`DELETE FROM kv WHERE key = ?`, key);
      return;
    }
    const text = JSON.stringify(value);
    // Unchanged values are common (a name said again on reconnect) and free.
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    this.exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, text);
  }

  append(moves: readonly Stamped[]): void {
    // The room stamps everything in one call at one step; one row holds it.
    const byStep = new Map<number, Stamped[]>();
    for (const stamped of moves) {
      const list = byStep.get(stamped.move.step);
      if (list) list.push(stamped);
      else byStep.set(stamped.move.step, [stamped]);
    }
    for (const [step, list] of byStep) {
      const n = this.last && this.last.step === step ? this.last.n + 1 : 0;
      this.exec(`INSERT INTO moves (step, n, data) VALUES (?, ?, ?)`, step, n, JSON.stringify(list));
      this.last = { step, n };
    }
  }

  movesFrom(step: number): Stamped[] {
    // A migrated room's log before the migration is in moves_v1. Only an
    // archive asks for that far back.
    const migrated = this.get<number>("migratedFrom");
    const older =
      migrated !== undefined && step < migrated
        ? this.exec<{ data: string }>(
            `SELECT data FROM moves_v1 WHERE step >= ? AND step < ? ORDER BY step, id`,
            step,
            migrated,
          ).map((row) => JSON.parse(row.data) as Stamped)
        : [];
    const newer = this.exec<{ data: string }>(`SELECT data FROM moves WHERE step >= ? ORDER BY step, n`, step).flatMap(
      (row) => JSON.parse(row.data) as Stamped[],
    );
    return older.concat(newer);
  }

  lastStep(): number {
    return this.last?.step ?? 0;
  }

  putSnapshot(snapshot: StoredSnapshot): void {
    this.exec(
      `INSERT OR REPLACE INTO snapshot (id, step, hash, bytes) VALUES (1, ?, ?, ?)`,
      snapshot.step,
      snapshot.hash,
      snapshot.bytes.slice().buffer,
    );
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const row = this.exec<{ step: number; hash: number; bytes: ArrayBuffer }>(
      `SELECT step, hash, bytes FROM snapshot WHERE id = 1`,
    )[0];
    return row ? { step: row.step, hash: row.hash, bytes: new Uint8Array(row.bytes) } : undefined;
  }

  private exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.usage.rowsRead += cursor.rowsRead;
    this.usage.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  /** Bring the tables to the current layout. A room made before it had a kv
   *  and a moves table with rowids, and a moves query that walked the whole
   *  log on every wake; the old log is kept as moves_v1 for the archive, and
   *  only the part still needed (from the snapshot on) is copied across. */
  private migrate(): void {
    // One row on every wake, rather than a look at the schema table.
    let version: number | undefined;
    try {
      version = Number(this.exec<{ value: string }>(`SELECT value FROM kv WHERE key = 'schema'`)[0]?.value ?? 1);
    } catch {
      // No kv table: a new room.
    }
    if (version === undefined) {
      this.createTables();
      this.exec(`INSERT INTO kv2 (key, value) VALUES ('schema', ?)`, String(SCHEMA));
      this.exec(`ALTER TABLE kv2 RENAME TO kv`);
      return;
    }
    if (version >= SCHEMA) return;

    this.createTables();
    this.exec(`INSERT INTO kv2 (key, value) SELECT key, value FROM kv`);
    this.exec(`INSERT OR REPLACE INTO kv2 (key, value) VALUES ('schema', ?)`, String(SCHEMA));
    this.exec(`DROP TABLE kv`);
    this.exec(`ALTER TABLE kv2 RENAME TO kv`);

    this.exec(`ALTER TABLE moves RENAME TO moves_v1`);
    const from = this.exec<{ step: number }>(`SELECT step FROM snapshot WHERE id = 1`)[0]?.step ?? 0;
    this.exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('migratedFrom', ?)`, String(from));
    // Through the old step index, so this reads the tail and not the log.
    const tail = this.exec<{ data: string }>(
      `SELECT data FROM moves_v1 WHERE step >= ? ORDER BY step, id`,
      from,
    ).map((row) => JSON.parse(row.data) as Stamped);
    this.exec(`CREATE TABLE moves (step INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (step, n)) WITHOUT ROWID`);
    this.append(tail);
  }

  private createTables(): void {
    this.exec(`CREATE TABLE kv2 (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
    this.exec(
      `CREATE TABLE IF NOT EXISTS moves (step INTEGER NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (step, n)) WITHOUT ROWID`,
    );
    this.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), step INTEGER NOT NULL, hash INTEGER NOT NULL, bytes BLOB NOT NULL)`,
    );
  }
}
