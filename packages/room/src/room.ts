// The game room: the one place a game's moves are put in order.
//
// Every client runs the full simulation on its own clock and validates every
// move, so the room decides nothing about the rules. What it decides is *when*:
// a move is stamped, the moment it arrives, with a step a little ahead of now
// (LEAD_STEPS), and broadcast at once. Nothing is ever stamped below a step
// already handed out, so every step before the current lead is final, and a
// client that simulates up to "now" has every move it needs.
//
// The room acts only when a message arrives. It keeps the log and a snapshot so
// a client arriving late or coming back tomorrow can be caught up, and it runs
// its own copy of the simulation lazily, catching up to now when it needs an
// answer: for a newcomer, a hash comparison, or a seat. Between messages it
// does nothing at all, which is what lets a Durable Object hosting it sleep.
//
// It has no timer, socket or database of its own. Whatever hosts it hands it
// connections and messages, calls `tick()` at `wakeAt()` for a scheduled start,
// and supplies a store.

import {
  CONTROL,
  MEMBER,
  MOVE,
  SEAT_CEILING,
  Sim,
  durationRules,
  makeGenesis,
  minutes,
  simbot,
} from "@tessera/sim";
import type { EmpireSpec, Genesis, Move } from "@tessera/sim";
import { isVacant } from "@tessera/sim";
import type { SignedInvite } from "@tessera/protocol";
import {
  NONCE_BYTES,
  Roster,
  verifyInvite,
  cleanName,
  fromBase64Url,
  inspectGenesis,
  randomBytes,
  sealGenesis,
  toBase64Url,
  verifyHello,
  verifyMove,
} from "@tessera/protocol";
import { SNAPSHOT_EVERY, advanceTo, stepAt } from "./advance.js";
import { decode, encode } from "./messages.js";
import type {
  Catchup,
  ClientMessage,
  LobbyPlayer,
  ChatLine,
  LobbyView,
  People,
  Phase,
  RoomConfig,
  ServerMessage,
  Stamped,
  You,
} from "./messages.js";
import type { RoomStore } from "./store.js";

/** How far ahead of now a move is stamped: half a second. A client that
 *  simulates up to now therefore has half a second for a move to reach it
 *  before it is needed; one that arrives later than that is replayed. */
export const LEAD_STEPS = 6;

/** One open socket, as the host sees it. */
export interface Connection {
  readonly id: string;
  send(text: string): void;
}

export interface RoomOptions {
  now?: () => number;
}

interface Peer {
  conn: Connection;
  nonce: Uint8Array;
  key?: string;
  /** Messages from one socket are handled in arrival order, one at a time. */
  queue: Promise<void>;
}

/** A seat given after the start, in the order it was given. The roster is the
 *  genesis plus these, replayed. */
interface StoredSeating {
  empire: number;
  key: string;
  step: number;
  /** A program playing the seat. Absent in seatings stored before bots. */
  bot?: boolean;
}

interface StoredPlayer {
  key: string;
  name: string;
  empire: number | null;
  /** Said so in its hello: a program, not a person. */
  bot?: boolean;
}

/** Chat lines kept, for whoever arrives later. */
const KEEP_CHAT = 200;
/** The longest line, in characters, and the shortest gap between one
 *  speaker's lines. */
const CHAT_MAX = 500;
const CHAT_GAP_MS = 400;

/** Recent checkpoint hashes kept for comparison. */
const KEEP_CHECKPOINTS = 64;

export class Room {
  private readonly now: () => number;
  private readonly config: RoomConfig;
  private readonly peers = new Map<string, Peer>();

  private _phase: Phase;
  private players: StoredPlayer[];
  private startsAt: number | undefined;
  private starting = false;

