// Six drivers in one Node process, over a loopback that serialises every frame
// exactly as a data channel would.
//
// This is Phase C's verification done as a harness rather than as two browser
// tabs and a squint. The clock is fake and delivery is explicit, so "do peers
// converge" is a deterministic check rather than a race — but everything the
// drivers do to each other is real: real signatures, real frames, real
// verification, in arrival order.

import { CONTROL, MEMBER, MOVE, STEPS_PER_SECOND, Sim, makeGenesis, validate } from "@tessera/sim";
import type { EmpireSpec, Genesis, MemberKind, Move } from "@tessera/sim";
import { Identity, Roster, sealGenesis } from "@tessera/protocol";
import type { Message } from "@tessera/protocol";
import { LoopbackNetwork, Lockstep, PeerBot } from "../index.js";
import type { LoopbackOptions, Seat } from "../index.js";

/** Web Crypto resolves on the event loop, and a verified frame is three
 *  promises deep. Yielding a handful of times is what makes the harness
 *  deterministic rather than merely usually right. */
export const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((done) => setImmediate(done));
};

export class Clock {
  ms = 0;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

export const MS_PER_STEP = 1000 / STEPS_PER_SECOND;

// --- a table of peers --------------------------------------------------------

export interface Peer {
  /** Set when this seat is played by a bot rather than by the test. */
  bot?: PeerBot;
  name: string;
  driver: Lockstep;
  seat?: Seat;
  identity?: Identity;
  chat: Message[];
  /** What each of those lines actually said to this peer. null where it could
   *  not be read — another empire's team traffic, which is the point. */
  heard: Array<string | null>;
  desyncs: Array<{ step: number; seat: Seat }>;
  ejections: Array<{ seat: Seat; atStep: number; reason: string; late: boolean }>;
  violations: string[];
}

export interface Table {
  net: LoopbackNetwork;
  clock: Clock;
  genesis: Genesis;
  gameId: string;
  peers: Peer[];
  /** Peers that are still being pumped — a "disconnected" peer stays in the
   *  array so its state can be inspected afterwards. */
  awake: Set<string>;
}

export interface TableOptions {
  /** Human seats per empire, in order. A trailing SimBot empire is added so the
   *  world has something in it besides the test's own clicking. */
  seats: number[];
  /** Bot seats per empire, alongside the human ones — a PeerBot covering a
   *  seat in a human empire, which is what a sleeping teammate looks like. */
  bots?: number[];
  /** Steps between bot actions. Set it past the length of a run to seat a bot
   *  that never spends, which is how a test watches one accrue. */
  botInterval?: number;
  simbots?: number;
  observer?: boolean;
  loopback?: LoopbackOptions;
  stallTimeout?: number;
  checkpointInterval?: number;
  snapshotInterval?: number;
  seed?: number;
}

export async function table(options: TableOptions): Promise<Table> {
  // Human seats first, then bot seats, so a member index is stable whatever the
  // mix is: e1m0 is a human whether or not e1m1 turns out to be a bot.
  const identities: Identity[][] = [];
  const kinds: MemberKind[][] = [];
  for (let e = 0; e < options.seats.length; e++) {
    const empire: Identity[] = [];
    const kind: MemberKind[] = [];
    for (let i = 0; i < options.seats[e]!; i++) {
      empire.push(await Identity.generate());
      kind.push(MEMBER.HUMAN);
    }
    for (let i = 0; i < (options.bots?.[e] ?? 0); i++) {
      empire.push(await Identity.generate());
      kind.push(MEMBER.BOT);
    }
    identities.push(empire);
    kinds.push(kind);
  }

  const empires: EmpireSpec[] = identities.map((members, e) => ({
    control: CONTROL.HUMAN,
    members: members.map((identity, m) => ({ kind: kinds[e]![m]!, key: identity.key })),
  }));
  for (let i = 0; i < (options.simbots ?? 1); i++) {
    empires.push({ control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] });
  }

  const genesis = await sealGenesis(
    makeGenesis({
      seed: options.seed ?? 11,
      startedAt: 0,
      empires,
      map: { width: 32, height: 32 },
    }),
  );

  const clock = new Clock();
  const net = new LoopbackNetwork(options.loopback);
  const peers: Peer[] = [];

