#!/usr/bin/env node
// The durable peer.
//
// An observer is a peer with no empire: it validates every move, hashes every
// step and stores everything, and cannot act. That has been true in the browser
// since Phase C — a peer whose key is not in the roster is an observer by
// construction, with no mechanism needed to make it one. What it never was is
// durable. Close the tab and the game's history goes with it, and a mesh with
// nobody awake in it is a mesh that has stopped.
//
// This is that peer with a process around it. One of these on a small VPS
// closes the gap that genuinely argues for a server, and grants no server any
// power doing it: it holds no seat, its vote is counted like anyone else's, and
// every frame it passes on was signed by somebody who is not it.
//
// It is also the address a game survives at. Room codes are peer ids, so a game
// whose host has closed their laptop is reachable at whatever peer is still
// up — which is why `--as` exists. Give the observer a stable id and it becomes
// the door back into a game that would otherwise have no door at all.
//
// Three things to do with it:
//
//   tessera-observe <code>            follow a game and write it down
//   tessera-observe export <dir>      assemble the directory into one file
//   tessera-observe verify <path>     check an archive end to end

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fingerprint } from "@tessera/protocol";
import { verifyArchive } from "@tessera/net";
import { FileArchive, identityAt, joinGame, readArchive } from "@tessera/headless";

const USAGE = `tessera-observe — follow a Tessera game and archive it

  tessera-observe <room-code> [options]
  tessera-observe export <dir> [file.json]
  tessera-observe verify <dir|file.json>

Options:
  --dir <path>    where archives go (default ./archives)
  --key <path>    identity file (default <dir>/identity.jwk)
  --as <id>       claim this peer id, so players can dial the observer itself
  --ice <urls>    comma-separated STUN/TURN urls, replacing PeerJS's own
  --quiet         only complain
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "archives" },
    key: { type: "string" },
    as: { type: "string" },
    ice: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const say = (line: string): void => {
  if (!values.quiet) console.log(line);
};

async function watch(code: string): Promise<void> {
  const identity = await identityAt(values.key ?? join(values.dir, "identity.jwk"));
  say(`observer ${await fingerprint(identity.key)}`);
  say(`joining  ${code}`);

  let archive: FileArchive | undefined;

  const peer = await joinGame({
    code,
    identity,
    ...(values.as ? { id: values.as } : {}),
    ...(values.ice
      ? { iceServers: values.ice.split(",").map((urls) => ({ urls: urls.trim() })) }
      : {}),
    onDriver: (driver, genesis) => {
      const dir = join(values.dir, genesis.gameId ?? "unknown");
      archive = new FileArchive({ dir, genesis, source: driver, snapshots: driver.snapshots });
      archive.archive.attach(driver);
      void archive.open().then(() => say(`archive  ${dir}`));

      // Worth saying out loud rather than only writing down. An observer is the
      // one peer likely to be watching when something goes wrong, and it is
      // usually the only one nobody is sitting in front of.
      driver.onEjection = (seat, atStep, reason) =>
        say(`  step ${atStep}: empire ${seat.empire} seat ${seat.member} dropped — ${reason}`);
      driver.onHalt = (reason) => say(`  halted: ${reason}`);
    },
  });

  say(`playing  ${peer.genesis.gameId} as ${peer.lobby.mesh.id}`);
  if (values.as) say(`dial     ${values.as} to rejoin this game`);

  const progress = setInterval(() => {
    const empires = peer.driver.sim.summary().filter((one) => one.alive).length;
    say(`  step ${peer.driver.step}  ${empires} empires  ${peer.driver.sim.ended ? "ended" : "playing"}`);
  }, 60_000);
  progress.unref?.();

  const done = async (): Promise<void> => {
    clearInterval(progress);
    await archive?.close();
    await peer.stop();
    say(`stopped at step ${peer.driver.step}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void done());
  process.on("SIGTERM", () => void done());
}

/** The directory, assembled into the single file `pnpm replay --log` reads. */
async function exportGame(dir: string, out?: string): Promise<void> {
  const game = await readArchive(dir);
  const path = out ?? join(dir, "game.json");
  await writeFile(path, `${JSON.stringify(game, null, 2)}\n`);
  console.log(`${path}  ${game.moveLog.length} moves, ${game.steps} steps, hash ${game.hash}`);
}

/** What a stranger can check. Nothing here asks the archive to be believed: the
 *  genesis record is re-hashed, the roster is rebuilt from it, every signature
 *  is checked against that roster, and the log is replayed to see whether it
 *  reaches the hash it claims. */
async function verify(path: string): Promise<void> {
  const game = path.endsWith(".json")
    ? (JSON.parse(await readFile(path, "utf8")) as Awaited<ReturnType<typeof readArchive>>)
    : await readArchive(path);

  const verdict = await verifyArchive(game);
  console.log(`game      ${game.genesis.gameId}`);
  console.log(`steps     ${verdict.steps}`);
  console.log(`moves     ${verdict.moves} (${verdict.verified} signed and verified)`);
  console.log(`hash      ${verdict.hash}`);
  for (const problem of verdict.problems) console.error(`PROBLEM   ${problem}`);
  console.log(verdict.ok ? "VERIFIED" : "REFUSED");
  if (!verdict.ok) process.exitCode = 1;
}

const [command, ...rest] = positionals;

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
} else if (command === "export") {
  if (!rest[0]) {
    console.error("export needs a directory");
    process.exit(1);
  }
  await exportGame(rest[0], rest[1]);
} else if (command === "verify") {
  if (!rest[0]) {
    console.error("verify needs an archive");
    process.exit(1);
  }
  await verify(rest[0]);
} else {
  await watch(command).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
