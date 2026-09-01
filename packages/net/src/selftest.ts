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
import { LoopbackNetwork, Lockstep, PeerMesh } from "./index.js";
import type { LoopbackOptions, PeerConstructor, Seat } from "./index.js";

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

async function latecomerResumesByItself(): Promise<void> {
  section("a peer arriving late resumes without being told to");
  // Snapshots every 24 steps and clicks every 30, so by the time the latecomer
  // arrives the newest snapshot is guaranteed to be a few steps behind the
  // table with moves in the gap — which is the case a stored snapshot alone
  // cannot answer, and the reason a request is served from the present.
  const t = await table({ seats: [2, 1], snapshotInterval: 24 });
  await run(t, 180, await clickAround(t, 30));

  const source = t.peers[0]!.driver;
  const stored = source.snapshots.latest()!;
  ok(
    "the newest stored snapshot is already behind the table",
    stored.step < source.step,
    `snapshot ${stored.step} vs table ${source.step}`,
  );

  // No seat: an observer is the honest shape of this test, because it isolates
  // the resume from the question of whether the table waited for it.
  const latecomer = new Lockstep({
    genesis: t.genesis,
    sim: new Sim(t.genesis),
    roster: Roster.fromGenesis(t.genesis),
    transport: t.net.connect("latecomer"),
    now: t.clock.now,
    snapshotInterval: 24,
  });
  latecomer.start();
  eq("it starts at step 0", latecomer.step, 0);

  const spin = async (rounds: number): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      t.clock.advance(MS_PER_STEP);
      for (let pass = 0; pass < 3; pass++) {
        for (const peer of t.peers) peer.driver.pump();
        latecomer.pump();
        await settle(2);
        t.net.flush();
        await settle(2);
      }
    }
  };

  // One round is enough for the request to go out and the answer to come back.
  await spin(1);
  ok(
    "it did not grind up from the beginning",
    latecomer.step > stored.step,
    `latecomer at ${latecomer.step}`,
  );

  await spin(24);
  ok(
    "it is on the table's state",
    latecomer.step === source.step && latecomer.hash() === source.hash(),
    `latecomer ${latecomer.step}/${latecomer.hash()} vs table ${source.step}/${source.hash()}`,
  );

  // The moves that were in flight when it arrived were re-sent to it alone, so
  // they must have applied exactly once. A double application would show up
  // here as a hash that agrees with nobody.
  ok("and the table still agrees with itself", agreed(t));
}

async function aReloadKeepsItsSeat(): Promise<void> {
  section("a reload rejoins with its own seat intact");
  // The seq counter lives in a Lockstep instance, so a reload starts it again
  // at zero and the returning seat honestly re-spends numbers its peers still
  // remember. Nothing about that is a contradiction, and treating it as one
  // costs an innocent player their seat and desyncs everyone who saw it.
  const t = await table({ seats: [2, 1], snapshotInterval: 24, stallTimeout: 60_000 });
  await run(t, 120, await clickAround(t, 20));

  const gone = t.peers[2]!;
  const seat = gone.seat!;
  t.awake.delete(gone.name);
  t.net.disconnect(gone.name);

  const driver = new Lockstep({
    genesis: t.genesis,
    sim: new Sim(t.genesis),
    roster: Roster.fromGenesis(t.genesis),
    transport: t.net.connect("e2m0-again"),
    identity: gone.identity,
    seat,
    now: t.clock.now,
    stallTimeout: 60_000,
    snapshotInterval: 24,
  });
  const back: Peer = {
    name: "e2m0-again",
    driver,
    seat,
    identity: gone.identity,
    chat: [],
    desyncs: [],
    ejections: [],
    violations: [],
  };
  driver.onDesync = (step, _ours, _theirs, from) => back.desyncs.push({ step, seat: from });
  driver.onEjection = (from, atStep, reason, late) =>
    back.ejections.push({ seat: from, atStep, reason, late });
  driver.onViolation = (_from, what) => back.violations.push(what);
  driver.start();
  t.peers.push(back);
  t.awake.add(back.name);

  await run(t, 24);
  eq("it is back on the table's step", driver.step, t.peers[0]!.driver.step);

  // The move that used to be the trap: a seq this seat has already spent, for
  // a slot its peers still hold under the old driver's numbering.
  ok(
    "and its move numbering restarted",
    driver.nextSeq < gone.driver.nextSeq,
    `back at ${driver.nextSeq}, was at ${gone.driver.nextSeq}`,
  );
  const claim = pickClaim(driver.sim, seat.empire, seat.member);
  ok("it has somewhere legal to click", claim !== null);
  if (claim) await driver.submit(MOVE.CLAIM, claim.x, claim.y);
  await run(t, 24, await clickAround(t, 8));

  const accused = t.peers.filter((peer) => peer.ejections.length > 0);
  ok(
    "nobody was accused of anything",
    accused.length === 0,
    accused.map((peer) => `${peer.name}:${peer.ejections[0]!.reason}`).join(" "),
  );
  ok("and the table still agrees with itself", agreed(t, [...t.awake]));
}

