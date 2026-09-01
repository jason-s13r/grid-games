// The lockstep driver: moves in, agreed state out.
//
// Peers exchange inputs, never board state. Everyone runs the same simulation
// from the same genesis, so agreement is a property of the inputs rather than
// something anyone has to arbitrate. Three rules make that hold:
//
//   * A step is not simulated until every seat that could contribute to it has
//     said it will not. That is the whole of the consensus protocol.
//   * "Could contribute" is decided from the simulation, not from sockets:
//     a seat is live if its last heartbeat is inside the liveness window, which
//     is a deterministic function of the log and therefore identical on every
//     peer. Socket state is never consulted, because peers genuinely disagree
//     about who is reachable and that disagreement would become a desync.
//   * An input is bound to its step before it is sent, `inputDelay` steps
//     ahead, so a claim never has to arrive in the past.
//
// The driver holds no timer. The caller pumps it — requestAnimationFrame in a
// browser, a loop in a test — which is what makes six peers in one process a
// deterministic experiment rather than a race.

import { MOVE, STEPS_PER_SECOND } from "@tessera/sim";
import type { Genesis, Move, Sim } from "@tessera/sim";
import {
  CHANNEL,
  EquivocationWatch,
  FRAME,
  endorseDrop,
  mergeDrop,
  signCheckpoint,
  signMessage,
  signMove,
  signReady,
  verifyCheckpoint,
  verifyDrop,
  verifyEquivocation,
  verifyMessage,
  verifyMove,
  verifyReady,
} from "@tessera/protocol";
import type {
  Channel,
  EquivocationProof,
  Frame,
  Identity,
  Message,
  Roster,
  SignedDrop,
  SignedMove,
} from "@tessera/protocol";
import type { Transport } from "./transport.js";
import { SnapshotStore, decodeSnapshot, encodeSnapshot } from "./snapshots.js";

export interface Seat {
  empire: number;
  member: number;
}

export interface LockstepOptions {
  genesis: Genesis;
  sim: Sim;
  roster: Roster;
  transport: Transport;
  /** Absent means observer: it follows, verifies and archives, but holds no
   *  seat, so no other peer ever waits for it. */
  identity?: Identity;
  seat?: Seat;
  inputDelay?: number;
  checkpointInterval?: number;
  snapshotInterval?: number;
  moveHorizon?: number;
  /** Real milliseconds to wait on a silent seat before proposing that everyone
   *  stop waiting for it. */
  stallTimeout?: number;
  now?: () => number;
}

/** ~250 ms at 12 steps/s. Long enough to cross a continent, short enough that a
 *  click still feels immediate. */
const DEFAULT_INPUT_DELAY = 3;
const DEFAULT_CHECKPOINT_INTERVAL = STEPS_PER_SECOND * 5;
const DEFAULT_SNAPSHOT_INTERVAL = STEPS_PER_SECOND * 30;
/** Moves further ahead than this are discarded rather than buffered, so a peer
 *  cannot exhaust another's memory by signing a million moves for next week. */
const DEFAULT_MOVE_HORIZON = STEPS_PER_SECOND * 60;
/** A backgrounded tab must catch up without freezing the page when it returns. */
const MAX_STEPS_PER_PUMP = 240;
/** Steps between an equivocation and the seat falling silent. Derived from the
 *  proof rather than from when a peer happened to see it, so every peer ejects
 *  on exactly the same step. */
const EJECTION_DELAY = STEPS_PER_SECOND * 4;
/** How long a seat may say nothing before a drop is proposed. Generous: a
 *  reconnecting phone should not cost someone their seat. */
const DEFAULT_STALL_TIMEOUT = 15_000;

/** How far behind wall-clock time a peer may be at start() and still treat
 *  itself as starting fresh rather than arriving late.
 *
 *  The gap is not a performance question, it is a correctness one: nobody sent
 *  moves to a client that was not connected, so a peer behind by more than a
 *  round trip is missing inputs it can never obtain, and replaying up from step
 *  zero derives a state that agrees with nobody. Two seconds is slack for the
 *  round trip that adopting a genesis costs and for clock skew between peers,
 *  and nothing more. */
const RESUME_BEHIND = STEPS_PER_SECOND * 2;

/** How long a snapshot we asked for stays welcome. Long enough for a large map
 *  to cross a slow channel; short enough that a stale one arriving later is
 *  refused rather than rewinding a peer that has since recovered on its own. */
