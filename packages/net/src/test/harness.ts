// Six drivers in one Node process, over a loopback that serialises every frame
// exactly as a data channel would.
//
// This is Phase C's verification done as a harness rather than as two browser
// tabs and a squint. The clock is fake and delivery is explicit, so "do peers
// converge" is a deterministic check rather than a race — but everything the
// drivers do to each other is real: real signatures, real frames, real
// verification, in arrival order.

import {
  CONTROL,
  MEMBER,
  MOVE,
  STEPS_PER_SECOND,
  Sim,
  VACANCY_RULES,
  makeGenesis,
  validate,
} from "@tessera/sim";
import type { EmpireSpec, Genesis, MemberKind, Move, Rules } from "@tessera/sim";
import { Identity, Roster, sealGenesis } from "@tessera/protocol";
import type { Message } from "@tessera/protocol";
import { LoopbackNetwork, Lockstep, LocalHub, PeerBot, SocketTransport } from "../index.js";
import type { LoopbackOptions, Seat, Transport } from "../index.js";
import { SocketWorld } from "./fakesocket.js";

/** Web Crypto resolves on the event loop, and a verified frame is three
 *  promises deep. Yielding a handful of times is what makes the harness
 *  deterministic rather than merely usually right. */
export const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((done) => setImmediate(done));
  // One timer turn as well. A signature finishes on the crypto threadpool and
  // its completion lands in the poll phase; on a machine with more workers than
  // cores that can take longer than any number of setImmediate turns is worth
  // spending. Yielding to a timer gives the loop a chance to get there.
  await new Promise<void>((done) => setTimeout(done, 0));
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
  /** Set when the table is wired through a relay rather than a switch. The
   *  drivers cannot tell; `settleNetwork` has to. */
  bus?: SocketWorld;
  /** Local hubs in play, one per page that holds more than one driver. */
  hubs: LocalHub[];
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
   *  seat in a human empire, which is what a sleeping teammate looks like.
   *
   *  Declared in the genesis record here because a test wants the state, not
   *  the ceremony. In a real game an empire arrives at it by voting a bot in
   *  with ROSTER_AMEND: nobody composes somebody else's team. */
  bots?: number[];
  /** Steps between bot actions. Set it past the length of a run to seat a bot
   *  that never spends, which is how a test watches one accrue. */
  botInterval?: number;
  /** Seat each empire's bots in the same page as its first human seat, sharing
   *  one connection through a LocalHub — several drivers behind one link, which
   *  is what a page running more than one seat looks like on the wire. */
  hosted?: boolean;
  simbots?: number;
  /** Empires left unclaimed, for a test to claim. Placed after the human
   *  empires and before the SimBot ones, so a claimant's empire number is
   *  `seats.length + n` and a test can name it without counting. */
  vacancies?: number;
  observer?: boolean;
  /** Peers with a key and no seat — somebody who has arrived at the game and
   *  has not been given anything to play yet. Named `c1`, `c2`, … and the only
   *  kind of peer that can claim a vacancy: a claim is signed by the key it
   *  seats, so a claimant has to hold a key, and it seats an empty empire, so
   *  it must not already hold a seat. */
  claimants?: number;
  loopback?: LoopbackOptions;
  stallTimeout?: number;
  checkpointInterval?: number;
  /** Checkpoints of disagreement before a seat is proposed for dropping. */
  desyncTolerance?: number;
  snapshotInterval?: number;
  seed?: number;
  /** Genesis rules to override. `endStep` is the useful one: a game that ends
   *  inside a test run is the only way to watch anything downstream of victory,
   *  a ranking included. */
  rules?: Partial<Rules>;
  /** What the peers are connected by. `"socket"` puts the real `SocketTransport`
   *  and the real `RoomBus` between every pair, over a wire the test still
   *  controls — so a scenario written for a mesh runs unchanged against a relay,
   *  which is worth much more than a separate hand-written socket scenario. */
  transport?: "loopback" | "socket";
}

/** Where the harness's relay lives. A room name rather than a peer id, because
 *  that is the half of a socket ref that identifies the game. */