async function readinessSurvivesASlowSignature(): Promise<void> {
  section("a promise made while signing is renewed, not left stale");
  // Submitting a move holds readiness below the move's slot until the signature
  // is out, so a READY cannot overtake the move it is promising about. Signing
  // is asynchronous and the world does not stop for it: the peer keeps
  // simulating, and every announcement it makes in that window is capped away.
  //
  // Left there, the promise on record is stale the moment the ceiling lifts —
  // and a peer whose promise is stale blocks the peer waiting on it, which
  // stops announcing in turn. Two peers then wait on each other until the stall
  // timer ejects one of them for a fault it did not have.
  const t = await table({ seats: [1, 1], stallTimeout: 60_000 });
  await run(t, 60, await clickAround(t, 20));

  const peer = t.peers[0]!;
  const other = t.peers[1]!;
  const identity = peer.identity! as unknown as {
    sign: (payload: Uint8Array) => Promise<string>;
  };
  const realSign = identity.sign.bind(identity);
  let arming = false;
  let release = (): void => {};
  identity.sign = async (payload) => {
    if (arming) {
      arming = false;
      await new Promise<void>((resolve) => (release = resolve));
    }
    return realSign(payload);
  };

  const claim = pickClaim(peer.driver.sim, peer.seat!.empire, peer.seat!.member);
  ok("there is somewhere legal to click", claim !== null);
  arming = true;
  const pending = claim
    ? peer.driver.submit(MOVE.CLAIM, claim.x, claim.y)
    : Promise.resolve(false);

  // Long enough that the peer overruns the ceiling it is holding.
  await run(t, 12);
  const held = other.driver.step;

  release();
  await pending;

  // The promise on record must be current the moment the ceiling lifts. This is
  // the whole fix: pump() only announces after a step it actually simulated, so
  // a peer that is blocked when the ceiling lifts would otherwise sit on a
  // promise it made several steps ago, and block whoever is waiting on it.
  const promised = (peer.driver as unknown as { broadcastReady: number }).broadcastReady;
  ok(
    "the promise was renewed as soon as the signature was out",
    promised >= peer.driver.step,
    `promised ${promised}, standing at ${peer.driver.step}`,
  );

  await run(t, 60, await clickAround(t, 20));

  ok(
    "the table moved on once the signature landed",
    other.driver.step > held,
    `stuck at ${other.driver.step}, was ${held}`,
  );
  ok(
    "nobody was ejected for waiting",
    t.peers.every((each) => each.ejections.length === 0),
    t.peers.flatMap((each) => each.ejections.map((e) => `${e.reason}@${e.atStep}`)).join(" "),
  );
  // A signature held for a full second is far past the input delay, so the move
  // it was signing misses the slot it was addressed to and one peer applies
  // what the other never received. That is not what this scenario is about, and
  // it is not swept up either: the checkpoint machinery is what catches it, and
  // it does.
  ok(
    "the move it missed its slot with was noticed, not swallowed",
    t.peers.some((each) => each.desyncs.length > 0),
  );
}