const SNAPSHOT_WAIT_MS = 10_000;

export type EjectionReason = "equivocation" | "stalled";

const seatKey = (seat: Seat): string => `${seat.empire}:${seat.member}`;

export class Lockstep {
  readonly sim: Sim;
  readonly roster: Roster;
  readonly gameId: string;
  readonly inputDelay: number;

  onDirty?: (dirty: Set<number>) => void;
  onMessage?: (message: Message) => void;
  onDesync?: (step: number, ours: number, theirs: number, seat: Seat) => void;
  onEjection?: (seat: Seat, atStep: number, reason: EjectionReason, late: boolean) => void;
  onStalled?: (seats: Seat[], waitedMs: number) => void;
  onViolation?: (seat: Seat, what: string) => void;
  onHalt?: (reason: string) => void;

  private readonly options: LockstepOptions;
  private readonly transport: Transport;
  private readonly now: () => number;

  private readonly pending = new Map<number, SignedMove[]>();
  private readonly readyBy = new Map<string, number>();
  private readonly ejected = new Map<string, number>();
  private readonly ourHashes = new Map<number, number>();
  private readonly claims = new Map<number, Map<string, number>>();
  private readonly watch = new EquivocationWatch();
  /** Wall-clock, and deliberately never consulted when deciding what to
   *  simulate. It only decides when to *propose* a drop; what the drop does is
   *  fixed by the record, so peers with disagreeing stopwatches still stop
   *  waiting on the same step. */
  private readonly stalledSince = new Map<string, number>();
  private readonly drops = new Map<string, SignedDrop>();
  private readonly endorsedDrop = new Map<string, number>();
  readonly snapshots = new SnapshotStore();

  /** One serial lane per peer. Verification is asynchronous, and a READY that
   *  overtook the move it was promising about would let this peer advance past
   *  a step whose input had not arrived — a desync produced entirely by our own
   *  scheduling. Frames from one peer are therefore verified in arrival order. */
  private readonly lanes = new Map<string, Promise<void>>();

  private seq = 0;
  private ourReady = -1;
  private broadcastReady = -1;
  /** While a move is being signed its slot is reserved: readiness must not
   *  climb past a step we are about to speak for. */
  private readyCeiling = Number.MAX_SAFE_INTEGER;
  private lastBeat = -Infinity;
  private halted: string | null = null;
  /** How long a snapshot we asked for stays welcome. Outside this window a
   *  snapshot is only adopted when it is strictly ahead of us. */
  private snapshotWantedUntil = 0;
  /** Set only at start(), when the game turns out to have begun without us:
   *  the one case where there is nothing worth simulating until it is answered. */
  private holdingForResume = false;
  private unlisten?: () => void;

  lateMoves = 0;
  desyncs = 0;

  constructor(options: LockstepOptions) {
    this.options = options;
    this.sim = options.sim;
    this.roster = options.roster;
    this.transport = options.transport;
    this.gameId = options.genesis.gameId ?? "";
    this.inputDelay = options.inputDelay ?? DEFAULT_INPUT_DELAY;
    this.now = options.now ?? (() => Date.now());
  }

  get seat(): Seat | undefined {
    return this.options.seat;
  }

  get step(): number {
    return this.sim.step;
  }

  /** The number the next move from this seat will carry. It counts within one
   *  driver, not within a seat's whole career: a reload builds a new driver and
   *  starts again at zero, which is why the equivocation slot is keyed on the
   *  step as well as on this. */
  get nextSeq(): number {
    return this.seq;
  }

  get stopped(): string | null {
    return this.halted;
  }

  hash(): number {
    return this.sim.hash();
  }

  start(): void {
    this.unlisten = this.transport.listen((from, frame) => this.receive(from, frame));
    this.checkpoint(this.sim.step);

    // Arriving to a game already in progress. Simulating up from step 0 would
    // spend minutes deriving a state any peer can hand over in one message, and
    // would spend those minutes broadcasting checkpoints that disagree with
    // every one of them. Ask first, and hold the simulation until the answer
    // lands or the wait runs out.
    //
    // The request names the wall-clock step rather than ours, because a peer
    // answers with the most recent snapshot it holds at or before the step it
    // is asked for — and ours is the one number known to be too old.
    // Holding is only worth anything when somebody is there to answer. A host
    // opening a room is behind its own genesis by however long the lobby took,
    // and has nobody to ask, so it would sit out the whole wait and then
    // simulate from step 0 regardless — which is the right answer for it.
    const behind = this.targetStep() - this.sim.step;
    if (behind > RESUME_BEHIND && this.transport.peers().length > 0) {
      this.holdingForResume = true;
      this.requestSnapshot(this.targetStep());
    }

    // Without this nobody ever speaks first, and every peer sits at step 0
    // waiting for a promise none of them has made.
    this.announceReady();
  }

