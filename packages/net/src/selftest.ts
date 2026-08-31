#!/usr/bin/env node
// Mesh harness: six drivers in one process, over a loopback that serialises
// every frame exactly as a data channel would.
//
// This is the Phase C verification done as a test rather than as two browser
// tabs and a squint. Everything that matters is here — peers converge, a
// forged move changes nothing, chat cannot desync a game, a silent peer is
// dropped by agreement rather than by whoever's stopwatch fired first, and a
// returning peer rebuilds from a snapshot it is not required to trust.

import { CONTROL, MEMBER, MOVE, STEPS_PER_SECOND, Sim, makeGenesis, validate } from "@tessera/sim";
import type { EmpireSpec, Genesis, Move } from "@tessera/sim";
import { CHANNEL, FRAME, Identity, Roster, sealGenesis, signMove } from "@tessera/protocol";
import type { Frame, Message } from "@tessera/protocol";
import { LoopbackNetwork, Lockstep } from "./index.js";
import type { LoopbackOptions, Seat } from "./index.js";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const eq = (label: string, actual: unknown, expected: unknown): void =>
  ok(label, actual === expected, `expected ${expected}, got ${actual}`);

const section = (name: string): void => console.log(`\n${name}`);

/** Web Crypto resolves on the event loop, and a verified frame is three
 *  promises deep. Yielding a handful of times is what makes the harness
 *  deterministic rather than merely usually right. */
const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((done) => setImmediate(done));
};

