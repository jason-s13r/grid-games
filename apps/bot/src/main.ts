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
//   tessera-bot <room-code> [--key path]

import { parseArgs } from "node:util";
import { fingerprint } from "@tessera/protocol";
import { PeerBot } from "@tessera/net";
import type { Seat } from "@tessera/net";
import { identityAt, joinGame } from "@tessera/headless";

const USAGE = `tessera-bot — hold a seat in a Tessera game while its player is away

  tessera-bot <room-code> [options]

It joins as an observer and waits to be voted a seat. Give the key it prints to
whoever is hosting: they invite it, the empire endorses, and it starts playing.

Options:
  --key <path>    identity file (default ./bot.jwk) — the key IS the seat
  --as <id>       claim this peer id rather than one the broker invents
  --ice <urls>    comma-separated STUN/TURN urls, replacing PeerJS's own
  --attack        let it take ground as well as hold it (it will not thank you)
  --quiet         only complain
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: "string", default: "bot.jwk" },
    as: { type: "string" },
    ice: { type: "string" },
    attack: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const say = (line: string): void => {
  if (!values.quiet) console.log(line);
};

async function play(code: string): Promise<void> {
  const identity = await identityAt(values.key);
  say(`bot      ${await fingerprint(identity.key)}`);
  say(`key      ${identity.key}`);
  say(`joining  ${code}`);

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
        bot = new PeerBot({ lockstep: driver, ...(values.attack ? { mode: "attack" as const } : {}) });
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

  const done = async (): Promise<void> => {
    clearInterval(acting);
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

await play(code).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