  /** True while waiting for a snapshot of a game that started without us. */
  private resuming(): boolean {
    if (!this.holdingForResume) return false;
    if (this.now() < this.snapshotWantedUntil) return true;
    this.holdingForResume = false; // nobody answered; replay from step 0 instead
    return false;
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = undefined;
  }

  /** The step the world should be at. Derived from genesis rather than from
   *  when this peer opened the page: the world turns whether or not anyone is
   *  watching, and two peers that started hours apart must agree on what time
   *  it is. */
  targetStep(): number {
    const elapsed = this.now() - this.options.genesis.startedAt;
    return Math.max(0, Math.floor((elapsed * STEPS_PER_SECOND) / 1000));
  }

  /** Seats this peer is waiting on. Drives the "waiting for Dave" line in the
   *  UI, and is empty whenever the game is keeping up. */
  blockedOn(): Seat[] {
    return this.blocked(this.sim.step);
  }

  /** Advance as far as the clock and the inputs allow. Returns the tiles the
   *  renderer must repaint. */
  pump(): Set<number> {
    const dirty = new Set<number>();
    if (this.halted || this.sim.ended || this.resuming()) return dirty;

    const target = this.targetStep();
    let budget = MAX_STEPS_PER_PUMP;

    while (this.sim.step < target && budget-- > 0) {
      const step = this.sim.step;
      const waiting = this.blocked(step);
      if (waiting.length > 0) {
        // Say again what we are ready for before settling in to wait. Our own
        // promise is a function of our own step and nobody else's, so being
        // blocked is no reason to let it go stale — and if the peer we are
        // waiting for is waiting on us in turn, this is the only thing that
        // breaks the deadlock without ejecting an innocent seat.
        this.announceReady();
        this.stalling(waiting);
        break;
      }
      this.stalledSince.clear();

      const moves = this.drain(step);
      for (const index of this.sim.advance(moves)) dirty.add(index);

      this.checkpoint(this.sim.step);
      this.beat();
      this.announceReady();
    }

    if (dirty.size > 0) this.onDirty?.(dirty);
    return dirty;
  }

  // --- outbound --------------------------------------------------------------

  /** Queue one of this peer's own inputs. Returns false when there is no seat,
   *  or when the simulation would reject it — that check is UI feedback only;
   *  the authoritative one runs on every peer when the step is simulated. */
  async submit(type: Move["type"], x = 0, y = 0): Promise<boolean> {
    const seat = this.options.seat;
    const identity = this.options.identity;
    if (!seat || !identity || this.halted) return false;

    const slot = Math.max(this.sim.step + this.inputDelay, this.ourReady + 1);
    const move: Move = { step: slot, empire: seat.empire, member: seat.member, seq: this.seq, type, x, y };

    if (type !== MOVE.HEARTBEAT && !this.sim.validate({ ...move, step: this.sim.step })) {
      return false;
    }

    this.seq++;
    // Hold readiness below the slot until the signed move is actually out, or a
    // READY could overtake it and invite every peer past the step it belongs to.
    this.readyCeiling = slot - 1;
    try {
      const signed = await signMove(identity, this.gameId, move);
      this.stash(signed);
      this.transport.broadcast({ t: FRAME.MOVE, signed });
      return true;
    } finally {
      this.readyCeiling = Number.MAX_SAFE_INTEGER;
      // Signing is asynchronous, and the world does not stop for it: this peer
      // may have simulated several steps while the ceiling was down, and every
      // announcement it tried to make in that window was capped away. The
      // promise on record is therefore stale the instant the ceiling lifts, and
      // nothing else will refresh it — pump() only announces after a step it
      // actually simulated, and a peer whose promise is stale is about to be
      // blocked and stop simulating.
      this.announceReady();
    }
  }