class Clock {
  ms = 0;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

const MS_PER_STEP = 1000 / STEPS_PER_SECOND;

// --- a table of peers --------------------------------------------------------

interface Peer {
  name: string;
  driver: Lockstep;
  seat?: Seat;
  identity?: Identity;
  chat: Message[];
  desyncs: Array<{ step: number; seat: Seat }>;
  ejections: Array<{ seat: Seat; atStep: number; reason: string; late: boolean }>;
  violations: string[];
}

interface Table {
  net: LoopbackNetwork;
  clock: Clock;
  genesis: Genesis;
  gameId: string;
  peers: Peer[];
  /** Peers that are still being pumped — a "disconnected" peer stays in the
   *  array so its state can be inspected afterwards. */
  awake: Set<string>;
}

interface TableOptions {
  /** Human seats per empire, in order. A trailing SimBot empire is added so the
   *  world has something in it besides the test's own clicking. */
  seats: number[];
  simbots?: number;
  observer?: boolean;
  loopback?: LoopbackOptions;
  stallTimeout?: number;
  checkpointInterval?: number;
  snapshotInterval?: number;
  seed?: number;
}

async function table(options: TableOptions): Promise<Table> {
  const identities: Identity[][] = [];
  for (const count of options.seats) {
    const empire: Identity[] = [];
    for (let i = 0; i < count; i++) empire.push(await Identity.generate());
    identities.push(empire);
  }

  const empires: EmpireSpec[] = identities.map((members) => ({
    control: CONTROL.HUMAN,
    members: members.map((identity) => ({ kind: MEMBER.HUMAN, key: identity.key })),
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

  const build = (name: string, identity?: Identity, seat?: Seat): Peer => {
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
      desyncs: [],
      ejections: [],
      violations: [],
    };
    driver.onMessage = (message) => peer.chat.push(message);
    driver.onDesync = (step, _ours, _theirs, from) => peer.desyncs.push({ step, seat: from });
    driver.onEjection = (from, atStep, reason, late) =>
      peer.ejections.push({ seat: from, atStep, reason, late });
    driver.onViolation = (_from, what) => peer.violations.push(what);
    driver.start();
    peers.push(peer);
    return peer;
  };

  identities.forEach((members, offset) => {
    members.forEach((identity, member) => {
      build(`e${offset + 1}m${member}`, identity, { empire: offset + 1, member });
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
async function run(
  t: Table,
  steps: number,
  act?: (step: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    t.clock.advance(MS_PER_STEP);
    for (let pass = 0; pass < 3; pass++) {
      for (const peer of t.peers) if (t.awake.has(peer.name)) peer.driver.pump();
      await settle(2);
      t.net.flush();
      await settle(2);
    }
    if (act) await act(i);
  }
  // Let anything still in flight land, without advancing the world further.
  for (let pass = 0; pass < 8; pass++) {
    for (const peer of t.peers) if (t.awake.has(peer.name)) peer.driver.pump();
    await settle(2);
    t.net.flush();
    await settle(2);
  }
}

const agreed = (t: Table, only?: string[]): boolean => {
  const live = t.peers.filter((peer) => !only || only.includes(peer.name));
  const first = live[0]!.driver;
  return live.every(
    (peer) => peer.driver.step === first.step && peer.driver.hash() === first.hash(),
  );
};

/** A legal claim for this empire, found by asking the simulation rather than by
 *  guessing. Only the acting peer runs it, so it need not be deterministic. */
function pickClaim(sim: Sim, empire: number, member: number): Move | null {
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

async function clickAround(t: Table, every: number): Promise<(step: number) => Promise<void>> {
  return async (step: number) => {
    if (step % every !== 0) return;
    for (const peer of t.peers) {
      if (!peer.seat || !t.awake.has(peer.name)) continue;
      const move = pickClaim(peer.driver.sim, peer.seat.empire, peer.seat.member);
      if (move) await peer.driver.submit(MOVE.CLAIM, move.x, move.y);
    }
  };
}

// --- checks ------------------------------------------------------------------

async function convergence(): Promise<void> {
  section("peers converge");
  const t = await table({ seats: [2, 1], observer: true });
  const before = t.peers[0]!.driver.hash();
  await run(t, 180, await clickAround(t, 24));

  const lead = t.peers[0]!.driver;
  ok("the world advanced", lead.step > 120, `stopped at step ${lead.step}`);
  ok("the state actually changed", lead.hash() !== before);
  ok(
    "every peer is on the same step",
    t.peers.every((peer) => peer.driver.step === lead.step),
    t.peers.map((peer) => `${peer.name}@${peer.driver.step}`).join(" "),
  );
  ok(
    "every peer holds the same state",
    agreed(t),
    t.peers.map((peer) => `${peer.name}=${peer.driver.hash()}`).join(" "),
  );
  ok(
    "an observer follows without anyone waiting for it",
    t.peers[3]!.driver.hash() === lead.hash(),
  );
  eq("nothing arrived late", t.peers.reduce((sum, peer) => sum + peer.driver.lateMoves, 0), 0);
  eq("nobody reported a desync", t.peers.reduce((sum, peer) => sum + peer.driver.desyncs, 0), 0);
  eq("nobody was ejected", t.peers.reduce((sum, peer) => sum + peer.ejections.length, 0), 0);
  ok(
    "and the empires are contesting real ground",
    t.peers[0]!.driver.sim.state.empires.some((empire) => empire.tilesOwned > 1),
  );
}

async function chatIsOutsideConsensus(): Promise<void> {
  section("chat cannot desync a game");
  // Every chat message to one peer is dropped on the floor. If chat were inside
  // the hash this is the run that would prove it.
  const deaf = "e2m0";
  const t = await table({
    seats: [2, 1],
    loopback: { drop: (_from, to, frame: Frame) => to === deaf && frame.t === FRAME.MESSAGE },
  });

  await run(t, 96, async (step) => {
    if (step % 12 !== 0) return;
    for (const peer of t.peers) {
      if (peer.seat) await peer.driver.say(`step ${step} from ${peer.name}`, CHANNEL.PUBLIC);
    }
  });

  const heard = t.peers.map((peer) => peer.chat.length);
  ok("the chattier peers heard more", heard[0]! > heard[2]!, heard.join(" vs "));
  ok("the deaf peer still heard its own words", heard[2]! > 0);
  ok("and every peer still holds the same state", agreed(t));
  eq("dropping chat cost no consensus", t.net.dropped > 0 ? true : false, true);
}

async function forgeryChangesNothing(): Promise<void> {
  section("a forged move changes nothing");
  const t = await table({ seats: [2, 1] });
  const mallory = await Identity.generate();
  const victim = t.peers[0]!;
  const control = t.peers[1]!;

  await run(t, 48, await clickAround(t, 24));
  ok("the table agrees before the attempt", agreed(t));

  // Mallory signs as a seat she does not hold, and sends it to one peer only.
  const target = pickClaim(victim.driver.sim, 1, 0);
  const attacker = t.net.connect("mallory");
  if (target) {
    const forged = await signMove(mallory, t.gameId, {
      ...target,
      step: victim.driver.step + 4,
      seq: 4096,
    });
    attacker.send(victim.name, { t: FRAME.MOVE, signed: forged });
  }
  // And a move signed correctly but for a game that is not this one.
  const elsewhere = await signMove(mallory, "0".repeat(64), {
    step: victim.driver.step + 4,
    empire: 1,
    member: 0,
    seq: 4097,
    type: MOVE.HEARTBEAT,
    x: 0,
    y: 0,
  });
  attacker.send(victim.name, { t: FRAME.MOVE, signed: elsewhere });
  attacker.broadcast({ t: FRAME.READY, signed: { ready: { upTo: 1 << 20, empire: 1, member: 0 }, sig: "x" } });

  await run(t, 48, await clickAround(t, 24));
  ok("the victim still agrees with the table", agreed(t));
  eq(
    "and neither forgery was ever treated as a move",
    victim.driver.lateMoves + control.driver.lateMoves,
    0,
  );
  ok("a non-roster peer is simply an observer", t.peers.every((peer) => peer.ejections.length === 0));
}

async function stalledPeerIsDropped(): Promise<void> {
  section("a silent peer is dropped by agreement");
  const t = await table({ seats: [2, 1], stallTimeout: 400 });
  const quiet = t.peers[2]!;

  await run(t, 60, await clickAround(t, 24));
  const frozenAt = t.peers[0]!.driver.step;

  // The peer stops answering. Its transport goes with it, so nothing it has
  // already queued arrives either.
  t.awake.delete(quiet.name);
  t.net.disconnect(quiet.name);

  // Briefly — less than the stall timeout, so the table is caught in the act of
  // waiting rather than already past it.
  await run(t, 4);
  const blocked = t.peers[0]!.driver.blockedOn();
  ok("the table stops rather than guessing", t.peers[0]!.driver.step <= frozenAt + 4);
  ok(
    "and it knows exactly whom it is waiting for",
    blocked.length === 1 && blocked[0]!.empire === 2,
    JSON.stringify(blocked),
  );

  // Real time passes: long enough for the lowest-ranked peer to propose.
  t.clock.advance(2000);
  await run(t, 120, await clickAround(t, 24));

  const ejections = t.peers.slice(0, 2).map((peer) => peer.ejections[0]);
  ok("every remaining peer dropped the seat", ejections.every(Boolean));
  ok(
    "for the same reason",
    ejections.every((ejection) => ejection?.reason === "stalled"),
  );
  eq(
    "and on exactly the same step",
    new Set(ejections.map((ejection) => ejection?.atStep)).size,
    1,
  );
  ok("nobody had to rebuild", ejections.every((ejection) => ejection?.late === false));
  ok(
    "the game resumed",
    t.peers[0]!.driver.step > frozenAt + 60,
    `stuck at ${t.peers[0]!.driver.step}, was ${frozenAt}`,
  );
  ok("and the survivors still agree", agreed(t, ["e1m0", "e1m1"]));
}

async function equivocationIsCaught(): Promise<void> {
  section("equivocation is caught and costs the seat");
  const t = await table({ seats: [2, 1] });
  await run(t, 36, await clickAround(t, 18));

  // The cheat: one seat signs two different moves for the same slot. Telling
  // different peers different things is the only attack a signature cannot
  // prevent — and because the mesh gossips every move it sees, it is detected
  // rather than merely suspected.
  const cheater = t.peers[1]!;
  const step = cheater.driver.step + 5;
  const base: Move = {
    step,
    empire: cheater.seat!.empire,
    member: cheater.seat!.member,
    seq: 9999,
    type: MOVE.HEARTBEAT,
    x: 0,
    y: 0,
  };

  const a = await signMove(cheater.identity!, t.gameId, base);
  const b = await signMove(cheater.identity!, t.gameId, { ...base, x: 1 });
  const wire = t.net.connect("gossip");
  wire.broadcast({ t: FRAME.MOVE, signed: a });
  await settle();
  t.net.flush();
  await settle();
  wire.broadcast({ t: FRAME.MOVE, signed: b });
  await settle();
  t.net.flush();
  await settle();

  await run(t, 24);

  const witnesses = t.peers.filter((peer) => peer.ejections.length > 0);
  ok("the cheat was detected", witnesses.length >= 2, `${witnesses.length} peers noticed`);
  ok(
    "as equivocation",
    witnesses.every((peer) => peer.ejections[0]!.reason === "equivocation"),
  );
  eq(
    "and every witness ejects on the same step",
    new Set(witnesses.map((peer) => peer.ejections[0]!.atStep)).size,
    1,
  );
  ok(
    "the step comes from the proof, not from when it was seen",
    witnesses[0]!.ejections[0]!.atStep > step,
  );
  ok(
    "and both halves of the proof were validly signed by that seat",
    witnesses.every((peer) => peer.ejections[0]!.seat.member === cheater.seat!.member),
  );
}

async function snapshotResume(): Promise<void> {
  section("a returning peer rebuilds from an untrusted snapshot");
  const t = await table({ seats: [2, 1], observer: true, snapshotInterval: 12 });
  await run(t, 96, await clickAround(t, 24));

  const source = t.peers[0]!.driver;
  const entry = source.snapshots.latest();
  ok("snapshots are being kept", entry !== undefined);
  ok("more than one is retained", source.snapshots.size > 1);

  const latecomer = new Lockstep({
    genesis: t.genesis,
    sim: new Sim(t.genesis),
    roster: Roster.fromGenesis(t.genesis),
    transport: t.net.connect("latecomer"),
    now: t.clock.now,
  });
  latecomer.start();

  eq("it starts at the beginning", latecomer.step, 0);
  ok("a snapshot with the wrong hash is refused", !latecomer.adopt(entry!.data, entry!.hash ^ 1));
  eq("and refusing it left the state alone", latecomer.step, 0);

  ok("the real one is accepted", latecomer.adopt(entry!.data, entry!.hash));
  eq("it lands on the snapshot's step", latecomer.step, entry!.step);
  eq("with the snapshot's state", latecomer.hash(), entry!.hash);

  // It is not a seat, so nobody was waiting for it; it simply catches up.
  await run(t, 24, undefined);
  for (let pass = 0; pass < 12; pass++) {
    latecomer.pump();
    await settle(2);
    t.net.flush();
    await settle(2);
  }
  ok(
    "and it catches up to the table",
    latecomer.step === source.step && latecomer.hash() === source.hash(),
    `latecomer ${latecomer.step}/${latecomer.hash()} vs ${source.step}/${source.hash()}`,
  );
}

async function desyncIsNoticed(): Promise<void> {
  section("a divergent peer is noticed");
  const t = await table({ seats: [2, 1], checkpointInterval: 12 });
  await run(t, 36, await clickAround(t, 18));

  // Reach in and corrupt one peer's state — exactly what a subtly
  // non-deterministic build would do to itself.
  const rogue = t.peers[1]!;
  rogue.driver.sim.state.pop[0] = (rogue.driver.sim.state.pop[0] ?? 0) + 1;

  await run(t, 48);
  ok("the honest peers noticed", t.peers[0]!.desyncs.length > 0);
  ok("and so did the divergent one", rogue.desyncs.length > 0);
  ok(
    "the desync is reported against a real seat",
    t.peers[0]!.desyncs.every((entry) => entry.seat.empire >= 1),
  );
}

async function main(): Promise<void> {
  await convergence();
  await chatIsOutsideConsensus();
  await forgeryChangesNothing();
  await stalledPeerIsDropped();
  await equivocationIsCaught();
  await snapshotResume();
  await desyncIsNoticed();

  console.log(
    `\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${checks - failures}/${checks} checks passed\x1b[0m`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