  private genesis?: Genesis;
  private roster?: Roster;
  private sim?: Sim;
  /** The room's own simulation step. */
  private next = 0;
  /** Logged moves the room's simulation has not reached yet. */
  private future: Stamped[] = [];
  /** The highest step handed out. Nothing is stamped below it. */
  private lastStamp = 0;
  private seqs: Record<string, number>;
  private readonly beats = new Map<string, number>();
  private seatings: StoredSeating[];
  private requests: Array<{ key: string; empire: number }>;
  private usedInvites: string[];
  private chat: ChatLine[];
  private readonly spoke = new Map<string, number>();
  private readonly checkpoints = new Map<number, number>();

  /** Set up a new room's storage. The room itself is built with `new Room`. */
  static create(store: RoomStore, config: RoomConfig): void {
    if (store.get("config")) throw new Error("room already exists");
    store.put("config", config);
    store.put("phase", "lobby");
    store.put("players", []);
    if (config.startAt !== undefined) store.put("startsAt", config.startAt);
  }

  constructor(
    private readonly store: RoomStore,
    options: RoomOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const config = store.get<RoomConfig>("config");
    if (!config) throw new Error("no room in this store");
    this.config = config;
    this._phase = store.get<Phase>("phase") ?? "lobby";
    this.players = store.get<StoredPlayer[]>("players") ?? [];
    this.startsAt = store.get<number | null>("startsAt") ?? undefined;
    this.seqs = store.get<Record<string, number>>("seqs") ?? {};
    this.seatings = store.get<StoredSeating[]>("seatings") ?? [];
    this.requests = store.get<Array<{ key: string; empire: number }>>("requests") ?? [];
    this.usedInvites = store.get<string[]>("invites") ?? [];
    // Not stored on every stamp: the log's last step says the same thing.
    this.lastStamp = Math.max(store.get<number>("lastStamp") ?? 0, store.lastStep());
    this.chat = store.get<ChatLine[]>("chat") ?? [];

    const genesis = store.get<Genesis>("genesis");
    if (genesis) this.load(genesis);
  }

  get phase(): Phase {
    return this._phase;
  }

  get id(): string {
    return this.config.roomId;
  }

  get step(): number {
    return this.next;
  }

  /** The room's own state hash, for comparison in tests and tools. */
  hash(): number | undefined {
    return this.sim?.hash();
  }

  get ended(): boolean {
    return this.sim?.ended ?? false;
  }

  /** Bring the room's own simulation up to now. The room does this itself
   *  whenever it needs an answer; it is public for tools and tests. */
  catchUp(): number {
    if (this.genesis) this.advance(stepAt(this.genesis.startedAt, this.now()));
    return this.next;
  }

  /** When the room next needs a `tick()`: the scheduled start, if there is
   *  one. A running game needs none. */
  wakeAt(): number | undefined {
    return this._phase === "lobby" ? this.startsAt : undefined;
  }

  // --- connections -----------------------------------------------------------

  connect(conn: Connection): void {
    const nonce = randomBytes(NONCE_BYTES);
    this.peers.set(conn.id, { conn, nonce, queue: Promise.resolve() });
    this.sendTo(conn, { t: "challenge", nonce: toBase64Url(nonce) });
  }

  /** Take back a socket that was already open before this room object existed:
   *  a Durable Object woken from hibernation has its sockets but not their
   *  state. A socket that had proved its key keeps it; one that had not is
   *  challenged again. */
  reattach(conn: Connection, key?: string): void {
    if (!key) return this.connect(conn);
    this.peers.set(conn.id, { conn, nonce: randomBytes(NONCE_BYTES), key, queue: Promise.resolve() });
  }

  /** The key a socket has proved, if it has. A host persists this beside the
   *  socket so `reattach` can restore it. */
  keyOf(id: string): string | undefined {
    return this.peers.get(id)?.key;
  }

  disconnect(id: string): void {
    const peer = this.peers.get(id);
    this.peers.delete(id);
    if (!peer?.key) return;
    if (this._phase === "lobby") this.broadcastLobby();
    else if (!this.connectedKeys().has(peer.key)) this.broadcastPeople();
  }