  /** Chat. Signed and ordered like everything else, and deliberately outside
   *  the state hash: a message that arrives late, out of order or not at all
   *  must never be able to desync a game. */
  async say(body: string, channel: Channel = CHANNEL.PUBLIC): Promise<boolean> {
    const seat = this.options.seat;
    const identity = this.options.identity;
    if (!seat || !identity) return false;

    const message: Message = {
      step: this.sim.step,
      seq: this.seq++,
      empire: seat.empire,
      member: seat.member,
      channel,
      body,
    };
    const signed = await signMessage(identity, this.gameId, message);
    this.transport.broadcast({ t: FRAME.MESSAGE, signed });
    this.onMessage?.(message);
    return true;
  }

  private beat(): void {
    const interval = this.options.genesis.rules.heartbeatInterval;
    if (!this.options.seat || this.sim.step - this.lastBeat < interval) return;
    this.lastBeat = this.sim.step;
    void this.submit(MOVE.HEARTBEAT);
  }

  /** One cumulative assertion instead of a PASS per seat per step. */
  private announceReady(): void {
    const identity = this.options.identity;
    const seat = this.options.seat;
    if (!identity || !seat) return;

    const upTo = Math.min(this.sim.step + this.inputDelay - 1, this.readyCeiling);
    if (upTo <= this.broadcastReady) return;

    this.ourReady = upTo;
    this.broadcastReady = upTo;
    void signReady(identity, this.gameId, { upTo, empire: seat.empire, member: seat.member }).then(
      (signed) => this.transport.broadcast({ t: FRAME.READY, signed }),
    );
  }

  private checkpoint(step: number): void {
    const interval = this.options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    if (step % interval === 0 && !this.ourHashes.has(step)) {
      const hash = this.sim.hash();
      this.ourHashes.set(step, hash);
      this.compare(step);

      const identity = this.options.identity;
      const seat = this.options.seat;
      if (identity && seat) {
        void signCheckpoint(identity, this.gameId, {
          step,
          hash,
          empire: seat.empire,
          member: seat.member,
        }).then((signed) => this.transport.broadcast({ t: FRAME.CHECKPOINT, signed }));
      }
      this.forget(step);
    }

    const snapshotInterval = this.options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
    if (step % snapshotInterval === 0) {
      this.snapshots.put({ step, hash: this.sim.hash(), data: this.sim.snapshot() });
    }
  }

  // --- inbound ---------------------------------------------------------------

  private receive(from: string, frame: Frame): void {
    const lane = this.lanes.get(from) ?? Promise.resolve();
    const next = lane.then(() => this.handle(from, frame)).catch(() => undefined);
    this.lanes.set(from, next);
  }

  private async handle(from: string, frame: Frame): Promise<void> {
    switch (frame.t) {
      case FRAME.MOVE:
        return this.onMove(frame.signed);
      case FRAME.READY:
        return this.onReady(frame.signed);
      case FRAME.MESSAGE:
        return this.onChat(frame.signed);
      case FRAME.CHECKPOINT:
        return this.onCheckpoint(frame.signed);
      case FRAME.DROP:
        return this.onDrop(frame.signed);
      case FRAME.EQUIVOCATION:
        return this.onEquivocation(frame.proof);
      case FRAME.SNAPSHOT_REQUEST:
        return this.onSnapshotRequest(from, frame.step);
      case FRAME.SNAPSHOT:
        return this.onSnapshot(frame.step, frame.hash, frame.data);
      default:
        // Handshake and genesis frames belong to the session that built this
        // driver; by the time it exists they have already been settled.
        return;
    }
  }

  private async onMove(signed: SignedMove): Promise<void> {
    if (!(await verifyMove(this.roster, this.gameId, signed))) return;

    const seat: Seat = { empire: signed.move.empire, member: signed.move.member };
    const key = seatKey(seat);

    const conflict = this.watch.record(signed);
    if (conflict) {
      const proof: EquivocationProof = { a: conflict, b: signed };
      this.transport.broadcast({ t: FRAME.EQUIVOCATION, proof });
      await this.onEquivocation(proof);
      return;
    }

    const ejectAt = this.ejected.get(key);
    if (ejectAt !== undefined && signed.move.step >= ejectAt) return;

    // Strictly less than: sim.step is the step about to be simulated, and a
    // move for it is exactly on time. A peer may legitimately run inputDelay
    // steps ahead of a sender, which puts its next step and the sender's slot
    // on the same number — treating that as late would drop a valid move and
    // manufacture the desync it was meant to catch.
    if (signed.move.step < this.sim.step) {
      // Either the sender broke its own readiness promise or this peer advanced
      // when it should not have. Both are consensus failures, not lost packets.
      this.lateMoves++;
      this.onViolation?.(seat, "move for a step already simulated");
      return;
    }
    if (signed.move.step > this.sim.step + (this.options.moveHorizon ?? DEFAULT_MOVE_HORIZON)) {
      this.onViolation?.(seat, "move too far in the future");
      return;
    }
    if (signed.move.step <= (this.readyBy.get(key) ?? -1)) {
      this.onViolation?.(seat, "move at a step it had declared itself done with");
      return;
    }

    this.stash(signed);
  }

