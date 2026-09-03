#!/usr/bin/env node
// Night cover, with a process around it.
//
// A PeerBot is a bot that plays one *seat* rather than an empire: its own mesh
// client, its own key, signing and broadcasting a move like any other player.
// That is what lets a team sleep without losing ground — the empty seat keeps
// answering, so it never blocks the peers still playing — and it already ran in
// a browser tab. A tab is the problem: the cover a marathon game needs is cover
// that survives the laptop closing.
//
// It costs the empire something, or free night cover would be strictly better
// than none and therefore the only way to play. The price is charged by the
// rules rather than here: a BOT member accrues at half rate, caps at 499
// instead of 999, and its coin claims fire without triggering the coins they
// land on. It also only ever defends — a bot that attacked would take ground
// its team never chose to take, on a front nobody was awake to hold. Cover, not
// initiative.
//
// It is seated the way any substitute is: it joins as an observer, prints the
// key it is holding, and an empire votes it in with ROSTER_AMEND. There is no
// bot-shaped mechanism anywhere in the protocol, and there should not be — from
// the mesh's side this is a player who happens never to sleep.
//
//   tessera-bot <room-code> [--play cycle] [--rate patient] [--hours 22-07]
//
// What is *not* configurable here is what a bot costs. Population accrual is
// hashed state, decided by the seat's kind in the genesis record — a BOT member
// accrues at half rate and caps at 499 — so a bot that chose its own growth
// would either desync or be a cheat that validated. The host prices the seat;
// the bot only decides how to play it.

import { parseArgs } from "node:util";
import { fingerprint } from "@tessera/protocol";
import { PeerBot } from "@tessera/net";
import type { Play, Seat, Target } from "@tessera/net";
import { identityAt, joinGame } from "@tessera/headless";