const BUS_REF = { kind: "socket" as const, url: "wss://relay.test/tessera", room: "harness" };

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
  for (let i = 0; i < (options.vacancies ?? 0); i++) {
    empires.push({ control: CONTROL.HUMAN, members: [] });
  }
  for (let i = 0; i < (options.simbots ?? 1); i++) {
    empires.push({ control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] });
  }

  const genesis = await sealGenesis(
    makeGenesis({
      seed: options.seed ?? 11,
      startedAt: 0,
      empires,
      map: { width: 32, height: 32 },
      // The same pairing `Lobby.host` makes: the vacancy rules travel with the
      // vacancies and never without them, so a table with none composes the
      // rules every build before this one composed. A scenario that wants a
      // different radius overrides it, as `options.rules` comes last.
      ...(options.rules || (options.vacancies ?? 0) > 0
        ? {
            rules: {
              ...((options.vacancies ?? 0) > 0 ? VACANCY_RULES : {}),
              ...options.rules,
            },
          }
        : {}),
    }),
  );

  const clock = new Clock();
  const net = new LoopbackNetwork(options.loopback);
  const peers: Peer[] = [];
  const hubs: LocalHub[] = [];

  const bus = options.transport === "socket" ? new SocketWorld() : undefined;

  /** Which driver each socket should ask for a snapshot when it comes back.
   *  The connection is necessarily older than the game it ends up carrying, so
   *  this is filled in once the driver exists. */
  const holders = new Map<Transport, { driver?: Lockstep }>();

  /** One peer's link. A socket one has to be opened and named before it can be
   *  used, which is why everything downstream of here is async. */
  const link = async (name: string): Promise<Transport> => {
    if (!bus) return net.connect(name);
    const holder: { driver?: Lockstep } = {};
    const transport = new SocketTransport(BUS_REF, {
      socket: bus.Socket,
      id: name,
      // What a real peer does, and the reason the harness does it too: the
      // outbound buffer means nothing of ours was lost across a gap, but nothing
      // replays what everyone else said while we were away. The web client and
      // every headless peer wire exactly this line.
      onReconnect: () => holder.driver?.requestSnapshot(),
    });
    holders.set(transport, holder);
    bus.settle();
    await transport.opening;
    return transport;
  };

  // One hub per empire that hosts its own bots. The empire's first seat takes
  // the hub's main port, so it keeps the connection it would have had anyway.
  const pages = new Map<number, LocalHub>();
  if (options.hosted) {
    for (const [e, empire] of kinds.entries()) {
      if (!empire.some((kind) => kind === MEMBER.BOT)) continue;
      const hub = new LocalHub(await link(`page${e + 1}`));
      hubs.push(hub);
      pages.set(e + 1, hub);
    }
  }

  const wire = async (name: string, seat?: Seat): Promise<Transport> => {
    const hub = seat ? pages.get(seat.empire) : undefined;
    return hub ? hub.port() : await link(name);
  };

  const build = async (
    name: string,
    identity?: Identity,
    seat?: Seat,
    isBot = false,
  ): Promise<Peer> => {
    const transport = await wire(name, seat);
    const driver = new Lockstep({
      genesis,
      sim: new Sim(genesis),
      roster: Roster.fromGenesis(genesis),
      transport,
      identity,
      seat,
      now: clock.now,
      stallTimeout: options.stallTimeout ?? 500,
      checkpointInterval: options.checkpointInterval ?? 12,
      ...(options.desyncTolerance === undefined
        ? {}
        : { desyncTolerance: options.desyncTolerance }),
      snapshotInterval: options.snapshotInterval ?? 24,
    });
    const holder = holders.get(transport);
    if (holder) holder.driver = driver;

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

  for (const [offset, members] of identities.entries()) {
    for (const [member, identity] of members.entries()) {
      await build(
        `e${offset + 1}m${member}`,
        identity,
        { empire: offset + 1, member },
        kinds[offset]![member] === MEMBER.BOT,
      );
    }
  }
  for (let i = 0; i < (options.claimants ?? 0); i++) {
    await build(`c${i + 1}`, await Identity.generate());
  }
  if (options.observer) await build("observer");

  return {
    net,
    ...(bus ? { bus } : {}),
    hubs,
    clock,
    genesis,
    gameId: genesis.gameId!,
    peers,
    awake: new Set(peers.map((peer) => peer.name)),
  };
}

/** Pump everyone the test is driving, once.
 *
 *  A bot seat plays itself; everyone else is driven by whatever the scenario
 *  asks for. Extra pumps let a scenario carry a peer that is not at the table,
 *  such as a latecomer resuming beside it. */
export function pumpAll(t: Table, ...extra: Array<() => void>): void {
  for (const peer of t.peers) {
    if (!t.awake.has(peer.name)) continue;
    if (peer.bot) peer.bot.tick();
    else peer.driver.pump();
  }
  for (const pump of extra) pump();
}

/** How many passes delivering nothing count as quiet. Each costs four turns of
 *  the event loop, so this is the grace a signature still in flight gets before
 *  the harness decides the network has nothing left to say. */
const IDLE_PASSES = 4;

/** Runaway guard. A scenario that genuinely will not settle should fail on its
 *  assertions rather than hang the suite. */
const MAX_PASSES = 64;

/** Pump and flush until the network goes quiet.
 *
 *  This used to be three fixed passes, which quietly made the harness depend on
 *  how fast the machine could sign. On a loaded CI runner the signatures for
 *  one step had not resolved before the next began: frames never arrived, every
 *  peer looked silent to every other, and the stall machinery ejected seats
 *  that had never been absent. Eighteen checks failed in a suite that passes on
 *  a quiet laptop every time.
 *
 *  Waiting for quiet instead of counting passes makes the harness care about
 *  what happened rather than how long it took. */
export async function settleNetwork(t: Table, ...extra: Array<() => void>): Promise<void> {
  let idle = 0;
  for (let pass = 0; pass < MAX_PASSES && idle < IDLE_PASSES; pass++) {
    pumpAll(t, ...extra);
    await settle(2);
    idle = t.net.flush() + (t.bus?.flush() ?? 0) === 0 ? idle + 1 : 0;
    await settle(2);
  }
}

/** Advance the world `steps` steps, letting each one finish before the next. */
export async function run(
  t: Table,
  steps: number,
  act?: (step: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    t.clock.advance(MS_PER_STEP);
    await settleNetwork(t);
    if (act) await act(i);
  }
  // Anything the last step's actions produced, without advancing the world.
  await settleNetwork(t);
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