  private async onReady(signed: { ready: { upTo: number; empire: number; member: number }; sig: string }): Promise<void> {
    if (!(await verifyReady(this.roster, this.gameId, signed))) return;
    const key = seatKey(signed.ready);
    // Cumulative: a stale one that arrives out of order changes nothing.
    this.readyBy.set(key, Math.max(this.readyBy.get(key) ?? -1, signed.ready.upTo));
  }

  private async onChat(signed: { message: Message; sig: string }): Promise<void> {
    if (!(await verifyMessage(this.roster, this.gameId, signed))) return;
    this.onMessage?.(signed.message);
  }

  private async onCheckpoint(signed: {
    checkpoint: { step: number; hash: number; empire: number; member: number };
    sig: string;
  }): Promise<void> {
    if (!(await verifyCheckpoint(this.roster, this.gameId, signed))) return;
    const { step, hash, empire, member } = signed.checkpoint;

    let atStep = this.claims.get(step);
    if (!atStep) {
      atStep = new Map();
      this.claims.set(step, atStep);
    }
    atStep.set(seatKey({ empire, member }), hash);
    this.compare(step);
  }

  private compare(step: number): void {
    const ours = this.ourHashes.get(step);
    const atStep = this.claims.get(step);
    if (ours === undefined || !atStep) return;

    for (const [key, theirs] of atStep) {
      if (theirs === ours) continue;
      this.desyncs++;
      const [empire, member] = key.split(":").map(Number);
      this.onDesync?.(step, ours, theirs, { empire: empire!, member: member! });
    }
  }

  /** The proof carries its own evidence, so a recipient checks the accusation
   *  from scratch rather than trusting whoever forwarded it. */
  private async onEquivocation(proof: EquivocationProof): Promise<void> {
    if (!(await verifyEquivocation(this.roster, this.gameId, proof))) return;

    // Derived from the proof, never from when this peer saw it: two peers that
    // learn of the same cheat at different moments still stop listening on the
    // same step, so ejection costs no agreement.
    this.eject(
      { empire: proof.a.move.empire, member: proof.a.move.member },
      Math.max(proof.a.move.step, proof.b.move.step) + EJECTION_DELAY,
      "equivocation",
    );
  }

  // --- stalls ----------------------------------------------------------------

  /** A silent seat freezes the game, and no local timer may unfreeze it: two
   *  peers whose stopwatches disagree would resume on different steps, which is
   *  a desync manufactured to fix a stall.
   *
   *  So the timeout only decides when to *propose*. Proposals are staggered by
   *  seat order so exactly one peer speaks first — a race between two proposals
   *  naming different steps could otherwise leave both short of a majority and
   *  the game stuck for good. */
  private stalling(waiting: Seat[]): void {
    const timeout = this.options.stallTimeout ?? DEFAULT_STALL_TIMEOUT;
    const now = this.now();
    let longest = 0;

    for (const seat of waiting) {
      const key = seatKey(seat);
      const since = this.stalledSince.get(key) ?? now;
      this.stalledSince.set(key, since);
      longest = Math.max(longest, now - since);

      if (now - since >= timeout * (this.proposerRank(seat) + 1)) void this.propose(seat);
    }

    if (longest > 0) this.onStalled?.(waiting, longest);
  }

  /** Our position among the seats entitled to propose, lowest first. Rank n
   *  waits n extra timeouts, so a proposer that is itself unreachable delays the
   *  drop rather than preventing it. */
  private proposerRank(target: Seat): number {
    const ours = this.options.seat;
    if (!ours) return Number.MAX_SAFE_INTEGER; // an observer proposes nothing
    const eligible = this.roster
      .all()
      .filter((seat) => seatKey(seat) !== seatKey(target) && !this.ejected.has(seatKey(seat)))
      .sort((a, b) => a.empire - b.empire || a.member - b.member);
    const at = eligible.findIndex((seat) => seatKey(seat) === seatKey(ours));
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  }

