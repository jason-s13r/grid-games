// An archive that survives the process.
//
// Append-only, because the alternative is rewriting a multi-day log every time
// somebody claims a tile. One line per record, flushed as it happens, so a
// power cut costs whatever was in the last write and not the game — and a
// half-written final line is dropped on read rather than poisoning everything
// before it.
//
// The directory is the archive. `genesis.json` is the record every hash derives
// from, `log.jsonl` is the inputs in the order they were applied, `head.json`
// says where the world had got to, and `snapshots/` is the checkpoints — kept
// because they are what lets a peer that has been away rejoin in a second
// rather than replaying three days of it.

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Archive, encodeSnapshot, decodeSnapshot } from "@tessera/net";
import type { ArchivedGame, ArchiveRecord, ArchiveSource, Checkpointed, SnapshotStore } from "@tessera/net";
import type { Genesis } from "@tessera/sim";
import { hex } from "@tessera/sim";

/** What `head.json` holds. Rewritten rather than appended, because it is the
 *  one part of an archive that is a fact about now instead of about the past. */
export interface ArchiveHead {
  format: number;
  gameId: string;
  /** The step the archive's log begins at. Zero when the peer was there from
   *  the start, which is the only case a log replays from genesis — and saying
   *  so is the difference between an honest partial archive and a mysterious
   *  hash mismatch. */
  from: number;
  steps: number;
  hash: string;
  updatedAt: number;
}

const HEAD = "head.json";
const LOG = "log.jsonl";
const GENESIS = "genesis.json";
const SNAPSHOTS = "snapshots";

/** How often the head and any new checkpoints are written. Records go to the
 *  log the moment they happen; this is only the summary catching up. */
const FLUSH_MS = 10_000;

export interface FileArchiveOptions {
  /** Where to write. One directory per game; the game id is the obvious name
   *  and what the observer uses. */
  dir: string;
  genesis: Genesis;
  source: ArchiveSource;
  /** The driver's checkpoints, polled on each flush. Omit to archive inputs
   *  only, which is enough to replay but not to resume. */
  snapshots?: SnapshotStore;
  flushMs?: number;
  /** The step the log starts at. Non-zero when the peer joined a game already
   *  in progress, which makes the archive a fragment and says so. */
  from?: number;
}

export class FileArchive {
  readonly archive: Archive;
  private readonly dir: string;
  /** Set on the first record rather than up front, because a peer does not know
   *  it arrived late until it sees which step it is being told about. */
  private from: number;
  private readonly snapshots?: SnapshotStore;
  private readonly written = new Set<number>();
  /** Serialised so two flushes cannot interleave their appends. Node's
   *  appendFile is not atomic across awaits, and a log whose lines are spliced
   *  together is a log nothing will parse. */
  private queue: Promise<void> = Promise.resolve();
  private pending: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private first = true;
  /** Resolved by open(). Records can start arriving the moment the driver does,
   *  which is before the directory they belong in exists. */
  private ready: Promise<void>;
  private laidOut = (): void => {};

  constructor(private readonly options: FileArchiveOptions) {
    this.dir = options.dir;
    this.from = options.from ?? 0;
    this.ready = new Promise<void>((done) => {
      this.laidOut = done;
    });
    if (options.snapshots) this.snapshots = options.snapshots;
    // The file is the archive: holding a three-day game in memory as well would
    // be paying twice for one copy.
    this.archive = new Archive(options.genesis, options.source, { retain: false });
    this.archive.onRecord = (record) => this.append(record);
  }

  /** Lay the directory out and write the record everything else refers to. */
  async open(): Promise<void> {
    await mkdir(join(this.dir, SNAPSHOTS), { recursive: true });
    await writeFile(join(this.dir, GENESIS), `${JSON.stringify(this.options.genesis)}\n`);
    this.laidOut();
    await this.flush();
    this.timer = setInterval(() => void this.flush(), this.options.flushMs ?? FLUSH_MS);
    this.timer.unref?.();
  }

