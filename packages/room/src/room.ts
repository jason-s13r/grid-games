// The game room: the one place a game's moves are put in order.
//
// Every client runs the full simulation and validates every move, so the room
// decides nothing about the rules. What it decides is *when*: each move is
// stamped with the step it lands on, and a step is final once the room has said
// so. It also keeps the log and a snapshot, so a client arriving late or coming
// back tomorrow can be caught up, and it heartbeats for connected seats so the
// abandonment rules see who is present.
//
// It has no timer, socket or database of its own. Whatever hosts it (a Durable
// Object, a host tab, a test) hands it connections and messages, calls `tick()`
// while `wantsTicks()` says so, and supplies a store. That is what lets a test
// run a room and six clients in one process with a clock it controls.

import {
  CONTROL,
  MEMBER,
  MOVE,
  SEAT_CEILING,
  Sim,
  durationRules,
  makeGenesis,
  simbot,
} from "@tessera/sim";
import type { EmpireSpec, Genesis, Move } from "@tessera/sim";
import {
  NONCE_BYTES,
  Roster,
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
  LobbyView,
  Phase,
  RoomConfig,
  ServerMessage,
  Stamped,
  You,
} from "./messages.js";
import type { RoomStore } from "./store.js";

/** How often a host should call `tick()` while the room wants ticks. Each tick
 *  seals about three steps, and a move waits at most this long to be stamped. */
export const TICK_MS = 250;

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