  private async propose(target: Seat): Promise<void> {
    const key = seatKey(target);
    if (this.ejected.has(key) || this.endorsedDrop.has(key)) return;
    await this.consider({ drop: { ...target, atStep: this.sim.step }, signatures: [] });
  }

  private async onDrop(signed: SignedDrop): Promise<void> {
    if (!signed?.drop) return;
    await this.consider(signed);
  }

  /** Endorse at most one record per seat, ever. Two records naming different
   *  steps then cannot both reach a strict majority, so the mesh cannot split
   *  over when the drop took effect. Endorsements merge as a set, so a partial
   *  tally spreads without anyone coordinating the count. */
  private async consider(incoming: SignedDrop): Promise<void> {
    const seat: Seat = { empire: incoming.drop.empire, member: incoming.drop.member };
    const key = seatKey(seat);
    if (this.ejected.has(key)) return;
    if (!this.roster.keyOf(seat.empire, seat.member)) return;

    const slot = `${key}@${incoming.drop.atStep}`;
    const held = this.drops.get(slot);
    let record = held ? mergeDrop(held, incoming) : incoming;

    const identity = this.options.identity;
    const ours = this.options.seat;
    const endorsed = this.endorsedDrop.get(key);
    if (identity && ours && seatKey(ours) !== key && endorsed === undefined) {
      this.endorsedDrop.set(key, incoming.drop.atStep);
      record = mergeDrop(record, {
        drop: record.drop,
        signatures: [await endorseDrop(identity, this.gameId, record.drop, ours)],
      });
    }

    const grew = !held || record.signatures.length > held.signatures.length;
    this.drops.set(slot, record);
    if (grew) this.transport.broadcast({ t: FRAME.DROP, signed: record });

    if (await verifyDrop(this.roster, this.gameId, record)) {
      this.eject(seat, record.drop.atStep, "stalled");
    }
  }

  /** Stop waiting for a seat, and stop accepting its moves, from exactly
   *  `atStep`. The seat is out for the rest of the game: a returning player is
   *  seated again by ROSTER_AMEND at a fresh index, because "resume waiting for
   *  them once they are back" would depend on when each peer noticed, which is
   *  precisely the kind of local judgement this design keeps out of the log. */
  private eject(seat: Seat, atStep: number, reason: EjectionReason): void {
    const key = seatKey(seat);
    if (this.ejected.has(key)) return;

    this.ejected.set(key, atStep);
    this.stalledSince.delete(key);
    for (const [step, moves] of this.pending) {
      if (step >= atStep) this.pending.set(step, moves.filter((m) => seatKey(m.move) !== key));
    }

    // Past the ejection step this peer has already applied moves its peers are
    // about to drop. That is a divergence, and the honest response is to rebuild
    // from a checkpoint rather than to carry on and hope.
    // sim.step is the next step to simulate, so equality is not yet a problem:
    // only a step already applied can have been applied wrongly.
    const late = this.sim.step > atStep;
    this.onEjection?.(seat, atStep, reason, late);
    if (late) this.requestSnapshot();
  }

  /** Answer with the present, not with an archive.
   *
   *  A stored snapshot is only useful to someone who also holds every move
   *  between it and now — and a peer that has just arrived holds none of them,
   *  because they were broadcast before it was listening. So the reply is the
   *  state as of the last step this peer simulated, plus the moves it still has
   *  pending for the steps after it. Those two together are the whole game.
   *
   *  Sent to the asker alone. A snapshot is the largest message the mesh ever
   *  carries, nobody else asked for it, and re-sending pending moves to a peer
   *  that already has them is how a move gets applied twice.
   *
   *  The step in the request is advisory. A peer rebuilding from a desync wants
   *  a correct state, not an old one — and this peer's newest is the most
   *  correct thing it has to offer. Rewinding it to an archived checkpoint would
   *  only oblige it to replay the very moves it may have applied wrongly. */
  private onSnapshotRequest(from: string, _step: number): void {
    this.transport.send(from, {
      t: FRAME.SNAPSHOT,
      step: this.sim.step,
      hash: this.sim.hash(),
      data: encodeSnapshot(this.sim.snapshot()),
    });
    for (const moves of this.pending.values()) {
      for (const signed of moves) this.transport.send(from, { t: FRAME.MOVE, signed });
    }
  }

