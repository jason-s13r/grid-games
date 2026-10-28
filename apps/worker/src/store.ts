// A room's store in its Durable Object's SQLite database.
//
// Synchronous, as the room expects: the Durable Object SQL API runs in the same
// thread as the object, so a write is done when the call returns, and the
// runtime makes the object's writes durable before its output is sent.

import type { RoomStore, Stamped, StoredSnapshot } from "@tessera/room";

export class SqlStore implements RoomStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS moves (id INTEGER PRIMARY KEY AUTOINCREMENT, step INTEGER NOT NULL, data TEXT NOT NULL)`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS moves_by_step ON moves (step)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), step INTEGER NOT NULL, hash INTEGER NOT NULL, bytes BLOB NOT NULL)`,
    );
  }

  get<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  put(key: string, value: unknown): void {
    if (value === undefined) {
      this.sql.exec(`DELETE FROM kv WHERE key = ?`, key);
      return;
    }
    this.sql.exec(
      `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value),
    );
  }

  append(moves: readonly Stamped[]): void {
    for (const stamped of moves) {
      this.sql.exec(`INSERT INTO moves (step, data) VALUES (?, ?)`, stamped.move.step, JSON.stringify(stamped));
    }
  }

  movesFrom(step: number): Stamped[] {
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM moves WHERE step >= ? ORDER BY id`, step)
      .toArray()
      .map((row) => JSON.parse(row.data) as Stamped);
  }

  putSnapshot(snapshot: StoredSnapshot): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO snapshot (id, step, hash, bytes) VALUES (1, ?, ?, ?)`,
      snapshot.step,
      snapshot.hash,
      snapshot.bytes.slice().buffer,
    );
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const row = this.sql
      .exec<{ step: number; hash: number; bytes: ArrayBuffer }>(`SELECT step, hash, bytes FROM snapshot WHERE id = 1`)
      .toArray()[0];
    return row ? { step: row.step, hash: row.hash, bytes: new Uint8Array(row.bytes) } : undefined;
  }
}