const USAGE = `tessera-bot — hold a seat in a Tessera game while its player is away

  tessera-bot <room-code> [options]

It joins as an observer and waits to be voted a seat. Give the key it prints to
whoever is hosting: they invite it, the empire endorses, and it starts playing.

Options:
  --key <path>    identity file (default ./bot.jwk) — the key IS the seat
  --as <id>       claim this peer id rather than one the broker invents
  --ice <urls>    comma-separated STUN/TURN urls, replacing PeerJS's own
  --quiet         only complain

  --play <how>    defend (default) | expand | attack | home | cycle
                  defend reinforces the thinnest contested tile and nothing
                  else. expand takes neutral ground. attack walks towards a
                  capital. home banks around its own. cycle rotates through all
                  four the way an in-sim bot does, coin grabs included.

  --target <who>  nearest (default) | random | rotate | <empire number>
                  Who to walk towards while attacking. random and rotate change
                  every two minutes, not every action — a bot that re-chose
                  constantly would just be "nearest" again, since the nearest
                  front is where its tiles already are.

  --rate <how>    brisk | steady (default) | patient | <seconds>
                  How long it banks between claims, which is style rather than
                  strength. A bot accrues 6 population a second and caps at 499,
                  so brisk (2s) spends about 12 a claim and can only take empty
                  ground, while patient (85s) spends the full bank in one hit.
                  Slower than 85s only wastes accrual. Never faster than the
                  genesis rule: an always-on seat must not out-reflex the people
                  it is covering for.

  --hours <a-b>   only play between these local hours, e.g. 22-07 for a night
                  shift. Wraps midnight.
  --duty <on/off> play for <on> minutes in every <on+off>, e.g. 20/40.

Both schedules can be given together, and a resting bot is still connected: it
heartbeats, it promises readiness, it never blocks the peers still playing. It
simply banks its population instead of spending it — which is the one balance
lever an always-on seat needs, and it must not cost the empire the seat.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: "string", default: "bot.jwk" },
    as: { type: "string" },
    ice: { type: "string" },
    play: { type: "string", default: "defend" },
    target: { type: "string", default: "nearest" },
    rate: { type: "string", default: "steady" },
    hours: { type: "string" },
    duty: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const PLAYS: readonly Play[] = ["defend", "expand", "attack", "home", "cycle"];

/** Seconds between claims, by name. A bot fills its 499 cap in about 85
 *  seconds, so `patient` is the slowest setting that wastes nothing. */
const RATES: Record<string, number> = { brisk: 2, steady: 15, patient: 85 };

const STEPS_PER_SECOND = 12;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function play(): Play {
  const chosen = values.play as Play;
  if (!PLAYS.includes(chosen)) fail(`--play must be one of ${PLAYS.join(", ")}`);
  return chosen;
}

function target(): Target {
  const chosen = values.target!;
  if (chosen === "nearest" || chosen === "random" || chosen === "rotate") return chosen;
  const empire = Number(chosen);
  if (!Number.isInteger(empire) || empire < 1) {
    fail("--target must be nearest, random, rotate, or an empire number");
  }
  return empire;
}

function interval(): number {
  const named = RATES[values.rate!];
  const seconds = named ?? Number(values.rate);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`--rate must be ${Object.keys(RATES).join(", ")}, or a number of seconds`);
  }
  return Math.round(seconds * STEPS_PER_SECOND);
}

/** When it is playing at all. Two independent schedules, and a bot has to be
 *  inside both: a night shift that also rests is a night shift that rests. */
function awake(): ((now: number) => boolean) | undefined {
  const checks: Array<(now: number) => boolean> = [];

  if (values.hours !== undefined) {
    const [from, to] = values.hours.split("-").map((part) => Number(part));
    if (![from, to].every((h) => Number.isInteger(h) && h! >= 0 && h! <= 23)) {
      fail("--hours wants two local hours, as in 22-07");
    }
    checks.push((now) => {
      const hour = new Date(now).getHours();
      // Wrapping midnight is the normal case for a night shift, not the corner.
      return from! <= to! ? hour >= from! && hour < to! : hour >= from! || hour < to!;
    });
  }

  if (values.duty !== undefined) {
    const [on, off] = values.duty.split("/").map((part) => Number(part));
    if (![on, off].every((m) => Number.isFinite(m) && m! >= 0) || !on || on + off! <= 0) {
      fail("--duty wants minutes on and minutes off, as in 20/40");
    }
    const cycle = on + off!;
    checks.push((now) => Math.floor(now / 60_000) % cycle < on);
  }

  if (checks.length === 0) return undefined;
  return (now) => checks.every((check) => check(now));
}

const say = (line: string): void => {
  if (!values.quiet) console.log(line);
};

async function run(code: string): Promise<void> {
  const identity = await identityAt(values.key);
  say(`bot      ${await fingerprint(identity.key)}`);
  say(`key      ${identity.key}`);
  say(`joining  ${code}`);
  say(
    `playing  ${settings.mode}, target ${String(settings.target)}, ` +
      `a claim every ${(settings.interval / STEPS_PER_SECOND).toFixed(0)}s` +
      (settings.awake ? ", on a schedule" : ""),
  );

  let bot: PeerBot | undefined;

  const peer = await joinGame({
    code,
    identity,
    ...(values.as ? { id: values.as } : {}),
    ...(values.ice
      ? { iceServers: values.ice.split(",").map((urls) => ({ urls: urls.trim() })) }
      : {}),
    onDriver: (driver, _genesis, seat) => {
      // Built only once there is a seat to play, because a PeerBot seeds its
      // randomness from the seat it holds — and two unseated bots seeding from
      // the same nothing would decide identically, which is not wrong but is
      // needlessly dull.
      const start = (given: Seat): void => {
        if (bot) return;
        bot = new PeerBot({
          lockstep: driver,
          mode: settings.mode,
          target: settings.target,
          interval: settings.interval,
          ...(settings.awake ? { awake: settings.awake } : {}),
        });
        say(`seated   empire ${given.empire}, seat ${given.member}`);
      };

      if (seat) start(seat);
      driver.onSeated = (given, key) => {
        if (key === identity.key) start(given);
      };
      driver.onEjection = (who, atStep, reason) => {
        if (who.empire !== driver.seat?.empire || who.member !== driver.seat?.member) return;
        say(`dropped at step ${atStep}: ${reason}`);
      };
      driver.onHalt = (reason) => say(`halted: ${reason}`);
    },
  });

  if (!peer.seat) say(`waiting  for an empire to vote this key a seat`);

  // tick() is pump() plus "is a turn due". The driver is already being pumped
  // on its own timer, and a second pump costs nothing when there is nothing to
  // simulate — what this interval is really for is the second half, which is a
  // decision every few seconds rather than every step.
  const acting = setInterval(() => bot?.tick(), 1000);

  // A bot that has gone quiet looks exactly like one that has crashed, and the
  // difference matters to the team relying on it.
  let rested = false;
  const watch = setInterval(() => {
    if (!bot || bot.resting === rested) return;
    rested = bot.resting;
    say(rested ? "resting" : "playing again");
  }, 10_000);
  watch.unref?.();

  const done = async (): Promise<void> => {
    clearInterval(acting);
    clearInterval(watch);
    await peer.stop();
    say(`stopped at step ${peer.driver.step}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void done());
  process.on("SIGTERM", () => void done());
}

const [code] = positionals;
if (values.help || !code) {
  console.log(USAGE);
  process.exit(code ? 0 : 1);
}

// Everything the flags decide, decided once and before anything connects: a bad
// flag should be a refusal at the prompt, not a surprise an hour into a game.
const settings = {
  mode: play(),
  target: target(),
  interval: interval(),
  awake: awake(),
};

await run(code).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