  private async onSnapshot(step: number, hash: number, data: string): Promise<void> {
    if (step === this.sim.step && this.sim.hash() === hash) return; // already there
    // Behind us, and we did not ask. Adopting it would throw away steps this
    // peer has correctly applied in order to help with someone else's rescue.
    if (step <= this.sim.step && this.now() >= this.snapshotWantedUntil) return;
    if (step < this.sim.step && this.ourHashes.get(step) === hash) return; // nothing to learn
    const buffer = decodeSnapshot(data);
    if (!buffer) return;
    this.adopt(buffer, hash);
  }

  /** Safe from anyone: restore it, hash it, and put the old state back if the
   *  number disagrees. The hash is the proof, which is exactly what lets an
   *  untrusted archive peer be useful without being trusted. */
  adopt(buffer: ArrayBuffer, expected: number): boolean {
    const backup = this.sim.snapshot();
    try {
      this.sim.restore(buffer);
      if (this.sim.hash() !== expected) {
        this.sim.restore(backup);
        return false;
      }
    } catch {
      this.sim.restore(backup);
      return false;
    }

    for (const step of [...this.pending.keys()]) {
      if (step <= this.sim.step) this.pending.delete(step);
    }
    this.holdingForResume = false;
    this.snapshotWantedUntil = 0;
    this.ourHashes.clear();
    this.ourReady = -1;
    this.broadcastReady = -1;
    this.lastBeat = -Infinity;
    this.checkpoint(this.sim.step);
    this.announceReady();
    return true;
  }

  requestSnapshot(step = this.sim.step): void {
    this.snapshotWantedUntil = this.now() + SNAPSHOT_WAIT_MS;
    this.transport.broadcast({ t: FRAME.SNAPSHOT_REQUEST, step });
  }

  halt(reason: string): void {
    if (this.halted) return;
    this.halted = reason;
    this.onHalt?.(reason);
  }

  // --- bookkeeping -----------------------------------------------------------

  private stash(signed: SignedMove): void {
    const list = this.pending.get(signed.move.step);
    if (!list) {
      this.pending.set(signed.move.step, [signed]);
      return;
    }
    // The same move can reach this peer twice: a peer answering a snapshot
    // request re-sends everything it still holds, and some of that may already
    // be here. Applying one move twice is a desync, so a slot is claimed once.
    // Equivocation is not the concern — a second move in a claimed slot that
    // differs was already caught and proved before it reached this point.
    const slot = `${signed.move.empire}:${signed.move.member}:${signed.move.seq}`;
    const taken = list.some(
      (held) => `${held.move.empire}:${held.move.member}:${held.move.seq}` === slot,
    );
    if (!taken) list.push(signed);
  }

  private drain(step: number): Move[] {
    const list = this.pending.get(step);
    this.pending.delete(step);
    return list ? list.map((signed) => signed.move) : [];
  }

  private isOurs(seat: Seat): boolean {
    const ours = this.options.seat;
    return !!ours && ours.empire === seat.empire && ours.member === seat.member;
  }

  /** Liveness from the log, never from the socket. */
  private live(seat: Seat): boolean {
    const empire = this.sim.state.empires[seat.empire - 1];
    const member = empire?.members[seat.member];
    if (!member) return false;
    return this.sim.state.step - member.lastBeat <= this.options.genesis.rules.livenessWindow;
  }

  private blocked(step: number): Seat[] {
    const waiting: Seat[] = [];
    for (const seat of this.roster.all()) {
      if (this.isOurs(seat)) continue;
      const key = seatKey(seat);
      const ejectAt = this.ejected.get(key);
      if (ejectAt !== undefined && step >= ejectAt) continue;
      if (!this.live(seat)) continue;
      if ((this.readyBy.get(key) ?? -1) >= step) continue;
      waiting.push(seat);
    }
    return waiting;
  }

  private forget(before: number): void {
    const horizon = (this.options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL) * 8;
    for (const step of this.ourHashes.keys()) {
      if (step < before - horizon) this.ourHashes.delete(step);
    }
    for (const step of this.claims.keys()) {
      if (step < before - horizon) this.claims.delete(step);
    }
    this.watch.forget(before - horizon);
  }
}
