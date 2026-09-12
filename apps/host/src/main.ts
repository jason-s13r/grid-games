#!/usr/bin/env node
// A peer that stays.
//
// Multi-day games die with the tab that owns them: the room code is the host's
// peer id, and when the tab closes the door closes. This is one process that
// holds the door open and the game's paper trail, in either transport — which is
// what keeps the decentralised model intact, because a WebRTC room gets the same
// persistence as a hosted one.
//
// The load-bearing claim is that **a host is a client with a job, never a server
// of truth.** Its authority ends at the genesis: it composes the record and
// broadcasts it, every peer verifies it independently, and nothing after that
// point needs a host at all. As a peer it is exactly the observer that already
// exists — no seat, no checkpoints, no vote, no effect on the abandonment rule,
// which counts empires by their silence and a peer with no empire is not in the
// sum. Its presence changes no hash.
//
// As the relay it can do one thing a TURN relay cannot: carry every peer but one.
// The seats it silences are proposed for a drop and ejected by quorum, so a
// malicious host's power is denial of play escalating to ejection — never
// authority, never a forged move, and never invisible, because the ejection is a
// quorum-signed record in every archive of that game.
//
// And one property makes serving resume points safe: an observer holds no seat,
// signs no checkpoints, and can therefore never be a witness to the resume point
// it is keeping. The host stores and serves an artifact only the players could
// have produced, and cannot add itself to the tally at any price.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fingerprint } from "@tessera/protocol";
import { RoomBus, SocketTransport, formatRef, isRoomName, localPair, mintName, parseRef } from "@tessera/net";
import type { ConnectionRef, Opener } from "@tessera/net";
import { FileArchive, hostGame, identityAt, readArchive, readResumePoint } from "@tessera/headless";
import type { HostedGame } from "@tessera/headless";
import { fromAuto, fromPlan, sealWith } from "./compose.js";
import type { Composer, PlanFile } from "./compose.js";
import { serve } from "./serve.js";
import type { Room } from "./serve.js";

