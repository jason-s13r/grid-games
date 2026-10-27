// Where a room keeps what it must not forget.
//
// Synchronous on purpose: a Durable Object's SQLite storage is synchronous, and
// a room that awaited its own writes would interleave two clients' moves at
// every await. The in-memory store here backs the tests and a host tab.

import type { Stamped } from "./messages.js";

export interface StoredSnapshot {
  step: number;
  hash: number;
  bytes: Uint8Array;
}

export interface RoomStore {
  /** Small values: configuration, genesis, lobby, sequence counters. */
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  /** Append moves to the log, in order. */
  append(moves: readonly Stamped[]): void;
  /** Every logged move at or after `step`, in log order. */
  movesFrom(step: number): Stamped[];
  /** Keep a snapshot, replacing any older one. */
  putSnapshot(snapshot: StoredSnapshot): void;
  latestSnapshot(): StoredSnapshot | undefined;
}

export class MemoryStore implements RoomStore {
  private readonly values = new Map<string, string>();
  private readonly log: Stamped[] = [];
  private snapshot: StoredSnapshot | undefined;

  get<T>(key: string): T | undefined {
    const text = this.values.get(key);
    // Through JSON, so a caller cannot rely on sharing an object with the store,
    // which the SQLite-backed store could not offer.
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  put(key: string, value: unknown): void {
    this.values.set(key, JSON.stringify(value));
  }

  append(moves: readonly Stamped[]): void {
    for (const move of moves) this.log.push(JSON.parse(JSON.stringify(move)) as Stamped);
  }

  movesFrom(step: number): Stamped[] {
    return this.log.filter((entry) => entry.move.step >= step);
  }

  putSnapshot(snapshot: StoredSnapshot): void {
    this.snapshot = { ...snapshot, bytes: snapshot.bytes.slice() };
  }

  latestSnapshot(): StoredSnapshot | undefined {
    return this.snapshot && { ...this.snapshot, bytes: this.snapshot.bytes.slice() };
  }
}