  /** Handle one message from one socket. Resolves once it has been handled;
   *  messages from the same socket are handled in order. */
  receive(id: string, text: unknown): Promise<void> {
    const peer = this.peers.get(id);
    if (!peer) return Promise.resolve();
    const message = decode<ClientMessage>(text);
    if (!message) return Promise.resolve();
    peer.queue = peer.queue.then(() => this.handle(peer, message)).catch(() => {});
    return peer.queue;
  }

  private async handle(peer: Peer, message: ClientMessage): Promise<void> {
    if (message.t === "hello") return this.hello(peer, message);
    if (!peer.key) return;
    switch (message.t) {
      case "lobby":
        return this.lobbyChoice(peer.key, message);
      case "start":
        if (peer.key !== this.config.creator) return this.error(peer, "only the creator can start");
        return this.start(peer);
      case "move":
        return this.move(peer, message);
      case "hash":
        return this.compare(peer, message.step, message.hash);
      case "resume":
        if (this.genesis) this.sendTo(peer.conn, { t: "resync", game: this.catchup(message.have) });
        return;
      case "claim":
        return this.claim(peer, message.empire);
      case "ask":
        return this.ask(peer, message.empire);
      case "withdraw":
        return this.dropRequest(peer.key);
      case "approve":
        return this.answer(peer, message.key, true);
      case "decline":
        return this.answer(peer, message.key, false);
      case "redeem":
        return this.redeem(peer, message.invite);
      case "name":
        return this.rename(peer.key, message.name);
      case "say":
        return this.say(peer.key, message.channel, message.text);
    }
  }

  private async hello(peer: Peer, message: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (peer.key) return;
    const theirs = fromBase64Url(message.nonce);
    if (!theirs || theirs.length !== NONCE_BYTES || typeof message.key !== "string") {
      return this.error(peer, "malformed hello");
    }
    const ok = await verifyHello(message.key, this.config.roomId, peer.nonce, theirs, message.proof);
    if (!ok) return this.error(peer, "hello proof did not verify");

    const bot = message.bot === true ? { bot: true } : {};
    if (this._phase === "lobby") {
      peer.key = message.key;
      const name = cleanName(message.name);
      const known = this.players.find((p) => p.key === message.key);
      if (known) {
        if (name) known.name = name;
        Object.assign(known, bot);
      } else {
        this.players.push({ key: message.key, name, empire: null, ...bot });
      }
      this.store.put("players", this.players);
      this.sendTo(peer.conn, {
        t: "welcome",
        phase: "lobby",
        you: this.you(message.key),
        lobby: this.lobbyView(),
      });
      this.sendChatHistory(peer);
      this.broadcastLobby();
      return;
    }

    // The key is set after the catch-up, so this client is not sent moves it
    // has no state to apply them to.
    this.catchUp();
    peer.key = message.key;
    const name = cleanName(message.name);
    const known = this.players.find((p) => p.key === message.key);
    if (!known) this.players.push({ key: message.key, name, empire: null, ...bot });
    else {
      if (name) known.name = name;
      Object.assign(known, bot);
    }
    this.store.put("players", this.players);
    this.sendTo(peer.conn, {
      t: "welcome",
      phase: "playing",
      you: this.you(message.key),
      game: this.catchup(message.have),
    });
    this.sendChatHistory(peer);
    this.broadcastPeople();
  }

  // --- the lobby -------------------------------------------------------------

  private lobbyChoice(key: string, message: Extract<ClientMessage, { t: "lobby" }>): void {
    if (this._phase !== "lobby") return;
    const player = this.players.find((p) => p.key === key);
    if (!player) return;
    if (message.name !== undefined) player.name = cleanName(message.name);
    if (message.empire !== undefined) {
      const wanted = message.empire;
      if (wanted === null) {
        player.empire = null;
      } else if (
        Number.isInteger(wanted) &&
        wanted >= 0 &&
        wanted < this.config.empires &&
        this.players.filter((p) => p.empire === wanted && p.key !== key).length <
          this.seatsPerEmpire()
      ) {
        player.empire = wanted;
      }
    }
    this.store.put("players", this.players);
    this.broadcastLobby();
  }