// --- a channel with a ceiling ------------------------------------------------

/** PeerJS refuses an oversized JSON message outright: it raises on the *sender*
 *  and the frame simply never leaves. Its ceiling is chunkedMTU, 16300 bytes,
 *  and a snapshot of a real map is an order of magnitude past it — so PeerMesh
 *  cuts a large frame into slices and puts it back together on the far side.
 *
 *  The loopback network above has no ceiling and so exercises none of that,
 *  which is how a reassembly bug reached a browser: the slices all arrived, and
 *  the frame rebuilt from the first of them alone. This fake is the smallest
 *  thing that has the property the loopback lacks. */
const FAKE_MTU = 16_300;

type Handler = (arg: never) => void;

class Emitter {
  private readonly handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  emit(event: string, arg?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (a: unknown) => void)(arg);
  }
}

class FakeConnection extends Emitter {
  other?: FakeConnection;
  constructor(readonly peer: string) {
    super();
  }
  send(data: unknown): void {
    // Serialised before the check and again on delivery, exactly as a real
    // channel does — a mesh that accidentally shared an object with the sender
    // would otherwise pass this test and fail on the wire.
    const text = JSON.stringify(data);
    if (text.length > FAKE_MTU) throw new Error("Message too big for JSON channel");
    queueMicrotask(() => this.other?.emit("data", JSON.parse(text)));
  }
  close(): void {
    this.emit("close");
  }
}

class FakePeer extends Emitter {
  static readonly all = new Map<string, FakePeer>();
  readonly id: string;
  constructor(id?: string) {
    super();
    this.id = id ?? `peer${FakePeer.all.size}`;
    FakePeer.all.set(this.id, this);
    queueMicrotask(() => this.emit("open", this.id));
  }
  connect(to: string): FakeConnection {
    const target = FakePeer.all.get(to)!;
    const here = new FakeConnection(to);
    const there = new FakeConnection(this.id);
    here.other = there;
    there.other = here;
    queueMicrotask(() => {
      target.emit("connection", there);
      queueMicrotask(() => {
        there.emit("open");
        here.emit("open");
      });
    });
    return here;
  }
  destroy(): void {}
}

async function largeFramesCrossTheChannel(): Promise<void> {
  section("a frame larger than the channel arrives whole");
  FakePeer.all.clear();
  const PeerClass = FakePeer as unknown as PeerConstructor;
  const errors: string[] = [];
  const host = new PeerMesh(PeerClass, { onError: (e) => errors.push(e.message) });
  await host.opening;
  const guest = new PeerMesh(PeerClass, { join: host.id, onError: (e) => errors.push(e.message) });
  await guest.opening;
  await settle(4);

  const heard: Frame[] = [];
  guest.listen((_from, frame) => heard.push(frame));

  host.broadcast({ t: FRAME.BYE, reason: "small" });
  await settle(4);
  eq("a small frame arrives unsliced", heard.length, 1);

  // Ten times the ceiling, and every byte distinct, so a frame rebuilt out of
  // order or from a subset of its slices cannot happen to compare equal.
  const data = Array.from({ length: 168_000 }, (_, i) => "abcdefgh"[i % 8]!).join("");
  host.broadcast({ t: FRAME.SNAPSHOT, step: 172, hash: 42, data });
  await settle(8);

  eq("the large frame arrives too", heard.length, 2);
  const arrived = heard[1];
  ok(
    "as one snapshot, not a truncated one",
    arrived?.t === FRAME.SNAPSHOT && arrived.data === data,
    arrived?.t === FRAME.SNAPSHOT
      ? `${arrived.data.length} of ${data.length} bytes`
      : `got ${arrived?.t}`,
  );
  ok("and the sender never had a message refused", errors.length === 0, errors.join(" "));

  host.close();
  guest.close();
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
  await latecomerResumesByItself();
  await aReloadKeepsItsSeat();
  await largeFramesCrossTheChannel();
  await readinessSurvivesASlowSignature();
  await desyncIsNoticed();

  console.log(
    `\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${checks - failures}/${checks} checks passed\x1b[0m`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