const USAGE = `tessera-host — hold the door open for a game that outlives a tab

  tessera-host [--plan <file> | --auto <n>] [options]
  tessera-host import <url> <dir>

Options:
  --transport wss|rtc  how players reach this host (default wss)
  --room <name>        the room this host serves; minted if absent (wss only)
  --as <id>            the peer id to claim; in rtc mode this is the room code
  --bind <addr>        where the relay and the reads listen (default 127.0.0.1)
  --port <n>           one port for both (default 8080)
  --ref <room>         join somebody else's room instead of serving one
  --plan <file>        a fixed roster: empires of member keys, bots, map, duration
  --auto <n>           seal as soon as n players are here, one empire each
  --wait <secs>        seal early at this deadline with whoever is present
  --dir <path>         where archives go (default ./archives)
  --key <path>         identity file (default <dir>/identity.jwk)
  --ice <urls>         STUN/TURN urls, replacing PeerJS's own (rtc only)
  --open-relay         serve rooms this process is not a peer in, knowingly
  --quiet              only complain

A browser needs wss://, which means a certificate in front of this process. ws://
is fine for headless peers, a LAN or Tailscale, which is why --bind is loopback
until you say otherwise.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    transport: { type: "string", default: "wss" },
    room: { type: "string" },
    as: { type: "string" },
    bind: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8080" },
    ref: { type: "string" },
    plan: { type: "string" },
    auto: { type: "string" },
    wait: { type: "string" },
    dir: { type: "string", default: "./archives" },
    key: { type: "string" },
    ice: { type: "string" },
    "open-relay": { type: "boolean", default: false },
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
  if (!Number.isFinite(value) || value < 0) throw new Error(`${what} must be a number`);
  return value;
};

async function planFile(path: string | undefined): Promise<PlanFile> {
  if (!path) return { empires: [] };
  const text = await readFile(path, "utf8");
  const file = JSON.parse(text) as PlanFile;
  if (!Array.isArray(file.empires)) throw new Error(`${path} has no empires`);
  for (const empire of file.empires) {
    if (!Array.isArray(empire) || empire.length === 0) {
      throw new Error(`${path} has an empire with no members`);
    }
  }
  return file;
}

/** Fetch a predecessor's archive, check it, and lay it out as ours.
 *
 *  So a replacement *continues* one archive instead of starting a second
 *  fragment. It refuses to stitch across a hole: a file that claims to be
 *  replayable and is not is the one archive failure this codebase has been
 *  careful never to allow. */
async function importArchive(url: string, dir: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const game = (await response.json()) as { genesis?: { gameId?: string }; from?: number };
  const gameId = game.genesis?.gameId;
  if (!gameId) throw new Error("that is not an archive");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const into = join(dir, gameId);
  await mkdir(into, { recursive: true });
  await writeFile(join(into, "imported.json"), `${JSON.stringify(game)}\n`);
  say(`imported ${gameId} into ${into}`);
  if (game.from) {
    say(`warning: that archive begins at step ${game.from}, so it is a fragment`);
  }
  say(`verify it with: tessera-observe verify ${join(into, "imported.json")}`);
}

async function run(): Promise<void> {
  const dir = values.dir;
  const identity = await identityAt(values.key ?? join(dir, "identity.jwk"));
  say(`host     ${await fingerprint(identity.key)}`);

  const rtc = values.transport === "rtc";
  if (!rtc && values.transport !== "wss") throw new Error("--transport is wss or rtc");
  if (rtc && values.ice === undefined && values.room) {
    say("note: --room is ignored in rtc mode; --as is the room code");
  }

  const file = await planFile(values.plan);
  const auto = number(values.auto, "--auto");
  const wait = number(values.wait, "--wait");
  if (!values.plan && auto === undefined && !values.ref) {
    throw new Error("say how to compose the game: --plan <file> or --auto <n>");
  }
  // One empire is last-empire-standing on the first step, so a game needs two.
  // Refused here rather than discovered later: the alternative is a host that
  // composes, is refused, and prints that it is waiting for players who have
  // already arrived — forever.
  const bots = file.simbots?.length ?? 0;
  if (auto === undefined && values.plan && file.empires.length === 0) {
    throw new Error(
      `${values.plan} seats nobody. A game with no human seats is a game nobody is ` +
        `playing — name empires in it, or use --auto <n> to seat whoever arrives`,
    );
  }
  if (auto !== undefined && auto + bots < 2) {
    throw new Error(
      `--auto ${auto} would be a game of ${auto + bots} empire${auto + bots === 1 ? "" : "s"}; ` +
        `a game needs two. Wait for more players, or give --plan a file with simbots in it`,
    );
  }

  const port = number(values.port, "--port") ?? 8080;
  const rooms = new Map<string, Room>();
  // Closed by default: a bus that creates any room asked for is an open relay for
  // strangers' traffic, and that is a different product from this one.
  const bus = new RoomBus(
    values["open-relay"] ? {} : { serves: (room) => rooms.has(room) },
  );

  // Where players are told to go. In rtc mode the room *is* the peer id, which is
  // why --as and --room are one flag there and two here.
  const room = values.room ?? mintName();
  const ref: ConnectionRef | undefined = values.ref
    ? parseRef(values.ref)
    : rtc
      ? undefined
      : { kind: "socket", url: `ws://${values.bind}:${port}`, room };

  if (ref?.kind === "socket" && !isRoomName(ref.room)) throw new Error("that is not a room name");

  /** The host's own seat at its own bus, in process. */
  const attach: Opener = async (_ref, options) => {
    const transport = new SocketTransport(ref as ConnectionRef & { kind: "socket" }, {
      ...options,
      attach: () => localPair(bus),
    });
    await transport.opening;
    return transport;
  };

  const serving = !values.ref && !rtc;
  // `--auto` wins when both are given, because then the plan file is the
  // *settings* — bots, map, duration — and the roster is whoever turns up. A plan
  // file is both things, and naming empires in it is what makes it a roster.
  const composer: Composer | null = values.ref
    ? null
    : auto !== undefined
      ? fromAuto(auto, file)
      : values.plan
        ? fromPlan(file)
        : null;

  let archive: FileArchive | undefined;
  let hosted: HostedGame | undefined;
  let sealed = false;

  const entry: Room = {
    dir: () => (hosted ? join(dir, hosted.genesis.gameId ?? "unknown") : undefined),
    status: () => ({
      gameId: hosted?.genesis.gameId ?? "",
      step: hosted?.driver.step ?? 0,
      peers: hosted?.lobby.connection.peers().length ?? 0,
      // `stopped` carries why, and a reader only needs to know that it has.
      ended: hosted?.driver.stopped !== null && hosted?.driver.stopped !== undefined,
    }),
  };
  const code = ref?.kind === "socket" ? ref.room : (values.as ?? room);
  rooms.set(code, entry);

  const server = serving || rtc
    ? serve({
        bus,
        bind: values.bind,
        port,
        rooms,
        read: { resume: readResumePoint, archive: readArchive },
        say,
      })
    : undefined;

  if (serving) {
    say(`room     ${formatRef(ref!)}`);
    say(`         a browser needs wss:// — put a certificate in front of this`);
  }

  // A deadline rather than a rule: a host that waits forever for a fifth player
  // is a room three people gave up on.
  let deadline: ReturnType<typeof setTimeout> | undefined;

  hosted = await hostGame({
    identity,
    ...(ref ? { ref } : {}),
    ...(serving ? { connect: attach } : {}),
    ...(values.as ? { id: values.as } : {}),
    ...(values.ice && rtc
      ? { iceServers: values.ice.split(",").map((urls) => ({ urls: urls.trim() })) }
      : {}),
    compose: (players) => {
      if (!composer) return null;
      const plan = composer(players);
      if (plan) sealed = true;
      return plan;
    },
    onRefused: (problem) => {
      // Structural, every time: composing again would be refused again.
      console.error(`cannot compose this game: ${problem}`);
      process.exit(1);
    },
    onWaiting: (players) => {
      const here = players.filter((player) => !player.you).length;
      if (composer) say(`waiting  ${here} here, want ${composer.wants}`);
      if (wait === undefined || deadline || here < 1) return;
      deadline = setTimeout(() => {
        if (sealed) return;
        say(`sealing  with ${here} — the deadline passed`);
        const now = sealWith(file, here);
        if (now) hosted?.lobby.host(now(hosted.lobby.players())!).catch(() => undefined);
      }, wait * 1000);
      deadline.unref?.();
    },
    onDriver: (driver, genesis) => {
      const into = join(dir, genesis.gameId ?? "unknown");
      archive = new FileArchive({
        dir: into,
        genesis,
        source: driver,
        snapshots: driver.snapshots,
      });
      archive.archive.attach(driver);
      void archive.open().then(() => say(`archive  ${into}`));

      // Worth saying out loud rather than only writing down: a host is usually
      // the only peer nobody is sitting in front of.
      driver.onEjection = (seat, atStep, reason) =>
        say(`  step ${atStep}: empire ${seat.empire} seat ${seat.member} dropped — ${reason}`);
      driver.onHalt = (reason) => say(`  halted: ${reason}`);
    },
  });

  say(`playing  ${hosted.genesis.gameId} as ${hosted.lobby.connection.id}`);
  say(`join     ${hosted.shareable}`);

  // The resume point, kept on disk rather than derived on demand. `resumePoint()`
  // needs both the bytes and the witnesses, and the snapshot store rolls forward
  // every interval on every peer while witnesses only arrive with a checkpoint
  // from a seat — so four minutes after the last player leaves, a live answer is
  // `undefined` forever. Polling is free: usually the same step.
  const keeping = setInterval(() => {
    const point = hosted?.driver.resumePoint();
    if (point && archive) void archive.resume(point).catch(() => undefined);
  }, 10_000);
  keeping.unref?.();

  const done = async (): Promise<void> => {
    clearInterval(keeping);
    if (deadline) clearTimeout(deadline);
    server?.close();
    await hosted?.stop();
    await archive?.close();
    say("stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void done());
  process.on("SIGTERM", () => void done());
}

const [command, ...rest] = positionals;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
} else if (command === "import") {
  if (!rest[0]) {
    console.error("import needs a URL, and optionally a directory");
    process.exit(1);
  }
  await importArchive(rest[0], rest[1] ?? values.dir).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
} else if (command) {
  console.error(`unknown command: ${command}`);
  console.log(USAGE);
  process.exit(1);
} else {
  await run().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