  const build = (name: string, identity?: Identity, seat?: Seat, isBot = false): Peer => {
    const driver = new Lockstep({
      genesis,
      sim: new Sim(genesis),
      roster: Roster.fromGenesis(genesis),
      transport: net.connect(name),
      identity,
      seat,
      now: clock.now,
      stallTimeout: options.stallTimeout ?? 500,
      checkpointInterval: options.checkpointInterval ?? 12,
      snapshotInterval: options.snapshotInterval ?? 24,
    });
    const peer: Peer = {
      name,
      driver,
      seat,
      identity,
      chat: [],
      heard: [],
      desyncs: [],
      ejections: [],
      violations: [],
    };
    driver.onMessage = (message, text) => {
      peer.chat.push(message);
      peer.heard.push(text);
    };
    driver.onDesync = (step, _ours, _theirs, from) => peer.desyncs.push({ step, seat: from });
    driver.onEjection = (from, atStep, reason, late) =>
      peer.ejections.push({ seat: from, atStep, reason, late });
    driver.onViolation = (_from, what) => peer.violations.push(what);
    if (isBot) peer.bot = new PeerBot({ lockstep: driver, interval: options.botInterval });
    driver.start();
    peers.push(peer);
    return peer;
  };

  identities.forEach((members, offset) => {
    members.forEach((identity, member) => {
      build(
        `e${offset + 1}m${member}`,
        identity,
        { empire: offset + 1, member },
        kinds[offset]![member] === MEMBER.BOT,
      );
    });
  });
  if (options.observer) build("observer");

  return {
    net,
    clock,
    genesis,
    gameId: genesis.gameId!,
    peers,
    awake: new Set(peers.map((peer) => peer.name)),
  };
}

/** One round of wall-clock plus enough pump/flush passes for the pipeline to
 *  drain. Peers may lead each other by up to inputDelay-1 steps, so a single
 *  pass per round would leave the table permanently one step behind itself. */
export async function run(
  t: Table,
  steps: number,
  act?: (step: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    t.clock.advance(MS_PER_STEP);
    for (let pass = 0; pass < 3; pass++) {
      for (const peer of t.peers) {
        if (!t.awake.has(peer.name)) continue;
        // A bot seat plays itself; everyone else is driven by the test.
        if (peer.bot) peer.bot.tick();
        else peer.driver.pump();
      }
      await settle(2);
      t.net.flush();
      await settle(2);
    }
    if (act) await act(i);
  }
  // Let anything still in flight land, without advancing the world further.
  for (let pass = 0; pass < 8; pass++) {
    for (const peer of t.peers) {
      if (!t.awake.has(peer.name)) continue;
      if (peer.bot) peer.bot.tick();
      else peer.driver.pump();
    }
    await settle(2);
    t.net.flush();
    await settle(2);
  }
}

export const agreed = (t: Table, only?: string[]): boolean => {
  const live = t.peers.filter((peer) => !only || only.includes(peer.name));
  const first = live[0]!.driver;
  return live.every(
    (peer) => peer.driver.step === first.step && peer.driver.hash() === first.hash(),
  );
};

/** A legal claim for this empire, found by asking the simulation rather than by
 *  guessing. Only the acting peer runs it, so it need not be deterministic. */
export function pickClaim(sim: Sim, empire: number, member: number): Move | null {
  const state = sim.state;
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] !== empire) continue;
    const x = i % state.width;
    const y = Math.floor(i / state.width);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const move: Move = {
        step: state.step,
        empire,
        member,
        seq: 0,
        type: MOVE.CLAIM,
        x: x + dx,
        y: y + dy,
      };
      if (validate(state, move)) return move;
    }
  }
  return null;
}

export async function clickAround(t: Table, every: number): Promise<(step: number) => Promise<void>> {
  return async (step: number) => {
    if (step % every !== 0) return;
    for (const peer of t.peers) {
      if (!peer.seat || peer.bot || !t.awake.has(peer.name)) continue;
      const move = pickClaim(peer.driver.sim, peer.seat.empire, peer.seat.member);
      if (move) await peer.driver.submit(MOVE.CLAIM, move.x, move.y);
    }
  };
}
