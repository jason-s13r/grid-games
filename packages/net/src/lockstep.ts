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

import { MEMBER, MOVE, STEPS_PER_SECOND } from "@tessera/sim";
import type { Genesis, MemberKind, Move, Sim } from "@tessera/sim";
import {
  CHANNEL,
  EquivocationWatch,
  FRAME,
  amendmentMove,
  endorseAmendment,
  endorseDrop,
  mergeAmendment,
  mergeDrop,
  signCheckpoint,
  openTeamBody,
  sealTeamBody,
  signMessage,
  signMove,
  signReady,
  tallyAmendment,
  verifyAmendment,
  verifyCheckpoint,
  verifyDrop,
  verifyEquivocation,
  verifyMessage,
  verifyMove,
  verifyReady,
} from "@tessera/protocol";
import type {
  Amendment,
  Channel,
  EquivocationProof,
  Frame,
  Identity,
  MemberKey,
  Message,
  Roster,
  SignedAmendment,
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
  /** Checkpoints a seat may disagree with the majority for before we propose
   *  dropping it. Counted in checkpoints rather than steps because that is the
   *  grain the evidence arrives on, and it has to leave room for the seat to
   *  notice and rebuild: at the default interval this is about twenty seconds
   *  of persistent disagreement. */
  desyncTolerance?: number;
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
/** Checkpoints of disagreement before a seat is proposed for dropping. Three
 *  is two chances to recover: the first tells it something is wrong, and a
 *  rebuild from a checkpoint lands well inside the second. */
const DEFAULT_DESYNC_TOLERANCE = 3;
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

/** How long a peer that arrived late keeps asking for the world before deciding
 *  nobody is going to hand it over.
 *
 *  Long enough to outlast a mesh forming slowly — the first request is the one
 *  most likely to go out to nobody at all, because a joiner is routinely
 *  playing before its channels have finished opening — and short enough that a
 *  peer alone in a room eventually starts playing rather than staring. */
const RESUME_PATIENCE_MS = 45_000;

/** How often a blocked peer repeats the promise it is already standing on.
 *
 *  A READY is cumulative and idempotent, so repeating one costs a signature and
 *  nothing else. It is also the only way a peer that was not connected when we
 *  last spoke ever learns what we are ready for: a full mesh takes a second hop
 *  to form, and two peers who joined a host at the same moment can easily be
 *  playing before their channel to each other has opened. Without this they
 *  wait on each other for a promise that was broadcast before either could
 *  hear it, and no stopwatch but the stall timer ever breaks it. */
const READY_REPEAT_MS = 1000;

/** How far ahead a proposed amendment is dated.
 *
 *  It has to outlast the gossip that collects the signatures, because every
 *  peer must know the outcome before it simulates the step the new seat appears
 *  on — the roster append is hashed state, and a peer that learns of it a step
 *  late has already computed a different world. Three seconds is several round
 *  trips on any connection that was going to work at all, and the cost of
 *  overshooting is only that a substitute waits a moment longer to play. */
const AMENDMENT_DELAY = STEPS_PER_SECOND * 3;

/** Sequence number the injected ROSTER_AMEND move carries.
 *
 *  Moves are applied in `(empire, member, seq)` order, so this has to be a
 *  number no signed move can also be carrying, or two peers holding the same
 *  inputs could still order them differently. Real seqs count up from zero
 *  within one driver's lifetime; nothing reaches four billion. */
const AMENDMENT_SEQ = 0xffff_ffff;

/** A proposal is given up on when the game reaches the step it named.
 *
 *  Without that, one invitation nobody answers stops the game for everyone: the
 *  hold that keeps peers from running past the step is exactly what would
 *  freeze them at it. The deadline is a step number rather than a stopwatch on
 *  purpose — every peer gives up on the same step, so giving up cannot itself
 *  become the thing peers disagree about. The three seconds of gossip before it
 *  is the window; a quorum that has not formed by then was not going to. */

/** How long a snapshot we asked for stays welcome. Long enough for a large map
 *  to cross a slow channel; short enough that a stale one arriving later is
 *  refused rather than rewinding a peer that has since recovered on its own. */
const SNAPSHOT_WAIT_MS = 10_000;

export type EjectionReason = "equivocation" | "stalled" | "desync";

const seatKey = (seat: Seat): string => `${seat.empire}:${seat.member}`;

export class Lockstep {
  readonly sim: Sim;
  readonly roster: Roster;
  readonly gameId: string;
  readonly inputDelay: number;

  onDirty?: (dirty: Set<number>) => void;
  /** Every step that actually ran, with the inputs that made it what it is.
   *
   *  `moves` is exactly what went into `sim.advance`, so replaying the
   *  concatenation of them through a fresh Sim reproduces this peer's state
   *  hash — that is the whole contract, and what `pnpm replay --log` checks.
   *
   *  `signed` is the subset that arrived over the wire, kept so a recorded log
   *  can be re-verified against the roster rather than merely believed. It is a
   *  subset because a ROSTER_AMEND move is synthesised locally from a
   *  SignedAmendment: the authority for it is the amendment's endorsements, not
   *  a signature on the move. An archive that wants to prove a log needs both,
   *  and the amendments already travel with a resume payload. */
  onApplied?: (step: number, moves: readonly Move[], signed: readonly SignedMove[]) => void;
  /** A chat line. `text` is what it says when we could read it, and null when
   *  we could not: a team message from another empire is ciphertext to us by
   *  design, and that is worth showing rather than hiding. */
  onMessage?: (message: Message, text: string | null) => void;
  onDesync?: (step: number, ours: number, theirs: number, seat: Seat) => void;
  onEjection?: (seat: Seat, atStep: number, reason: EjectionReason, late: boolean) => void;
  onStalled?: (seats: Seat[], waitedMs: number) => void;
  onViolation?: (seat: Seat, what: string) => void;
  onHalt?: (reason: string) => void;
  /** A new seat has been added to the roster and to the simulation. Fires on
   *  every peer at the same step, including on the newcomer — who by then holds
   *  the seat and can act. */
  onSeated?: (seat: Seat, key: MemberKey) => void;
  /** Somebody has proposed seating a key on our empire and it is short of a
   *  quorum. Our signature is one of the ones it is waiting for. */
  onInvitation?: (amendment: Amendment, endorsed: number, needed: number) => void;

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
  /** Checkpoint steps at which a seat disagreed with the majority, cleared the
   *  moment it agrees again. A seat that rebuilt is not a cheat. */
  private readonly disagreements = new Map<string, Set<number>>();
  /** Why this peer thinks a seat is being dropped. Local, and deliberately not
   *  in the record: a drop is agreed by majority, but the evidence that
   *  prompted it is whatever each peer happened to see, and a UI string is not
   *  worth a consensus field. */
  private readonly dropReason = new Map<string, EjectionReason>();
  private readonly drops = new Map<string, SignedDrop>();
  private readonly endorsedDrop = new Map<string, number>();
  /** Proposals in flight, keyed by empire, key and step. */
  private readonly amendments = new Map<string, SignedAmendment>();
  /** At most one endorsement per empire-and-key, ever. Two records naming
   *  different steps then cannot both reach a quorum, so the mesh cannot split
   *  over which step the newcomer's seat appeared on. */
  private readonly endorsedAmend = new Map<string, number>();
  /** Amendments that have their quorum, waiting for the step they name. */
  private readonly seating = new Map<number, SignedAmendment[]>();
  /** Amendments already applied, in the order they were applied. Sent with a
   *  snapshot, because the simulation inside one knows members by index and
   *  nothing about keys. */
  private readonly applied: SignedAmendment[] = [];
  /** Drop records this peer has acted on, for the same reason. */
  private readonly enforced: SignedDrop[] = [];

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
  /** Held below a proposed amendment's step while the vote is still out. A
   *  separate number from readyCeiling because the two overlap freely: a peer
   *  can be signing a claim while an invitation is being counted. */
  private amendCeiling = Number.MAX_SAFE_INTEGER;
  private lastBeat = -Infinity;
  private lastReadyAt = -Infinity;
  private halted: string | null = null;
  /** How long a snapshot we asked for stays welcome. Outside this window a
   *  snapshot is only adopted when it is strictly ahead of us. */
  private snapshotWantedUntil = 0;
  /** Set only at start(), when the game turns out to have begun without us:
   *  the one case where there is nothing worth simulating until it is answered. */
  private holdingForResume = false;
  private resumeDeadline = 0;
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
    // Behind the world at the moment of starting means the game began without
    // us, and the moves that built it were broadcast before we were listening:
    // nobody will send them again, so replaying from step 0 would derive a
    // state that agrees with nobody. Wait for a snapshot instead.
    //
    // The wait covers a mesh that has not finished forming, not only an
    // unanswered request. A joiner is routinely playing before its channels
    // have opened, so requiring a peer to be connected *now* would send the
    // request to nobody and give up. A host opening a room is behind its own
    // genesis by however long the lobby took and will never find anyone to ask;
    // it sits out the patience and then starts from the top, which is right.
    const behind = this.targetStep() - this.sim.step;
    if (behind > RESUME_BEHIND) {
      this.holdingForResume = true;
      this.resumeDeadline = this.now() + RESUME_PATIENCE_MS;
      if (this.transport.peers().length > 0) this.requestSnapshot(this.targetStep());
    }

    // Without this nobody ever speaks first, and every peer sits at step 0
    // waiting for a promise none of them has made.
    this.announceReady();
  }

  /** True while waiting for a snapshot of a game that started without us.
   *
   *  An unanswered request is asked again rather than given up on. The mesh
   *  takes a moment to form — two peers who joined at the same instant can be
   *  playing before their channel to each other opens — so the first request
   *  can easily go out to nobody. Replaying from step 0 instead would derive a
   *  state that agrees with nobody, because the moves that built the real one
   *  were broadcast before this peer was listening and will never be sent
   *  again. Waiting is recoverable; guessing is not. */
  private resuming(): boolean {
    if (!this.holdingForResume) return false;
    if (this.now() >= this.resumeDeadline) {
      this.holdingForResume = false; // nobody is going to answer; play from the top
      return false;
    }
    // Waiting on an outstanding request, or on a mesh that has not finished
    // forming. Either way there is nothing worth simulating yet.
    if (this.now() < this.snapshotWantedUntil) return true;
    if (this.transport.peers().length > 0) this.requestSnapshot(this.targetStep());
    return true;
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
      this.expireAmendments();
      const step = this.sim.step;
      const waiting = this.blocked(step);
      if (waiting.length > 0) {
        // Say again what we are ready for before settling in to wait. Our own
        // promise is a function of our own step and nobody else's, so being
        // blocked is no reason to let it go stale — and if the peer we are
        // waiting for is waiting on us in turn, this is the only thing that
        // breaks the deadlock without ejecting an innocent seat.
        this.announceReady();
        this.repeatReady();
        this.stalling(waiting);
        break;
      }
      this.stalledSince.clear();

      const signed = this.pending.get(step) ?? [];
      const moves = [...this.drain(step), ...this.seatArrivals(step)];
      // Before advancing: the hook describes the step about to run, and a
      // listener that throws must not leave the simulation half-stepped.
      this.onApplied?.(step, moves, signed);
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
   *  must never be able to desync a game.
   *
   *  A TEAM line is encrypted to the empire's other seats before it is signed,
   *  so what goes on the wire — and into an archive peer's copy of the log — is
   *  ciphertext to everyone but them. The signature still names the sender, so
   *  an opponent can see that somebody on empire 2 said something; only the
   *  words are private. */
  async say(body: string, channel: Channel = CHANNEL.PUBLIC): Promise<boolean> {
    const seat = this.options.seat;
    const identity = this.options.identity;
    if (!seat || !identity) return false;

    let wire = body;
    if (channel === CHANNEL.TEAM) {
      const mates = this.roster
        .membersOf(seat.empire)
        .filter((mate) => mate.member !== seat.member)
        .map((mate) => ({ member: mate.member, key: mate.key }));
      const sealed = await sealTeamBody(identity, this.gameId, seat.empire, mates, body);
      if (!sealed) return false;
      wire = sealed;
    }

    const message: Message = {
      step: this.sim.step,
      seq: this.seq++,
      empire: seat.empire,
      member: seat.member,
      channel,
      body: wire,
    };
    const signed = await signMessage(identity, this.gameId, message);
    this.transport.broadcast({ t: FRAME.MESSAGE, signed });
    // Our own line comes back as what we typed. The sender is not among its own
    // recipients, so it could not decrypt what it just sent.
    this.onMessage?.(message, body);
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

    const upTo = Math.min(
      this.sim.step + this.inputDelay - 1,
      this.readyCeiling,
      this.amendCeiling,
    );
    if (upTo <= this.broadcastReady) return;

    this.ourReady = upTo;
    this.broadcastReady = upTo;
    this.sendReady(upTo);
  }

  /** Repeat the standing promise to whoever may not have heard it.
   *
   *  Blocked is exactly the situation where this matters and exactly the
   *  situation where it is free: a peer that is waiting is not advancing, so it
   *  has nothing new to say and nothing else to spend bandwidth on. Throttled,
   *  because pump() runs on every animation frame. */
  private repeatReady(): void {
    if (this.broadcastReady < 0) return; // nothing promised yet
    const now = this.now();
    if (now - this.lastReadyAt < READY_REPEAT_MS) return;
    this.sendReady(this.broadcastReady);
  }

  private sendReady(upTo: number): void {
    const identity = this.options.identity;
    const seat = this.options.seat;
    if (!identity || !seat) return;
    this.lastReadyAt = this.now();
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
      case FRAME.AMENDMENT:
        return this.onAmendment(frame.signed);
      case FRAME.EQUIVOCATION:
        return this.onEquivocation(frame.proof);
      case FRAME.SNAPSHOT_REQUEST:
        return this.onSnapshotRequest(from, frame.step);
      case FRAME.SNAPSHOT:
        return this.onSnapshot(frame.step, frame.hash, frame.data, frame);
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
    this.onMessage?.(signed.message, await this.read(signed.message));
  }

  /** What a message says to us, or null when it does not say anything to us.
   *  Another empire's team traffic is the ordinary case, not an error. */
  private async read(message: Message): Promise<string | null> {
    if (message.channel !== CHANNEL.TEAM) return message.body;

    const seat = this.options.seat;
    const identity = this.options.identity;
    if (!seat || !identity || seat.empire !== message.empire) return null;

    const sender = this.roster.keyOf(message.empire, message.member);
    if (!sender) return null;
    return openTeamBody(
      identity,
      this.gameId,
      message.empire,
      sender,
      seat.member,
      message.body,
    );
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

    // Whether we are the odd one out, counting ourselves. A peer that
    // disagrees with everybody is far likelier to be the broken one than
    // everybody is, and a minority peer that started accusing would be
    // accusing the honest majority — so the minority rebuilds and says
    // nothing. Detection is symmetric; escalation is not.
    let agreeing = 1;
    for (const theirs of atStep.values()) if (theirs === ours) agreeing++;
    const weAreTheMajority = agreeing * 2 > atStep.size + 1;

    const tolerance = this.options.desyncTolerance ?? DEFAULT_DESYNC_TOLERANCE;

    for (const [key, theirs] of atStep) {
      const [empire, member] = key.split(":").map(Number);
      const seat: Seat = { empire: empire!, member: member! };

      if (theirs === ours) {
        // Recovered, or never broken. Either way the count starts again, and
        // a seat that later falls silent is a stall rather than a desync.
        this.disagreements.delete(key);
        this.dropReason.delete(key);
        continue;
      }

      this.desyncs++;
      this.onDesync?.(step, ours, theirs, seat);
      if (!weAreTheMajority || this.ejected.has(key)) continue;

      const at = this.disagreements.get(key) ?? new Set<number>();
      at.add(step);
      this.disagreements.set(key, at);
      // Recorded on first sight rather than when proposing, so a peer that
      // only ever endorses somebody else's proposal still says what it saw.
      this.dropReason.set(key, "desync");

      // Staggered the same way a stall proposal is, and for the same reason:
      // two proposals naming different steps could each fall short of a
      // majority and leave the seat neither dropped nor trusted. Whoever
      // speaks first is endorsed by the rest, because a peer that has
      // endorsed a drop never proposes its own.
      if (at.size >= tolerance + this.proposerRank(seat)) void this.propose(seat);
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
      if (!this.ejected.has(key)) this.enforced.push(record);
      this.eject(seat, record.drop.atStep, this.dropReason.get(key) ?? "stalled");
    }
  }

  // --- roster amendments -----------------------------------------------------

  /** Invite a key onto our own empire.
   *
   *  Not one member's decision. A quorum of the empire's existing seats has to
   *  sign the same record, or one compromised key could walk an accomplice into
   *  the team — and since teammates share territory, that is the whole game.
   *  This peer signs first and gossips; the rest has to be granted, seat by
   *  seat, by the people already holding them.
   *
   *  A single-seat empire is its own quorum, which is what lets a solo player
   *  recruit a first teammate without needing one already. */
  async amend(key: MemberKey, kind: MemberKind = MEMBER.HUMAN): Promise<boolean> {
    const seat = this.options.seat;
    if (!seat || !this.options.identity || this.halted) return false;
    if (this.roster.has(key)) return false; // already playing, somewhere

    const amendment: Amendment = {
      empire: seat.empire,
      step: this.sim.step + AMENDMENT_DELAY,
      key,
      kind,
    };
    await this.considerAmendment({ amendment, signatures: [] }, true);
    return true;
  }

  /** Add our signature to a proposal somebody else made.
   *
   *  Deliberately not automatic. Endorsing a drop is an observation — the seat
   *  did go silent, and any peer can see it — but endorsing an amendment is a
   *  decision about who joins the team, and a peer that signed whatever reached
   *  it would turn a quorum into a formality. So this is called by the player,
   *  from the invitation `onInvitation` announced.
   *
   *  The record is looked up rather than passed in, so what gets signed is the
   *  record this peer actually holds — including its step. Signing a caller's
   *  copy would let a malformed one through on a technicality. */
  async endorse(empire: number, key: MemberKey): Promise<boolean> {
    const held = this.invitation(empire, key);
    if (!held) return false;
    await this.considerAmendment(held, true);
    return true;
  }

  /** A proposal this peer is holding for that empire and key, if any. */
  invitation(empire: number, key: MemberKey): SignedAmendment | undefined {
    for (const record of this.amendments.values()) {
      if (record.amendment.empire === empire && record.amendment.key === key) return record;
    }
    return undefined;
  }

  /** Everything currently being voted on. Drives the invitation list in the UI. */
  invitations(): SignedAmendment[] {
    return [...this.amendments.values()];
  }

  private async onAmendment(signed: SignedAmendment): Promise<void> {
    if (!signed?.amendment) return;
    await this.considerAmendment(signed, false);
  }

  /** Merge, gossip what grew, and seat it when it carries.
   *
   *  Endorsements are a set, so partial tallies converge without anyone
   *  counting for everyone else: a peer that hears only half of them still ends
   *  up with the whole record, and nobody has to be the returning officer. */
  private async considerAmendment(incoming: SignedAmendment, sign: boolean): Promise<void> {
    const { empire, key, step } = incoming.amendment;
    if (this.roster.has(key)) return; // already applied, here
    // Dated in the past. The step it belongs to is spent, and a roster append
    // cannot be applied to a world that has already moved on. If it carried
    // anyway then peers who did apply it are ahead of us in a way no further
    // move will reconcile, and the honest answer is to rebuild from theirs.
    if (step <= this.sim.step) {
      const late = await tallyAmendment(this.roster, this.gameId, incoming);
      if (late.needed > 0 && late.endorsed >= late.needed) {
        this.desyncs++;
        this.requestSnapshot();
      }
      return;
    }

    const proposal = `${empire}:${key}`;
    const slot = `${proposal}@${step}`;
    const held = this.amendments.get(slot);
    let record = held ? mergeAmendment(held, incoming) : incoming;

    const identity = this.options.identity;
    const ours = this.options.seat;
    // At most one endorsement per empire-and-key, ever. Two records naming
    // different steps then cannot both reach a quorum, so the mesh cannot split
    // over which step the newcomer's seat appeared on.
    if (sign && identity && ours && ours.empire === empire && !this.endorsedAmend.has(proposal)) {
      this.endorsedAmend.set(proposal, step);
      record = mergeAmendment(record, {
        amendment: record.amendment,
        signatures: [await endorseAmendment(identity, this.gameId, record.amendment, ours.member)],
      });
    }

    const tally = await tallyAmendment(this.roster, this.gameId, record);
    // Nothing valid in it. A stranger's forgery must not be stored, gossiped,
    // or — worst of all — allowed to hold the game open at its named step.
    if (tally.needed === 0 || tally.endorsed === 0) return;

    const grew = !held || record.signatures.length > held.signatures.length;
    this.amendments.set(slot, record);
    this.hold();
    if (grew) this.transport.broadcast({ t: FRAME.AMENDMENT, signed: record });

    if (tally.endorsed >= tally.needed) {
      this.accept(record);
      return;
    }
    // Still short, and it is our empire being asked. Whoever is watching this
    // driver is one of the votes it is waiting for.
    if (grew && ours?.empire === empire && !this.endorsedAmend.has(proposal)) {
      this.onInvitation?.(record.amendment, tally.endorsed, tally.needed);
    }
  }

  /** Book a carried amendment onto the step it names. */
  private accept(signed: SignedAmendment): void {
    const step = signed.amendment.step;
    const booked = this.seating.get(step) ?? [];
    if (booked.some((held) => held.amendment.key === signed.amendment.key)) return;
    booked.push(signed);
    this.seating.set(step, booked);
    this.amendments.delete(`${signed.amendment.empire}:${signed.amendment.key}@${step}`);
    this.hold();
  }

  /** Hold readiness below the earliest undecided proposal.
   *
   *  A seat appearing in the roster is hashed state, so every peer has to know
   *  the outcome before it simulates that step — a peer that ran ahead and
   *  learned a step later has already computed a different world. Promising
   *  only up to the step before costs a moment of latency and removes the race
   *  entirely. Nothing is retracted: readiness is cumulative, and this only ever
   *  declines to promise further. */
  private hold(): void {
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const record of this.amendments.values()) {
      earliest = Math.min(earliest, record.amendment.step - 1);
    }
    this.amendCeiling = earliest;
  }

  /** Let go of a proposal nobody finished answering.
   *
   *  Called at the top of every step, so the game is parked at the step the
   *  proposal named for exactly as long as it takes to notice, and then moves
   *  on. Releasing the endorsement lock is safe here and nowhere else: the step
   *  is spent, and a seating for a spent step is one no peer will accept, so
   *  the empire can propose again without two live records for one key ever
   *  being able to both carry. */
  private expireAmendments(): void {
    if (this.amendments.size === 0) return;
    let expired = false;
    for (const [slot, record] of this.amendments) {
      if (this.sim.step < record.amendment.step) continue;
      this.amendments.delete(slot);
      this.endorsedAmend.delete(`${record.amendment.empire}:${record.amendment.key}`);
      expired = true;
    }
    if (expired) {
      this.hold();
      this.announceReady();
    }
  }

  /** The ROSTER_AMEND moves for this step, applied to the roster as they go.
   *
   *  Roster and simulation append in lockstep — the sim pushes a member, this
   *  pushes the key that authorises it — so the index the sim assigns and the
   *  index the roster assigns are the same number on every peer. The sim is
   *  asked first, because an amendment it would refuse must not seat a key that
   *  can then sign moves nothing will accept. */
  private seatArrivals(step: number): Move[] {
    const booked = this.seating.get(step);
    if (!booked) return [];
    this.seating.delete(step);
    this.hold();

    // Key order, so two amendments landing on one step are applied in the same
    // order by everyone. Nothing else about a record is guaranteed to differ.
    const moves: Move[] = [];
    booked.sort((a, b) => (a.amendment.key < b.amendment.key ? -1 : 1));
    booked.forEach((record, i) => {
      const { empire, key, kind } = record.amendment;
      if (this.roster.has(key)) return;
      const move = amendmentMove(record.amendment, AMENDMENT_SEQ + i, 0);
      if (!this.sim.validate(move)) return;
      const member = this.roster.amend(empire, key, kind, step);
      this.applied.push(record);
      moves.push(move);
      this.onSeated?.({ empire, member }, key);
      // The invitation was ours: take the seat and start playing it.
      if (this.options.identity?.key === key && !this.options.seat) {
        this.options.seat = { empire, member };
        this.seq = 0;
      }
    });
    return moves;
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
    this.disagreements.delete(key);
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
      amendments: this.applied,
      drops: this.enforced,
    });
    for (const moves of this.pending.values()) {
      for (const signed of moves) this.transport.send(from, { t: FRAME.MOVE, signed });
    }
  }

  private async onSnapshot(
    step: number,
    hash: number,
    data: string,
    roster: { amendments?: SignedAmendment[]; drops?: SignedDrop[] },
  ): Promise<void> {
    if (step === this.sim.step && this.sim.hash() === hash) return; // already there
    // Behind us, and we did not ask. Adopting it would throw away steps this
    // peer has correctly applied in order to help with someone else's rescue.
    if (step <= this.sim.step && this.now() >= this.snapshotWantedUntil) return;
    if (step < this.sim.step && this.ourHashes.get(step) === hash) return; // nothing to learn
    const buffer = decodeSnapshot(data);
    if (!buffer) return;
    // The roster first: adopting a state whose seats we cannot attribute would
    // leave us rejecting the moves of a player everyone else can see, and
    // waiting forever on one they all stopped waiting for.
    if (roster.amendments?.length) await this.catchUpRoster(roster.amendments);
    if (roster.drops?.length) await this.catchUpDrops(roster.drops);
    this.adopt(buffer, hash);
  }

  /** Re-apply the amendments behind a snapshot, checking each quorum again.
   *
   *  In order, because an empire's quorum grows as it does: a record that
   *  carried when the empire had two seats is checked against the roster as it
   *  stood then, which is what re-applying in order reconstructs. Anything that
   *  does not check out stops the walk — the records after it were verified
   *  against a roster this peer is no longer reproducing, so continuing would
   *  be guessing. */
  private async catchUpRoster(amendments: SignedAmendment[]): Promise<void> {
    for (const record of amendments) {
      const { empire, key, kind, step } = record.amendment;
      if (this.roster.has(key)) continue; // already have this one
      if (!(await verifyAmendment(this.roster, this.gameId, record))) return;
      // Checked again after the await. Verification is asynchronous and pump()
      // runs in the gap, so the step this record belongs to can be simulated —
      // and the seat added — while we are still checking the signatures on it.
      if (this.roster.has(key)) continue;
      const member = this.roster.amend(empire, key, kind, step);
      this.applied.push(record);
      this.onSeated?.({ empire, member }, key);
      if (this.options.identity?.key === key && !this.options.seat) {
        this.options.seat = { empire, member };
        this.seq = 0;
      }
    }
  }

  /** Adopt the ejections behind a snapshot, checking each quorum again.
   *
   *  Quietly: an ejection changes who this peer waits for, never what it
   *  computes, so there is nothing here to be late for and nothing to rebuild.
   *  The state being adopted already reflects every move these records stopped. */
  private async catchUpDrops(drops: SignedDrop[]): Promise<void> {
    for (const record of drops) {
      const seat: Seat = { empire: record.drop.empire, member: record.drop.member };
      if (this.ejected.has(seatKey(seat))) continue;
      if (!(await verifyDrop(this.roster, this.gameId, record))) continue;
      if (this.ejected.has(seatKey(seat))) continue; // settled while verifying
      this.enforced.push(record);
      this.ejected.set(seatKey(seat), record.drop.atStep);
      this.stalledSince.delete(seatKey(seat));
    }
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
    // Seatings the adopted state already contains, and proposals whose step it
    // has passed. Applying either now would append a member twice.
    for (const step of [...this.seating.keys()]) {
      if (step <= this.sim.step) this.seating.delete(step);
    }
    for (const [slot, record] of this.amendments) {
      if (record.amendment.step <= this.sim.step) this.amendments.delete(slot);
    }
    this.hold();
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
