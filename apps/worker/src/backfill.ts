// Gives finished games archived without a timeline the one their room would
// have kept, once, in the background.
//
// Rooms keep a timeline of the map from worker 0.8.0 (see frames.ts in the
// room). Games archived before that have none, and when the sim that played a
// game is retired, its timeline is the only way left to watch it. So this
// replays each such archive and writes it back with its timeline, while the
// Worker still plays its version.
//
// One object, addressed by name. The open games list kicks it (see index.ts),
// and it works through the archives on its alarm: a game hour of replay per
// wake, the allowance a room takes to catch up (MAX_ADVANCE), with the sim's
// snapshot and the frames so far kept in its storage between wakes, so a
// ten-day game is done in a few hundred wakes and nothing is lost if it is
// evicted. When every finished game has a timeline, or cannot be given one,
// it says so in its storage and does nothing again.

import { DurableObject } from "cloudflare:workers";
import { Sim, hex, playsProtocol } from "@tessera/sim";
import type { Move } from "@tessera/sim";
import { FRAME_WIDTH, MAX_ADVANCE, chainFrame, frameDue, frameEvery, thumbnail, timelineFrom } from "@tessera/room";
import type { FrameChain, GameArchive } from "@tessera/room";
import { toBase64Url } from "@tessera/protocol";
import { readArchive, writeArchive } from "./archive.js";
import type { Env } from "./env.js";

/** The game being worked on, between wakes. */
interface Work {
  roomId: string;
  step: number;
  sinceKey: number;
}

export class Backfill extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS frames (step INTEGER PRIMARY KEY, bytes BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS done (room_id TEXT PRIMARY KEY, note TEXT NOT NULL)`);
  }

  /** Start, unless it is running or finished. Cheap enough to ask on every
   *  open list. */
  async kick(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("finished")) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** What it has done, for whoever asks. */
  async report(): Promise<{ finished: boolean; working?: Work; done: Array<{ roomId: string; note: string }> }> {
    const done = this.sql
      .exec<{ room_id: string; note: string }>(`SELECT room_id, note FROM done ORDER BY room_id`)
      .toArray()
      .map((row) => ({ roomId: row.room_id, note: row.note }));
    return {
      finished: (await this.ctx.storage.get<boolean>("finished")) ?? false,
      working: await this.ctx.storage.get<Work>("work"),
      done,
    };
  }

  override async alarm(): Promise<void> {
    const { DB, ARCHIVE } = this.env;
    if (!DB || !ARCHIVE) return;
    let work = await this.ctx.storage.get<Work>("work");

    if (!work) {
      const next = await this.nextGame(DB, ARCHIVE);
      if (!next) {
        await this.ctx.storage.put("finished", true);
        return;
      }
      work = { roomId: next, step: 0, sinceKey: 0 };
      this.sql.exec(`DELETE FROM frames`);
      await this.ctx.storage.delete(["snapshot", "cells"]);
      await this.ctx.storage.put("work", work);
    }

    const archive = await readArchive(ARCHIVE, work.roomId);
    if (!archive) return this.finishGame(work.roomId, "no archive");
    const outcome = await this.advance(work, archive);
    if (outcome === "more") await this.ctx.storage.setAlarm(Date.now());
    else await this.finishGame(work.roomId, outcome);
  }

  /** The next finished game with an archive to look at, or none. */
  private async nextGame(db: D1Database, bucket: R2Bucket): Promise<string | undefined> {
    const { results } = await db
      .prepare(`SELECT id FROM games WHERE phase = 'ended' ORDER BY ended_at`)
      .all<{ id: string }>();
    for (const { id } of results) {
      if (this.sql.exec(`SELECT 1 FROM done WHERE room_id = ?`, id).toArray().length) continue;
      const archive = await readArchive(bucket, id);
      const note = !archive
        ? "no archive"
        : archive.timeline
          ? "had a timeline"
          : !playsProtocol(archive.genesis.protocol)
            ? `v${archive.genesis.protocol}, no longer played`
            : undefined;
      if (note) {
        this.sql.exec(`INSERT OR REPLACE INTO done (room_id, note) VALUES (?, ?)`, id, note);
        continue;
      }
      return id;
    }
    return undefined;
  }

  /** A game hour of replay, taking frames on the way; at the end, the
   *  timeline written into the archive. */
  private async advance(work: Work, archive: GameArchive): Promise<"more" | string> {
    const { genesis } = archive;
    const sim = new Sim(genesis);
    const snapshot = await this.ctx.storage.get<ArrayBuffer>("snapshot");
    if (snapshot) sim.restore(snapshot);
    const cellsKept = await this.ctx.storage.get<ArrayBuffer>("cells");
    let chain: FrameChain | undefined = cellsKept ? { cells: new Uint8Array(cellsKept), sinceKey: work.sinceKey } : undefined;

    const every = frameEvery(genesis);
    const byStep = new Map<number, Move[]>();
    for (const { move } of archive.moveLog) byStep.set(move.step, [...(byStep.get(move.step) ?? []), move]);
    const take = () => {
      const next = chainFrame(thumbnail(sim.state, [], sim.step, FRAME_WIDTH).cells, chain);
      this.sql.exec(`INSERT OR REPLACE INTO frames (step, bytes) VALUES (?, ?)`, sim.step, next.bytes.slice().buffer);
      chain = next.chain;
    };

    if (!snapshot) take();
    const until = Math.min(archive.steps, sim.step + MAX_ADVANCE);
    while (sim.step < until && !sim.ended) {
      sim.advance(byStep.get(sim.step) ?? []);
      if (frameDue(sim.step, every, archive.steps, sim.ended)) take();
    }

    if (sim.step < archive.steps && !sim.ended) {
      await this.ctx.storage.put("snapshot", sim.snapshot());
      await this.ctx.storage.put("cells", chain!.cells.slice().buffer);
      await this.ctx.storage.put("work", { ...work, step: sim.step, sinceKey: chain!.sinceKey });
      return "more";
    }

    // The record has to reach the hash the room archived, or these are the
    // frames of some other game.
    if (hex(sim.hash()) !== archive.hash) return `replays to ${hex(sim.hash())}, archived as ${archive.hash}`;
    const frames = this.sql
      .exec<{ step: number; bytes: ArrayBuffer }>(`SELECT step, bytes FROM frames ORDER BY step`)
      .toArray()
      .map((row): [number, string] => [row.step, toBase64Url(new Uint8Array(row.bytes))]);
    const timeline = timelineFrom(genesis, frames, archive.flags, thumbnail(sim.state, [], 0, FRAME_WIDTH));
    await writeArchive(this.env.ARCHIVE!, { ...archive, timeline });
    return `given ${frames.length} frames`;
  }

  private async finishGame(roomId: string, note: string): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO done (room_id, note) VALUES (?, ?)`, roomId, note);
    this.sql.exec(`DELETE FROM frames`);
    await this.ctx.storage.delete(["work", "snapshot", "cells"]);
    await this.ctx.storage.setAlarm(Date.now());
  }
}
