#!/usr/bin/env node
// Night cover, with a process around it.
//
// A bot that plays one seat rather than an empire: its own key, its own
// connection to the game room, signing each move like any other player. That is
// what lets a team sleep without losing ground, and a process on a server is
// what lets it outlast a closed laptop.
//
// It costs the empire a seat, and that is the whole price. The room seats it as
// a bot (so everyone can see what it is), and only by an invite or a player's
// approval: an empire never gets a bot it did not ask for.
//
//   tessera-bot https://tessera.qot.nz/g/abc123?invite=…
//   tessera-bot https://tessera.qot.nz/g/abc123 --ask 2
//
// What is not configurable here is how fast it may act. The floor is a genesis
// rule, because an always-on seat that out-reflexed the people it plays against
// would be the one thing night cover must never be.

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DIFFICULTY, STEPS_PER_SECOND } from "@tessera/sim";
import type { Difficulty } from "@tessera/sim";
import { Identity, fingerprint } from "@tessera/protocol";
import { RoomClient } from "@tessera/room";
import { Bot, PLAYS, dutyCycle, hoursWindow } from "./bot.js";
import { parseLink } from "./link.js";
import type { Link } from "./link.js";
import type { Play, Target } from "./bot.js";

const USAGE = `tessera-bot — hold a seat in a Tessera game while its player is away

  tessera-bot <game link> [options]

The link is the game's address. With an invite in it (the link "Invite to my
empire" makes), the bot takes that seat straight away. Without one, give
--ask <empire> and a player of that empire lets it in.

Options:
  --ask <n>       ask empire n for a seat (when the link has no invite)
  --key <path>    identity file (default ./bot.jwk); the key is the seat
  --name <text>   what the others see it called (default "bot")
  --quiet         only complain

  --play <how>    defend (default) | expand | attack | fortify | heal | sleep
                  | cycle. cycle moves through the phases the way an in-sim
                  bot does.
  --level <how>   easy | steady (default) | hard: the cycle --play cycle runs
  --target <who>  nearest (default) | random | rotate | <empire number>
  --rate <how>    brisk | steady (default) | patient | <seconds> between claims.
                  Faster than the game's own floor for bots is refused.
  --hours <a-b>   only play between these local hours, e.g. 22-07
  --duty <on/off> play <on> minutes in every <on+off>, e.g. 20/40

A resting bot stays connected and keeps its seat; it banks instead of spending.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ask: { type: "string" },
    key: { type: "string", default: "bot.jwk" },
    name: { type: "string", default: "bot" },
    play: { type: "string", default: "defend" },
    level: { type: "string", default: "steady" },
    target: { type: "string", default: "nearest" },
    rate: { type: "string", default: "steady" },
    hours: { type: "string" },
    duty: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

/** Seconds between claims, by name. A seat fills its bank in about 83 seconds,
 *  so `patient` is the slowest setting that wastes nothing. */
const RATES: Record<string, number> = { brisk: 2, steady: 15, patient: 85 };
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const say = (line: string): void => {
  if (!values.quiet) console.log(line);
};

function play(): Play {
  const chosen = values.play as Play;
  if (!PLAYS.includes(chosen)) fail(`--play must be one of ${PLAYS.join(", ")}`);
  return chosen;
}

function level(): Difficulty {
  const chosen = values.level as Difficulty;
  if (!(chosen in DIFFICULTY)) fail(`--level must be one of ${Object.keys(DIFFICULTY).join(", ")}`);
  return chosen;
}

function target(): Target {
  const chosen = values.target!;
  if (chosen === "nearest" || chosen === "random" || chosen === "rotate") return chosen;
  const empire = Number(chosen);
  if (!Number.isInteger(empire) || empire < 1) fail("--target must be nearest, random, rotate, or an empire number");
  return empire;
}

function interval(): number {
  const seconds = RATES[values.rate!] ?? Number(values.rate);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`--rate must be ${Object.keys(RATES).join(", ")}, or a number of seconds`);
  }
  return Math.round(seconds * STEPS_PER_SECOND);
}

/** A bot has to be inside both schedules: a night shift that also rests is a
 *  night shift that rests. */
function awake(): ((now: number) => boolean) | undefined {
  const checks: Array<(now: number) => boolean> = [];
  for (const made of [
    values.hours === undefined ? undefined : hoursWindow(values.hours),
    values.duty === undefined ? undefined : dutyCycle(values.duty),
  ]) {
    if (typeof made === "string") fail(made);
    if (made) checks.push(made);
  }
  return checks.length ? (now) => checks.every((check) => check(now)) : undefined;
}

/** The key in the file, or a new one written there. */
async function identityAt(path: string): Promise<Identity> {
  const stored = await readFile(path, "utf8").catch(() => undefined);
  if (stored !== undefined) {
    const identity = await Identity.restore(stored);
    if (!identity) fail(`${path} is not a key this bot can read`);
    return identity;
  }
  const identity = await Identity.generate();
  await writeFile(path, await identity.export(), { mode: 0o600 });
  return identity;
}

async function run(link: Link, ask: number | undefined): Promise<void> {
  const identity = await identityAt(values.key!);
  say(`bot      ${await fingerprint(identity.key)}`);
  say(`joining  ${link.roomId}`);
  say(
    `playing  ${settings.mode}${settings.mode === "cycle" ? ` (${values.level})` : ""}, ` +
      `target ${String(settings.target)}, a claim every ${(settings.interval / STEPS_PER_SECOND).toFixed(0)}s` +
      (settings.awake ? ", on a schedule" : ""),
  );

  const client = new RoomClient({
    identity,
    roomId: link.roomId,
    name: values.name!,
    bot: true,
    send: () => {},
  });
  const bot = new Bot({
    mode: settings.mode,
    profile: settings.profile,
    target: settings.target,
    interval: settings.interval,
    seed: `tessera-bot:${identity.key}`,
    ...(settings.awake ? { awake: settings.awake } : {}),
  });

  let seated = false;
  let asked = false;
  client.onError = (message) => say(`room     ${message}`);
  client.onSeated = (you) => {
    if (you.seat && !seated) say(`seated   empire ${you.seat.empire}, seat ${you.seat.member}`);
  };
  client.onStart = () => say("started");

  // Once in, take the seat it was sent for. The invite works once, so a bot
  // restarted with the same link and key simply finds its seat waiting.
  const join = (): void => {
    if (asked || !client.you || client.phase !== "playing") return;
    asked = true;
    if (client.you.seat) return;
    if (link.invite) client.redeem(link.invite);
    else if (ask !== undefined) client.ask(ask);
    else say("waiting  no invite and no --ask: watching only");
  };

  let socket: WebSocket | undefined;
  let attempts = 0;
  let stopping = false;
  const open = (): void => {
    if (stopping) return;
    const current = new WebSocket(link.socket);
    socket = current;
    client.reconnected((text) => {
      if (current.readyState === WebSocket.OPEN) current.send(text);
    });
    current.addEventListener("open", () => {
      attempts = 0;
    });
    current.addEventListener("message", (event) => {
      void client.receive(String(event.data));
    });
    current.addEventListener("close", () => {
      if (socket !== current || stopping) return;
      const delay = BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]!;
      say(`lost     the connection; again in ${delay / 1000}s`);
      setTimeout(open, delay);
    });
  };
  open();

  // The simulation runs on the bot's own clock, the way a browser's does: it
  // has to be at "now" to see the board it is moving on and to send the hash
  // reports that keep its seat present.
  let rested = false;
  const acting = setInterval(() => {
    join();
    client.advance();
    const sim = client.sim;
    const seat = client.you?.seat;
    if (!sim || !seat || sim.ended) return;
    if (!sim.state.empires[seat.empire - 1]?.members[seat.member]) return;
    if (!seated) {
      seated = true;
      say(`playing  as empire ${seat.empire}`);
    }
    if (bot.resting !== rested) {
      rested = bot.resting;
      say(rested ? "resting" : "playing again");
    }
    const move = bot.turn(sim.state, seat);
    if (move) void client.submit(move.type, move.x, move.y);
  }, 100);

  const done = (): void => {
    stopping = true;
    clearInterval(acting);
    socket?.close();
    say(`stopped  at step ${client.sim?.step ?? 0}`);
    process.exit(0);
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
}

const [given] = positionals;
if (values.help || !given) {
  console.log(USAGE);
  process.exit(given ? 0 : 1);
}

// Everything the flags decide, decided before anything connects: a bad flag
// should be a refusal at the prompt, not a surprise an hour into a game.
const parsed = parseLink(given);
if (typeof parsed === "string") fail(parsed);
const ask = values.ask === undefined ? undefined : Number(values.ask);
if (ask !== undefined && (!Number.isInteger(ask) || ask < 1)) fail("--ask takes an empire number");
const settings = {
  mode: play(),
  profile: DIFFICULTY[level()],
  target: target(),
  interval: interval(),
  awake: awake(),
};

await run(parsed, ask).catch((error: Error) => fail(error.message));
