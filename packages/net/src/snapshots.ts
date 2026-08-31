// Checkpoints, content-addressed by their state hash.
//
// The hash is the proof, so a snapshot from an untrusted peer is safe to
// accept: restore it, hash it, and discard it if the number disagrees with the
// one the mesh already agreed on. That single property is what lets an archive
// peer exist without ever becoming an authority — and what lets a player who
// closed the tab three hours ago rejoin from whoever happens to be online.

import { fromBase64Url, toBase64Url } from "@tessera/protocol";

export interface Checkpointed {
  step: number;
  hash: number;
  data: ArrayBuffer;
}

export class SnapshotStore {
  private readonly kept = new Map<number, Checkpointed>();

  /** Snapshots are megabytes on a large map, so the store is a short tail
   *  rather than a history. Anything older is reconstructed by replaying the
   *  move log, which is what the log is for. */
  constructor(private readonly keep = 8) {}

  put(entry: Checkpointed): void {
    this.kept.set(entry.step, entry);
    if (this.kept.size <= this.keep) return;
    const oldest = Math.min(...this.kept.keys());
    this.kept.delete(oldest);
  }

  get(step: number): Checkpointed | undefined {
    return this.kept.get(step);
  }

  /** The most recent snapshot at or before `step`. */
  at(step: number): Checkpointed | undefined {
    let best: Checkpointed | undefined;
    for (const entry of this.kept.values()) {
      if (entry.step <= step && (!best || entry.step > best.step)) best = entry;
    }
    return best;
  }

  latest(): Checkpointed | undefined {
    return this.at(Number.MAX_SAFE_INTEGER);
  }

  steps(): number[] {
    return [...this.kept.keys()].sort((a, b) => a - b);
  }

  get size(): number {
    return this.kept.size;
  }
}

/** base64url is a placeholder for JSON framing. A real data channel should
 *  carry the buffer as binary; the cost here is a third more bytes on a message
 *  that is already the largest thing the mesh ever sends. */
export function encodeSnapshot(data: ArrayBuffer): string {
  return toBase64Url(new Uint8Array(data));
}

export function decodeSnapshot(text: string): ArrayBuffer | null {
  const bytes = fromBase64Url(text);
  if (!bytes) return null;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