  private seatsPerEmpire(): number {
    return Math.max(1, Math.min(this.config.seatsPerEmpire, SEAT_CEILING));
  }

  private lobbyView(): LobbyView {
    const online = this.connectedKeys();
    const players: LobbyPlayer[] = this.players.map((p) => ({
      ...p,
      connected: online.has(p.key),
    }));
    return {
      creator: this.config.creator,
      empires: this.config.empires,
      seatsPerEmpire: this.seatsPerEmpire(),
      bots: this.config.bots.length,
      players,
      ...(this.startsAt !== undefined ? { startsAt: this.startsAt } : {}),
    };
  }

  private broadcastLobby(): void {
    const lobby = this.lobbyView();
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, { t: "lobby", lobby });
    }
  }

  // --- starting --------------------------------------------------------------

  /** Seal the genesis record from the lobby and start the clock. `by` is the
   *  socket that asked, for error reporting; a scheduled start has none. */
  private async start(by?: Peer): Promise<void> {
    if (this._phase !== "lobby" || this.starting) return;
    this.starting = true;
    try {
      const genesis = await this.compose();
      if (typeof genesis === "string") {
        if (by) this.error(by, genesis);
        // A scheduled start that cannot happen stays a lobby, and stops trying.
        this.startsAt = undefined;
        this.store.put("startsAt", null);
        this.broadcastLobby();
        return;
      }

      this.store.put("genesis", genesis);
      this.store.put("phase", "playing");
      this._phase = "playing";
      this.load(genesis);
      this.keepSnapshot();

      for (const peer of this.peers.values()) {
        if (peer.key) {
          this.sendTo(peer.conn, { t: "start", genesis, you: this.you(peer.key), now: this.now() });
        }
      }
      this.broadcastPeople();
    } finally {
      this.starting = false;
    }
  }

  private async compose(): Promise<Genesis | string> {
    const { config } = this;
    const empires: EmpireSpec[] = [];
    for (let i = 0; i < config.empires; i++) {
      // Empires nobody picked are left open: placed by the map generator like any
      // other, and claimable during the join window.
      const members = this.players
        .filter((p) => p.empire === i)
        .map((p) => ({ kind: MEMBER.HUMAN, key: p.key }));
      empires.push({ control: CONTROL.HUMAN, members });
    }
    const claimed = empires.filter((e) => e.members.length > 0).length;
    if (claimed < 1) return "nobody has picked an empire";
    if (claimed + config.bots.length < 2) return "a game needs at least two empires playing";
    for (const level of config.bots) empires.push(simbot(level));

    const seed = new DataView(randomBytes(4).buffer).getUint32(0);
    const genesis = await sealGenesis(
      makeGenesis({
        seed,
        startedAt: this.now(),
        map: config.map,
        rules: {
          ...durationRules(config.duration, config.joinShare),
          maxSeats: this.seatsPerEmpire(),
          // Presence, as the room stamps it for a connected seat. Every beat is
          // a row in the room's log, and the only thing that needs one this
          // often is the empire list's "live" dot; abandonment is measured in
          // hours. The sim's defaults (30s, 2min) were set for a mesh where
          // every peer paid for its own beats.
          heartbeatInterval: minutes(3),
          livenessWindow: minutes(5),
        },
        empires,
      }),
    );
    const problems = await inspectGenesis(genesis);
    if (problems.length) return `the game could not be composed: ${problems.join(", ")}`;
    return genesis;
  }

  /** Build the simulation for a started game from its snapshot, with the moves
   *  logged since waiting to be simulated. It is brought up to date when an
   *  answer needs it, not here: a room woken by one message often needs none.
   *
   *  The sequence numbers and heartbeat times kept since the snapshot are
   *  recovered from those same moves, which is what lets the room write them
   *  only with the snapshot rather than on every move. */
  private load(genesis: Genesis): void {
    this.genesis = genesis;
    this.roster = Roster.fromGenesis(genesis);
    for (const seating of this.seatings) {
      this.roster.amend(seating.empire, seating.key, seating.bot ? MEMBER.BOT : MEMBER.HUMAN, seating.step);
    }
    const sim = new Sim(genesis);
    const snapshot = this.store.latestSnapshot();
    let tail: Stamped[] = [];
    if (snapshot) {
      sim.restore(snapshot.bytes.slice().buffer);
      tail = this.store.movesFrom(snapshot.step);
    }
    this.sim = sim;
    this.next = sim.step;
    this.future = tail.filter((s) => s.move.step >= sim.step);

    for (const seat of this.roster.all()) this.beats.set(seat.key, sim.step);
    for (const { move, sig } of tail) {
      const key = this.roster.keyOf(move.empire, move.member);
      if (!key) continue;
      if (move.type === MOVE.HEARTBEAT) this.beats.set(key, Math.max(this.beats.get(key) ?? 0, move.step));
      else if (sig && move.seq > (this.seqs[key] ?? -1)) this.seqs[key] = move.seq;
    }
  }

  /** The state at the room's step, and the sequence numbers that go with it. */
  private keepSnapshot(): void {
    const sim = this.sim!;
    this.store.putSnapshot({ step: sim.step, hash: sim.hash(), bytes: new Uint8Array(sim.snapshot()) });
    this.store.put("seqs", this.seqs);
  }

  // --- moves -----------------------------------------------------------------

  private async move(peer: Peer, message: Extract<ClientMessage, { t: "move" }>): Promise<void> {
    if (this._phase !== "playing" || !this.genesis || !this.roster || this.ended) return;
    const key = peer.key!;
    const seat = this.roster.seatOf(key);
    if (!seat) return this.error(peer, "you hold no seat");
    const body = message.move;
    if (!body || typeof message.sig !== "string") return;
    const { seq, type, x, y } = body;
    if (![seq, type, x, y].every((n) => Number.isInteger(n))) return;
    // A seat's own heartbeat is the room's to send, and a seat is never amended
    // by its holder.
    if (type === MOVE.HEARTBEAT || type === MOVE.ROSTER_AMEND) return;

    const move: Move = { step: 0, empire: seat.empire, member: seat.member, seq, type, x, y };
    if (!(seq > (this.seqs[key] ?? -1))) return this.error(peer, "stale seq");
    const ok = await verifyMove(this.roster, this.genesis.gameId!, { move, sig: message.sig });
    if (!ok) return this.error(peer, "move did not verify");
    // Checked again: another socket holding the same key may have spent this
    // number while the signature was being checked.
    if (!(seq > (this.seqs[key] ?? -1))) return this.error(peer, "stale seq");

    this.seqs[key] = seq;
    this.stamp([{ move, sig: message.sig }], key);
  }

  // --- the clock -------------------------------------------------------------

  /** Called by the host at `wakeAt()`: starts a scheduled game when it is due. */
  async tick(): Promise<void> {
    if (this._phase === "lobby" && this.startsAt !== undefined && this.now() >= this.startsAt) {
      await this.start();
    }
  }

  /** The lowest step a move stamped now may land on. Every step below it is
   *  final: nothing can be stamped there any more. */
  private openStep(): number {
    return Math.max(stepAt(this.genesis!.startedAt, this.now()) + LEAD_STEPS, this.lastStamp);
  }

  /** Put moves in the log at the open step, with a heartbeat for `key`'s seat
   *  if one is due, and tell everybody. */
  private stamp(moves: Stamped[], key?: string, at?: number): number {
    const step = at ?? this.openStep();
    const all = [...moves];
    const beat = key ? this.heartbeat(key, step) : undefined;
    if (beat) all.push(beat);
    if (!all.length) return step;

    for (const stamped of all) stamped.move.step = step;
    this.lastStamp = step;
    this.store.append(all);
    this.future.push(...all);

    const message: ServerMessage = { t: "moves", moves: all, now: this.now() };
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, message);
    }
    return step;
  }

  /** Simulate up to `to`, never past a step that could still receive a move. */
  private advance(to: number): void {
    const sim = this.sim;
    if (!sim || !this.genesis) return;
    const bound = Math.min(to, this.openStep());
    if (bound <= sim.step || sim.ended) return;

    const from = sim.step;
    const { checkpoints } = advanceTo(
      sim,
      bound,
      this.future.map((s) => s.move),
    );
    this.future = this.future.filter((s) => s.move.step >= sim.step);
    for (const { step, hash } of checkpoints) this.checkpoints.set(step, hash);
    for (const step of this.checkpoints.keys()) {
      if (this.checkpoints.size <= KEEP_CHECKPOINTS) break;
      this.checkpoints.delete(step);
    }

    this.next = sim.step;
    if (Math.floor(this.next / SNAPSHOT_EVERY) > Math.floor(from / SNAPSHOT_EVERY) || sim.ended) {
      this.keepSnapshot();
    }
  }

  /** A HEARTBEAT for `key`'s seat, once per heartbeat interval, issued when
   *  that seat's client says anything at all. Unsigned: presence is something
   *  the room observes, not something a seat claims. */
  private heartbeat(key: string, step: number): Stamped | undefined {
    const seat = this.roster?.seatOf(key);
    if (!seat || !this.genesis) return undefined;
    const last = this.beats.get(key);
    if (last !== undefined && step - last < this.genesis.rules.heartbeatInterval) return undefined;
    this.beats.set(key, step);
    return {
      move: { step, empire: seat.empire, member: seat.member, seq: 0, type: MOVE.HEARTBEAT, x: 0, y: 0 },
    };
  }

  // --- seats after the start -------------------------------------------------

  /** Seat `key` in `empire` with a ROSTER_AMEND the room issues under member
   *  `by` (whoever approved or invited, or 0 for an empire nobody holds), if
   *  the simulation will accept it: the join window, the seat cap and a living
   *  empire are all its rules. The amendment gets a step of its own, and the
   *  room catches up to it first, so it is judged against the state it will
   *  land in. */
  private seatNow(peer: Peer | undefined, empire: number, key: string, by: number): boolean {
    const sim = this.sim!;
    const roster = this.roster!;
    if (roster.has(key)) return false;
    const step = Math.max(this.openStep(), this.lastStamp + 1);
    this.lastStamp = step;
    this.advance(step);

    // A bot is seated as one. The simulation lets a bot seat in after the join
    // window has closed, because a bot is cover for an empire's own players
    // rather than a new player arriving.
    const bot = this.isBot(key);
    const kind = bot ? MEMBER.BOT : MEMBER.HUMAN;
    const move: Move = { step, empire, member: by, seq: 0, type: MOVE.ROSTER_AMEND, x: kind, y: 0 };
    if (sim.step !== step || !sim.validate(move)) {
      if (peer) this.error(peer, "that seat cannot be given now");
      return false;
    }
    roster.amend(empire, key, kind, step);
    this.seatings.push({ empire, key, step, ...(bot ? { bot } : {}) });
    this.requests = this.requests.filter((r) => r.key !== key);
    this.store.put("seatings", this.seatings);
    this.store.put("requests", this.requests);
    this.stamp([{ move }], undefined, step);

    for (const other of this.peers.values()) {
      if (other.key === key) this.sendTo(other.conn, { t: "seated", you: this.you(key) });
    }
    this.broadcastPeople();
    return true;
  }

  private canJoin(peer: Peer): boolean {
    if (this._phase !== "playing" || !this.sim || this.ended) return false;
    if (this.roster!.has(peer.key!)) {
      this.error(peer, "you already hold a seat");
      return false;
    }
    return true;
  }

  private isBot(key: string): boolean {
    return this.players.find((p) => p.key === key)?.bot === true;
  }

  private claim(peer: Peer, empireId: unknown): void {
    if (!this.canJoin(peer) || !Number.isInteger(empireId)) return;
    // An empire with nobody in it is a player's to take. A bot is cover for
    // people who are already there, so it comes in by invite or approval.
    if (this.isBot(peer.key!)) return this.error(peer, "a bot joins by invite or approval");
    const empire = this.sim!.state.empires[(empireId as number) - 1];
    if (!empire || !isVacant(empire) || empire.control !== CONTROL.HUMAN) {
      return this.error(peer, "that empire cannot be taken");
    }
    this.seatNow(peer, empireId as number, peer.key!, 0);
  }

  private ask(peer: Peer, empireId: unknown): void {
    if (!this.canJoin(peer) || !Number.isInteger(empireId)) return;
    const empire = this.sim!.state.empires[(empireId as number) - 1];
    if (!empire || isVacant(empire) || !empire.alive || empire.control !== CONTROL.HUMAN) {
      return this.error(peer, "that empire cannot seat anybody");
    }
    this.requests = this.requests.filter((r) => r.key !== peer.key);
    this.requests.push({ key: peer.key!, empire: empireId as number });
    this.store.put("requests", this.requests);
    this.broadcastPeople();
  }

  private dropRequest(key: string): void {
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.key !== key);
    if (this.requests.length === before) return;
    this.store.put("requests", this.requests);
    this.broadcastPeople();
  }

  /** A member of the asked-for empire says yes or no. */
  private answer(peer: Peer, key: unknown, yes: boolean): void {
    const request = this.requests.find((r) => r.key === key);
    if (!request) return;
    const seat = this.roster?.seatOf(peer.key!);
    if (!seat || seat.empire !== request.empire) return this.error(peer, "only that empire can answer");
    if (yes) this.seatNow(peer, request.empire, request.key, seat.member);
    else this.dropRequest(request.key);
  }

  private async redeem(peer: Peer, signed: SignedInvite): Promise<void> {
    if (!this.canJoin(peer) || !this.genesis) return;
    const ok = await verifyInvite(this.genesis.gameId!, signed);
    if (!ok) return this.error(peer, "that invite did not verify");
    const { invite } = signed;
    if (invite.expires * 1000 < this.now()) return this.error(peer, "that invite has expired");
    if (this.usedInvites.includes(invite.id)) return this.error(peer, "that invite has been used");
    const inviter = this.roster!.seatOf(invite.by);
    if (!inviter || inviter.empire !== invite.empire) {
      return this.error(peer, "whoever signed that invite is not in that empire");
    }
    if (this.seatNow(peer, invite.empire, peer.key!, inviter.member)) {
      this.usedInvites.push(invite.id);
      this.store.put("invites", this.usedInvites);
    }
  }

  private rename(key: string, raw: string): void {
    const name = cleanName(raw);
    const player = this.players.find((p) => p.key === key);
    if (!player || !name || player.name === name) return;
    player.name = name;
    this.store.put("players", this.players);
    if (this._phase === "lobby") this.broadcastLobby();
    else this.broadcastPeople();
  }

  // --- chat ------------------------------------------------------------------

  /** Chat is the room's to carry and nothing in the game depends on it, so it
   *  is neither signed nor stamped: a line is a line as soon as the room has
   *  it. Team lines reach the speaker's empire and nobody else. */
  private say(key: string, channel: unknown, raw: unknown): void {
    if (typeof raw !== "string") return;
    // Control characters out (bidi overrides included), whitespace collapsed.
    const text = raw
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, CHAT_MAX);
    if (!text) return;
    const now = this.now();
    if (now - (this.spoke.get(key) ?? 0) < CHAT_GAP_MS) return;
    this.spoke.set(key, now);

    const empire = this.roster?.seatOf(key)?.empire ?? 0;
    const team = channel === "team" && empire > 0;
    const line: ChatLine = {
      key,
      name: this.players.find((p) => p.key === key)?.name ?? "",
      empire,
      channel: team ? "team" : "all",
      text,
      at: now,
    };
    this.chat.push(line);
    if (this.chat.length > KEEP_CHAT) this.chat.splice(0, this.chat.length - KEEP_CHAT);
    this.store.put("chat", this.chat);
    for (const peer of this.peers.values()) {
      if (peer.key && this.hears(peer.key, line)) this.sendTo(peer.conn, { t: "chat", lines: [line] });
    }
  }

  private hears(key: string, line: ChatLine): boolean {
    if (line.channel === "all") return true;
    return this.roster?.seatOf(key)?.empire === line.empire;
  }

  private sendChatHistory(peer: Peer): void {
    const lines = this.chat.filter((line) => this.hears(peer.key!, line));
    if (lines.length) this.sendTo(peer.conn, { t: "chat", lines });
  }

  private peopleView(): People {
    const online = this.connectedKeys();
    const names = new Map(this.players.map((p) => [p.key, p.name]));
    const seen = new Set<string>();
    const people = [];
    for (const seat of this.roster?.all() ?? []) {
      seen.add(seat.key);
      people.push({
        key: seat.key,
        name: names.get(seat.key) ?? "",
        connected: online.has(seat.key),
        seat: { empire: seat.empire, member: seat.member },
        ...(seat.kind === MEMBER.BOT ? { bot: true } : {}),
      });
    }
    for (const key of online) {
      if (!seen.has(key)) people.push({ key, name: names.get(key) ?? "", connected: true });
    }
    const requests = this.requests.map((r) => ({ ...r, name: names.get(r.key) ?? "" }));
    return { people, requests };
  }

  private broadcastPeople(): void {
    if (this._phase !== "playing") return;
    const people = this.peopleView();
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, { t: "people", people });
    }
  }

  // --- catching up -----------------------------------------------------------

  /** Everything a client needs to reach `next`, from its own state when the
   *  room can vouch for it and from the snapshot otherwise. */
  private catchup(have?: { step: number; hash: number }): Catchup {
    const genesis = this.genesis!;
    const known = have ? this.checkpoints.get(have.step) : undefined;
    const usable =
      have &&
      Number.isInteger(have.step) &&
      have.step <= this.next &&
      have.step >= (this.store.latestSnapshot()?.step ?? 0) &&
      (known === undefined || known === have.hash);
    if (usable) {
      return { genesis, tail: this.store.movesFrom(have.step), upTo: this.next, now: this.now() };
    }
    const snapshot = this.store.latestSnapshot()!;
    return {
      genesis,
      snapshot: { step: snapshot.step, hash: snapshot.hash, data: toBase64Url(snapshot.bytes) },
      tail: this.store.movesFrom(snapshot.step),
      upTo: this.next,
      now: this.now(),
    };
  }

  /** A client's hash at a checkpoint. A mismatch sends it the room's state. */
  private compare(peer: Peer, step: number, hash: number): void {
    // Reports come every few seconds from every client, which makes them the
    // natural carrier for a seat's heartbeat.
    this.stamp([], peer.key);
    if (!Number.isInteger(step)) return;
    if (step > this.next) this.advance(step + 1);
    const ours = this.checkpoints.get(step);
    if (ours === undefined || ours === hash) return;
    this.sendTo(peer.conn, { t: "resync", game: this.catchup() });
  }

  // --- small things ----------------------------------------------------------

  private you(key: string): You {
    const seat = this.roster?.seatOf(key);
    return {
      key,
      ...(seat ? { seat: { empire: seat.empire, member: seat.member } } : {}),
      nextSeq: (this.seqs[key] ?? -1) + 1,
    };
  }

  private connectedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const peer of this.peers.values()) if (peer.key) keys.add(peer.key);
    return keys;
  }

  private sendTo(conn: Connection, message: ServerMessage): void {
    try {
      conn.send(encode(message));
    } catch {
      // A socket that fails to send is about to close; its disconnect cleans up.
    }
  }

  private error(peer: Peer, message: string): void {
    this.sendTo(peer.conn, { t: "error", message });
  }
}