  private append(record: ArchiveRecord): void {
    if (this.first) {
      this.first = false;
      // Where the log actually starts. A peer that joined an hour into a game
      // holds a fragment whatever it was told at construction, and the first
      // step it is asked to archive is the only honest answer to which.
      if (this.options.from === undefined) this.from = this.options.source.step;
    }
    this.pending.push(JSON.stringify(record));
    // A record every step would be a syscall every step. Batching to the next
    // turn of the loop costs nothing that a crash would not have cost anyway.
    if (this.pending.length === 1) queueMicrotask(() => void this.drain());
  }

  private drain(): Promise<void> {
    if (this.pending.length === 0) return this.queue;
    const lines = this.pending.splice(0, this.pending.length);
    this.queue = this.queue.then(() => this.ready).then(() =>
      appendFile(join(this.dir, LOG), `${lines.join("\n")}\n`).catch((error: Error) => {
        // An archive that cannot write is worth complaining about loudly and
        // once; it is not worth stopping a game over, because the game is
        // everybody else's and this peer is only watching it.
        console.error(`archive: ${error.message}`);
      }),
    );
    return this.queue;
  }

  /** Write the summary and any checkpoints not yet on disk. */
  async flush(): Promise<void> {
    await this.drain();

    for (const step of this.snapshots?.steps() ?? []) {
      if (this.written.has(step)) continue;
      const entry = this.snapshots?.get(step);
      if (!entry) continue;
      this.written.add(step);
      await this.writeSnapshot(entry);
    }

    const head: ArchiveHead = {
      format: 1,
      gameId: this.options.genesis.gameId ?? "",
      from: this.from,
      steps: this.archive.steps,
      hash: hex(this.options.source.hash()),
      updatedAt: Date.now(),
    };
    // Through a temp file: head.json is the one thing a reader trusts to be
    // whole, and a crash halfway through writing it would leave an archive that
    // parses as nothing at all.
    const path = join(this.dir, HEAD);
    await writeFile(`${path}.tmp`, `${JSON.stringify(head, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
  }

  private async writeSnapshot(entry: Checkpointed): Promise<void> {
    const name = `${String(entry.step).padStart(10, "0")}.${hex(entry.hash)}.snap`;
    await writeFile(join(this.dir, SNAPSHOTS, name), encodeSnapshot(entry.data));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

/** Read a directory back as one game.
 *
 *  Nothing here trusts the files: a truncated last line is dropped, an
 *  unparseable one is skipped, and what comes out goes to `verifyArchive` like
 *  any other archive — which is where being wrong is caught. */
export async function readArchive(dir: string): Promise<ArchivedGame & { from: number }> {
  const genesis = JSON.parse(await readFile(join(dir, GENESIS), "utf8")) as Genesis;
  const head = JSON.parse(await readFile(join(dir, HEAD), "utf8")) as ArchiveHead;
  const log = await readFile(join(dir, LOG), "utf8").catch(() => "");

  const game: ArchivedGame & { from: number } = {
    format: 1,
    genesis,
    moveLog: [],
    amendments: [],
    messages: [],
    from: head.from ?? 0,
    steps: head.steps ?? 0,
    hash: head.hash ?? "",
  };

  for (const line of log.split("\n")) {
    if (!line) continue;
    let record: ArchiveRecord;
    try {
      record = JSON.parse(line) as ArchiveRecord;
    } catch {
      continue; // a half-written final line, which is what a crash leaves
    }
    if (record.k === "move") game.moveLog.push(record.entry);
    else if (record.k === "amend") game.amendments.push(record.amendment);
    else if (record.k === "chat") game.messages.push(record.message);
  }

  return game;
}

/** The checkpoints on disk, newest first. */
export async function readSnapshots(dir: string): Promise<Checkpointed[]> {
  const names = await readdir(join(dir, SNAPSHOTS)).catch(() => [] as string[]);
  const found: Checkpointed[] = [];
  for (const name of names.sort().reverse()) {
    const [step, hash] = name.split(".");
    const data = decodeSnapshot(await readFile(join(dir, SNAPSHOTS, name), "utf8"));
    if (!data || step === undefined || hash === undefined) continue;
    found.push({ step: Number(step), hash: Number.parseInt(hash, 16), data });
  }
  return found;
}
