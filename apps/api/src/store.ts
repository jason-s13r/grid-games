// Where the bytes go, and why the key is not a decision.
//
// `genesis.gameId` is a SHA-256 over the canonical record, so **the content
// address is the key**. A second upload of a game already held is a no-op rather
// than a duplicate, and the store cannot hold two different files under one id
// without one of them failing verification. Content addressing hands this its
// storage design for free and it is worth saying out loud rather than
// discovering.
//
// Bytes in, bytes out. An archive is not re-serialised, not key-sorted, and not
// stripped of fields this build does not recognise. The `hash` in the file is
// over the replay rather than over the JSON, so re-serialising would not break
// verification — which is exactly why the discipline has to be stated rather
// than left to whoever edits this next.
//
// Three methods, injected, so the routes above have no opinion about where a
// blob lives. `FileBlobs` is a directory and a volume; an S3-compatible backend
// is a fourth implementation of the same interface and nothing above it changes.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Blobs {
  put(gameId: string, body: Buffer): Promise<void>;
  get(gameId: string): Promise<Buffer | null>;
  remove(gameId: string): Promise<void>;
}

/** A directory. Written through a temp file and renamed, because a crash
 *  halfway through writing one would leave a file that parses as nothing and a
 *  row saying it verified. */
export class FileBlobs implements Blobs {
  constructor(private readonly dir: string) {}

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async put(gameId: string, body: Buffer): Promise<void> {
    const path = this.pathOf(gameId);
    await writeFile(`${path}.tmp`, body);
    await rename(`${path}.tmp`, path);
  }

  async get(gameId: string): Promise<Buffer | null> {
    return readFile(this.pathOf(gameId)).catch(() => null);
  }

  async remove(gameId: string): Promise<void> {
    await rm(this.pathOf(gameId), { force: true });
  }

  /** A game id is base64url of a SHA-256 and so can carry a `/`, which is a
   *  path separator in the one component of this service that takes a string
   *  from a stranger. Hex of the id is not reversible to a filename problem. */
  private pathOf(gameId: string): string {
    return join(this.dir, `${createHash("sha256").update(gameId).digest("hex")}.json`);
  }
}

export class MemoryBlobs implements Blobs {
  private readonly held = new Map<string, Buffer>();

  async put(gameId: string, body: Buffer): Promise<void> {
    this.held.set(gameId, body);
  }

  async get(gameId: string): Promise<Buffer | null> {
    return this.held.get(gameId) ?? null;
  }

  async remove(gameId: string): Promise<void> {
    this.held.delete(gameId);
  }
}

/** The ETag, and the row's `content_hash`.
 *
 *  A stored archive is immutable once verified, so this is a tag that is correct
 *  forever. `apps/host` tags `GET /room/:code/archive` on `room.status().step` —
 *  the driver's current step, moving twelve times a second — so for a running
 *  game that tag never repeats, the cache in front of it never hits, and every
 *  request re-reads the directory and re-stringifies megabytes. */
export const contentHash = (body: Buffer): string =>
  createHash("sha256").update(body).digest("hex");
