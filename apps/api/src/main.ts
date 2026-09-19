#!/usr/bin/env node
// The hosted half of Tessera, and the one thing it is careful not to become.
//
// Two of the three URLs the web client asks for point at software that did not
// exist: an address book and a host service. This process answers the first. It
// stores what it is given, expires what is not refreshed, and checks exactly one
// signature — not to decide whether a game is real, but to stop anyone clearing
// somebody else's row.
//
// It adds no authority anywhere. The sim, the hash contract, quorum signatures
// and archive verification are untouched, and everything stored here is checked
// by whoever reads it. That is a discipline rather than a property: a board that
// *could* decide something would become a board that *does*, and the client
// would eventually be simplified to trust it.
//
// Running one and shipping its address in the client are two decisions, and only
// the first is made here. `settings().board` stays empty until somebody types a
// URL, because a default board in the client would be the single piece of
// centralisation this design has avoided.

import { parseArgs } from "node:util";
import { Board, LIMITS } from "./board.js";
import {
  MemoryArchives,
  MemoryStore,
  PostgresApplied,
  PostgresArchives,
  PostgresStore,
} from "./db.js";
import { DEFAULT_KEEP, Ingest } from "./ingest.js";
import { MemoryApplied, Rankings } from "./rank.js";
import { FileBlobs } from "./store.js";
import { serve } from "./serve.js";

const USAGE = `tessera-api — a board nobody has to believe, and a store nobody is
                trusted to have written to

  tessera-api [options]

Options:
  --bind <addr>        where to listen (default 127.0.0.1)
  --port <n>           default 8081
  --database <url>     postgres://… — omitted, rows live in memory and die
                       with this process
  --archives <dir>     where verified archives are kept; omitted, the store is
                       off and its routes 404
  --keep <n>           how many archives keep their file (default ${DEFAULT_KEEP});
                       every game keeps its row, and its contribution to the
                       all-time table, forever
  --sweep <secs>       how often expired rows are deleted (default 30)
  --quiet              only complain
  --help

An upload is open to anyone. The uploader is not identified, not signed and not
recorded, because nothing about who they are changes what the file proves: an
archive is replayed on the way in, and only what passes is stored. A refusal
keeps its reasons and throws the file away.

A row is a lease, not a registration. An announcer that is killed, unplugged or
segfaulted withdraws nothing, and the TTL is what stops this filling with doors
into nothing — which is also why a board's freshest possible answer is "as of one
heartbeat ago", and why clients dial rather than believing.

The limits below bound a key, and a key is free to mint. What actually bounds a
public board is a per-IP limiter or a price on a row, in front of this process.
Neither is here.

  rows per key      ${LIMITS.rowsPerOwner}
  doors per game    ${LIMITS.rowsPerGame}
  writes per minute ${LIMITS.writesPerMinute}
  longest lease     ${LIMITS.ttlCeilingMs / 60_000} minutes
`;

const { values } = parseArgs({
  options: {
    bind: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8081" },
    database: { type: "string" },
    archives: { type: "string" },
    keep: { type: "string" },
    sweep: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const say = (line: string): void => {
  if (!values.quiet) console.log(line);
};

const number = (text: string | undefined, what: string): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${what} must be a number`);
  return value;
};

async function run(): Promise<void> {
  const port = number(values.port, "--port") ?? 8081;
  const every = number(values.sweep, "--sweep") ?? 30;

  const postgres = values.database ? PostgresStore.open(values.database) : undefined;
  if (postgres) {
    await postgres.migrate();
    say(`store    postgres`);
  } else {
    // Said out loud rather than defaulted quietly: an operator who meant to pass
    // a database and did not would otherwise discover it when the process
    // restarted and every game on the board vanished.
    say(`store    memory — rows will not survive a restart (pass --database)`);
  }
  const store = postgres ?? new MemoryStore();
  const board = new Board({ store });

  // The store is opt-in. A board on its own is a whole deployment, and an
  // operator who wants one should not be made to find a disk for archives.
  let ingest: Ingest | undefined;
  let rankings: Rankings | undefined;
  if (values.archives) {
    const blobs = new FileBlobs(values.archives);
    await blobs.open();
    const keep = number(values.keep, "--keep") ?? DEFAULT_KEEP;
    const archives = postgres ? new PostgresArchives(postgres.pool) : new MemoryArchives();
    const applied = postgres ? new PostgresApplied(postgres.pool) : new MemoryApplied();
    rankings = new Rankings({ archives, applied });
    ingest = new Ingest({ archives, blobs, rankings, keep, say });
    say(`archives ${values.archives}, keeping ${keep}`);
  }

  const server = serve({
    board,
    ...(ingest ? { ingest } : {}),
    ...(rankings ? { rankings } : {}),
    bind: values.bind,
    port,
    say,
  });

  // Reads exclude expired rows anyway, so this is not what makes an answer
  // fresh — it is what stops the table growing without bound.
  const sweeping = setInterval(() => {
    void board.sweep().catch((error: Error) => say(`warning: could not sweep — ${error.message}`));
  }, every * 1000);
  sweeping.unref?.();

  const done = (): void => {
    clearInterval(sweeping);
    server.close();
    void postgres?.close().finally(() => {
      say("stopped");
      process.exit(0);
    });
    if (!postgres) {
      say("stopped");
      process.exit(0);
    }
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
} else {
  await run().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
