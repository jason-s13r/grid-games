// Gives every finished game's archive a timeline, if it has none.
//
// Rooms keep a timeline of the map (see packages/room/src/frames.ts) from
// worker 0.8.0. Games archived before that have none, and once the sim that
// played them is retired, a timeline is the only way to watch them. This
// replays each such archive with the sim in this checkout, makes the timeline
// a room would have kept, and writes the archive back to R2.
//
// Run it while this checkout still plays the games' versions:
//
//   pnpm --filter "./packages/*" build
//   pnpm --filter @tessera/worker backfill-timelines [--dry-run]
//
// Talks to the live database and bucket through wrangler, so it needs a
// wrangler login (or CLOUDFLARE_API_TOKEN) for the account. Safe to run again:
// an archive that already has a timeline is left alone.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Sim, hex, playsProtocol } from "@tessera/sim";
import { timelineOf } from "@tessera/room";

const DATABASE = "tessera";
const BUCKET = "tessera-archive";
const dryRun = process.argv.includes("--dry-run");
const dir = mkdtempSync(join(tmpdir(), "tessera-backfill-"));

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const rows = JSON.parse(
  wrangler("d1", "execute", DATABASE, "--remote", "--json", "--command", "SELECT id FROM games WHERE phase = 'ended' ORDER BY ended_at"),
)[0].results;

let done = 0;
let had = 0;
let skipped = 0;
for (const { id } of rows) {
  const file = join(dir, `${id}.json.gz`);
  const key = `${BUCKET}/games/${id}.json.gz`;
  try {
    wrangler("r2", "object", "get", key, "--remote", "--file", file);
  } catch {
    console.log(`${id}: no archive`);
    skipped++;
    continue;
  }
  const archive = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  if (archive.timeline) {
    had++;
    continue;
  }
  const { protocol } = archive.genesis;
  if (!playsProtocol(protocol)) {
    console.log(`${id}: v${protocol}, which this checkout no longer plays`);
    skipped++;
    continue;
  }

  // The record has to reach the hash the room archived, or the frames would
  // be of some other game.
  const sim = new Sim(archive.genesis);
  const byStep = new Map();
  for (const { move } of archive.moveLog) byStep.set(move.step, [...(byStep.get(move.step) ?? []), move]);
  while (sim.step < archive.steps && !sim.ended) sim.advance(byStep.get(sim.step) ?? []);
  if (hex(sim.hash()) !== archive.hash) {
    console.log(`${id}: replays to ${hex(sim.hash())}, archived as ${archive.hash}; left alone`);
    skipped++;
    continue;
  }

  const timeline = timelineOf(archive);
  console.log(`${id}: v${protocol}, ${timeline.frames.length} frames${dryRun ? " (dry run)" : ""}`);
  if (dryRun) continue;
  writeFileSync(file, gzipSync(JSON.stringify({ ...archive, timeline })));
  wrangler(
    "r2", "object", "put", key, "--remote", "--file", file,
    "--content-type", "application/json", "--content-encoding", "gzip",
  );
  done++;
}

console.log(`${done} given a timeline, ${had} had one, ${skipped} skipped.`);