interface StoredPlayer {
  key: string;
  name: string;
  empire: number | null;
}

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
  /** The next step to simulate. Every step before it is final. */
  private next = 0;
  private pending: Stamped[] = [];
  private seqs: Record<string, number>;
  private readonly beats = new Map<string, number>();
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

    const genesis = store.get<Genesis>("genesis");
    if (genesis) this.load(genesis, store.get<number>("next") ?? 0);
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

  /** Whether the host should keep calling `tick()`: there is a game running
   *  and somebody to tell about it. With nobody connected the room sleeps, and
   *  the next tick after somebody arrives catches the world up. */
  wantsTicks(): boolean {
    if (this._phase === "playing") return !this.ended && this.connectedKeys().size > 0;
    return false;
  }

  /** When the room next needs waking with nobody connected: the scheduled
   *  start, if there is one. */
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
    if (peer?.key && this._phase === "lobby") this.broadcastLobby();
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

    if (this._phase === "lobby") {
      peer.key = message.key;
      const name = cleanName(message.name);
      const known = this.players.find((p) => p.key === message.key);
      if (known) {
        if (name) known.name = name;
      } else {
        this.players.push({ key: message.key, name, empire: null });
      }
      this.store.put("players", this.players);
      this.sendTo(peer.conn, {
        t: "welcome",
        phase: "lobby",
        you: this.you(message.key),
        lobby: this.lobbyView(),
      });
      this.broadcastLobby();
      return;
    }

    // Catch the world up before handing it over, so the client starts from now
    // rather than from whenever the room last ticked. The key is set after, so
    // this client is not sent a batch it has no state to apply to.
    this.seal();
    peer.key = message.key;
    this.sendTo(peer.conn, {
      t: "welcome",
      phase: "playing",
      you: this.you(message.key),
      game: this.catchup(message.have),
    });
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
      this.store.put("next", 0);
      this._phase = "playing";
      this.load(genesis, 0);
      const sim = this.sim!;
      this.store.putSnapshot({ step: 0, hash: sim.hash(), bytes: new Uint8Array(sim.snapshot()) });

      for (const peer of this.peers.values()) {
        if (peer.key) this.sendTo(peer.conn, { t: "start", genesis, you: this.you(peer.key) });
      }
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
        },
        empires,
      }),
    );
    const problems = await inspectGenesis(genesis);
    if (problems.length) return `the game could not be composed: ${problems.join(", ")}`;
    return genesis;
  }

  /** Build the simulation for a started game and bring it to `next`. */
  private load(genesis: Genesis, next: number): void {
    this.genesis = genesis;
    this.roster = Roster.fromGenesis(genesis);
    const sim = new Sim(genesis);
    const snapshot = this.store.latestSnapshot();
    let tail: Stamped[] = [];
    if (snapshot) {
      sim.restore(snapshot.bytes.slice().buffer);
      tail = this.store.movesFrom(snapshot.step);
    }
    advanceTo(
      sim,
      next,
      tail.map((s) => s.move),
    );
    this.sim = sim;
    this.next = sim.step;
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
    this.store.put("seqs", this.seqs);
    this.pending.push({ move, sig: message.sig });
  }

  // --- the clock -------------------------------------------------------------

  /** Called by the host every TICK_MS while `wantsTicks()`, and at `wakeAt()`.
   *  Starts a scheduled game when it is due, and seals the steps that have
   *  passed. */
  async tick(): Promise<void> {
    if (this._phase === "lobby") {
      if (this.startsAt !== undefined && this.now() >= this.startsAt) await this.start();
      return;
    }
    this.seal();
  }

  /** Stamp what is pending, simulate up to now, log it, and tell everybody. */
  private seal(): void {
    const sim = this.sim;
    if (!sim || !this.genesis || sim.ended) return;
    const target = stepAt(this.genesis.startedAt, this.now());
    if (target <= this.next) return;

    const from = this.next;
    const batch: Stamped[] = [];
    for (const stamped of this.pending) {
      stamped.move.step = from;
      batch.push(stamped);
    }
    this.pending = [];
    batch.push(...this.heartbeats(from));

    this.store.append(batch);
    const { checkpoints } = advanceTo(
      sim,
      target,
      batch.map((s) => s.move),
    );
    for (const { step, hash } of checkpoints) this.checkpoints.set(step, hash);
    for (const step of this.checkpoints.keys()) {
      if (this.checkpoints.size <= KEEP_CHECKPOINTS) break;
      this.checkpoints.delete(step);
    }

    this.next = sim.step;
    this.store.put("next", this.next);
    if (Math.floor(this.next / SNAPSHOT_EVERY) > Math.floor(from / SNAPSHOT_EVERY) || sim.ended) {
      this.store.putSnapshot({
        step: this.next,
        hash: sim.hash(),
        bytes: new Uint8Array(sim.snapshot()),
      });
    }

    const message: ServerMessage = { t: "batch", from, upTo: this.next, moves: batch };
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, message);
    }
  }

  /** A HEARTBEAT for every seat with a socket open, once per heartbeat
   *  interval. Unsigned: presence is something the room observes, not
   *  something a seat claims. */
  private heartbeats(step: number): Stamped[] {
    if (!this.roster || !this.genesis) return [];
    const interval = this.genesis.rules.heartbeatInterval;
    const out: Stamped[] = [];
    for (const key of [...this.connectedKeys()].sort()) {
      const seat = this.roster.seatOf(key);
      if (!seat) continue;
      const last = this.beats.get(key);
      if (last !== undefined && step - last < interval) continue;
      this.beats.set(key, step);
      out.push({
        move: { step, empire: seat.empire, member: seat.member, seq: 0, type: MOVE.HEARTBEAT, x: 0, y: 0 },
      });
    }
    return out;
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
      return { genesis, tail: this.store.movesFrom(have.step), upTo: this.next };
    }
    const snapshot = this.store.latestSnapshot()!;
    return {
      genesis,
      snapshot: { step: snapshot.step, hash: snapshot.hash, data: toBase64Url(snapshot.bytes) },
      tail: this.store.movesFrom(snapshot.step),
      upTo: this.next,
    };
  }

  /** A client's hash at a checkpoint. A mismatch sends it the room's state. */
  private compare(peer: Peer, step: number, hash: number): void {
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
