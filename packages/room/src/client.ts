// A client's side of a game room.
//
// It holds the client's own copy of the simulation and runs it on its own
// clock, set by the room's: `advance()` simulates up to now, applying every
// move the room has stamped. The room stamps moves half a second ahead
// (LEAD_STEPS), so a move normally arrives before its step is simulated. One
// that arrives late is not lost: the client keeps a second of snapshots for the
// last few seconds, rewinds to the one before the move, and simulates forward
// again. Nothing it receives is board state except a snapshot, and a snapshot
// is only ever used to start from.
//
// No socket of its own. The host passes in `send` and calls `receive` with
// whatever arrives, and calls `connected()` when a (re)connection opens.

import { Sim } from "@tessera/sim";
import type { Genesis, Move, MoveType } from "@tessera/sim";
import {
  Identity,
  NONCE_BYTES,
  fromBase64Url,
  proveHello,
  randomBytes,
  signInvite,
  signMove,
  toBase64Url,
} from "@tessera/protocol";
import { advanceTo, stepAt } from "./advance.js";
import { decode, encode } from "./messages.js";
import type { SignedInvite } from "@tessera/protocol";
import type {
  Catchup,
  ChatLine,
  ClientMessage,
  LobbyView,
  People,
  Phase,
  ServerMessage,
  You,
} from "./messages.js";

export interface RoomClientOptions {
  identity: Identity;
  roomId: string;
  name?: string;
  /** Sends one message on the current connection. */
  send: (text: string) => void;
  /** The local clock, ms since the epoch. */
  now?: () => number;
  /** A program rather than a person: seated as a bot seat. */
  bot?: boolean;
}

/** A hash report every minute of game time. They double as the seat's
 *  presence: the room heartbeats a seat whose client has spoken lately. Each
 *  one can wake the room's Durable Object, which reads its state back in, so
 *  this is the main dial on what an idle open tab costs. */
const REPORT_EVERY = 12 * 60;
/** A report waits this many steps, so a late move cannot change the state it
 *  describes after it has been sent. */
const REPORT_AFTER = 24;
/** Rewind points: one a second, for the last ten seconds. */
const REWIND_EVERY = 12;
const REWIND_KEEP = 10;
/** Clock samples kept for estimating the room's clock. */
const CLOCK_SAMPLES = 32;

export class RoomClient {
  phase: Phase | undefined;
  lobby: LobbyView | undefined;
  genesis: Genesis | undefined;
  sim: Sim | undefined;
  you: You | undefined;
  /** Who is in the running game, and who is asking for a seat. */
  people: People = { people: [], requests: [] };
  /** Chat this client has heard, oldest first. */
  chat: ChatLine[] = [];

  /** The world was replaced wholesale (joined, resynced): repaint everything. */
  onReset: (() => void) | null = null;
  onLobby: ((lobby: LobbyView) => void) | null = null;
  onStart: ((genesis: Genesis) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onPeople: ((people: People) => void) | null = null;
  /** New chat lines, as they arrive. */
  onChat: ((lines: ChatLine[]) => void) | null = null;
  /** This client was given a seat after the start. */
  onSeated: ((you: You) => void) | null = null;

  private queue: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private name: string | undefined;
  private readonly now: () => number;

  /** Every move known from the oldest rewind point on, in arrival order. */
  private known: Move[] = [];
  private rewind: Array<{ step: number; hash: number; bytes: ArrayBuffer }> = [];
  /** The room's clock when we last heard from it. Our state is only known to be
   *  right up to about then: after a connection drops, the client keeps
   *  simulating, but without whatever was stamped in the meantime. */
  private lastHeard = 0;
  /** The rewind point offered to the room on reconnecting. */
  private offered: { step: number; hash: number; bytes: ArrayBuffer } | undefined;
  private reports = new Map<number, number>();
  /** Recent checkpoint hashes, for comparing clients at one step. */
  private history = new Map<number, number>();
  /** (room clock - local clock) as observed, newest last. Each sample is low by
   *  the message's travel time, so the largest is the closest. */
  private offsets: number[] = [];

  constructor(private readonly options: RoomClientOptions) {
    this.name = options.name;
    this.now = options.now ?? Date.now;
  }

  /** The room's clock as best this client can tell. Never ahead of it, which
   *  is the safe side: a client that thinks it is earlier than it is simulates
   *  less far, and waits rather than rewinds. */
  roomNow(): number {
    const offset = this.offsets.length ? Math.max(...this.offsets) : 0;
    return this.now() + offset;
  }

  /** Simulate up to now. Returns the tiles that changed. A host calls this
   *  every frame. */
  advance(): Set<number> {
    const sim = this.sim;
    if (!sim || !this.genesis) return new Set();
    const target = stepAt(this.genesis.startedAt, this.roomNow());
    const dirty = new Set<number>();
    while (sim.step < target && !sim.ended) {
      // One rewind interval at a time, keeping a rewind point at each.
      const to = Math.min(target, (Math.floor(sim.step / REWIND_EVERY) + 1) * REWIND_EVERY);
      const result = advanceTo(sim, to, this.known);
      for (const tile of result.dirty) dirty.add(tile);
      for (const { step, hash } of result.checkpoints) {
        if (step % REPORT_EVERY === 0) this.reports.set(step, hash);
        this.remember(step, hash);
      }
      if (sim.step % REWIND_EVERY === 0) this.keepRewind();
    }
    for (const [step, hash] of this.reports) {
      if (sim.step - step < REPORT_AFTER) continue;
      this.reports.delete(step);
      this.send({ t: "hash", step, hash });
    }
    return dirty;
  }

  /** This client's hash at a recent checkpoint step (every CHECKPOINT_EVERY),
   *  if it still has it. */
  hashAt(step: number): number | undefined {
    return this.history.get(step);
  }

  private remember(step: number, hash: number): void {
    this.history.set(step, hash);
    for (const old of this.history.keys()) {
      if (this.history.size <= 32) break;
      this.history.delete(old);
    }
  }

  private keepRewind(): void {
    const sim = this.sim!;
    this.rewind.push({ step: sim.step, hash: sim.hash(), bytes: sim.snapshot() });
    if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
    const oldest = this.rewind[0]!.step;
    this.known = this.known.filter((m) => m.step >= oldest);
  }

  private clock(roomNow: number): void {
    this.offsets.push(roomNow - this.now());
    if (this.offsets.length > CLOCK_SAMPLES) this.offsets.shift();
    this.lastHeard = Math.max(this.lastHeard, roomNow);
  }

  /** The newest rewind point from before we last heard from the room: the
   *  latest state this client knows to be complete. */
  private trusted(): { step: number; hash: number; bytes: ArrayBuffer } | undefined {
    if (!this.genesis) return undefined;
    const heard = stepAt(this.genesis.startedAt, this.lastHeard);
    return [...this.rewind].reverse().find((r) => r.step <= heard);
  }

  get key(): string {
    return this.options.identity.key;
  }

  /** Point the client at a new connection. The game it holds is kept, so the
   *  room's hello on the new socket only has to send what was missed. */
  reconnected(send: (text: string) => void): void {
    this.options.send = send;
  }

  /** Handle one message from the room. Resolves once it has been handled. */
  receive(text: unknown): Promise<void> {
    const message = decode<ServerMessage>(text);
    if (!message) return this.queue;
    this.queue = this.queue.then(() => this.handle(message)).catch(() => {});
    return this.queue;
  }

  // --- what the player does --------------------------------------------------

  setName(name: string): void {
    this.name = name;
    this.send(this.phase === "playing" ? { t: "name", name } : { t: "lobby", name });
  }

  /** Say something. Team lines go to this client's empire only. */
  say(text: string, channel: "all" | "team" = "all"): void {
    this.send({ t: "say", channel, text });
  }

  /** Take an empire nobody holds. */
  claim(empire: number): void {
    this.send({ t: "claim", empire });
  }

  /** Ask an empire for a seat; its members decide. */
  ask(empire: number): void {
    this.send({ t: "ask", empire });
  }

  withdraw(): void {
    this.send({ t: "withdraw" });
  }

  approve(key: string): void {
    this.send({ t: "approve", key });
  }

  decline(key: string): void {
    this.send({ t: "decline", key });
  }

  /** An invite to this client's empire, signed here. Undefined without a seat. */
  async invite(validForMs = 7 * 24 * 60 * 60 * 1000): Promise<SignedInvite | undefined> {
    const seat = this.you?.seat;
    const gameId = this.genesis?.gameId;
    if (!seat || !gameId) return undefined;
    return signInvite(this.options.identity, gameId, {
      empire: seat.empire,
      id: toBase64Url(randomBytes(12)),
      expires: Math.floor((Date.now() + validForMs) / 1000),
      by: this.key,
    });
  }

  redeem(invite: SignedInvite): void {
    this.send({ t: "redeem", invite });
  }

  pickEmpire(empire: number | null): void {
    this.send({ t: "lobby", empire });
  }

  start(): void {
    this.send({ t: "start" });
  }

  /** Sign and send a move. The room stamps its step; it is applied when a batch
   *  comes back with it in. False when this client holds no seat. */
  async submit(type: MoveType, x = 0, y = 0): Promise<boolean> {
    const seat = this.you?.seat;
    const gameId = this.genesis?.gameId;
    if (!seat || !gameId || this.sim?.ended) return false;
    const move: Move = { step: 0, empire: seat.empire, member: seat.member, seq: this.nextSeq++, type, x, y };
    const { sig } = await signMove(this.options.identity, gameId, move);
    this.send({ t: "move", move: { seq: move.seq, type, x, y }, sig });
    return true;
  }

  // --- what the room says ----------------------------------------------------

  private async handle(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case "challenge":
        return this.hello(message.nonce);
      case "welcome":
        this.phase = message.phase;
        this.setYou(message.you);
        if (message.lobby) this.setLobby(message.lobby);
        if (message.game) this.apply(message.game);
        return;
      case "lobby":
        return this.setLobby(message.lobby);
      case "start":
        this.phase = "playing";
        this.clock(message.now);
        this.genesis = message.genesis;
        this.sim = new Sim(message.genesis);
        this.known = [];
        this.rewind = [];
        this.reports.clear();
        this.keepRewind();
        this.setYou(message.you);
        this.onStart?.(message.genesis);
        this.onReset?.();
        return;
      case "moves":
        this.clock(message.now);
        return this.moves(message.moves.map((s) => s.move));
      case "resync":
        return this.apply(message.game);
      case "seated":
        this.setYou(message.you);
        this.onSeated?.(message.you);
        return;
      case "people":
        this.people = message.people;
        this.onPeople?.(message.people);
        return;
      case "chat": {
        // History arrives again on every reconnect; keep each line once.
        const seen = new Set(this.chat.map((l) => `${l.at}:${l.key}:${l.text}`));
        const fresh = message.lines.filter((l) => !seen.has(`${l.at}:${l.key}:${l.text}`));
        if (!fresh.length) return;
        this.chat.push(...fresh);
        if (this.chat.length > 500) this.chat.splice(0, this.chat.length - 500);
        this.onChat?.(fresh);
        return;
      }
      case "error":
        this.onError?.(message.message);
        return;
    }
  }

  private async hello(roomNonce: string): Promise<void> {
    const theirs = fromBase64Url(roomNonce);
    if (!theirs || theirs.length !== NONCE_BYTES) return;
    const ours = randomBytes(NONCE_BYTES);
    const proof = await proveHello(this.options.identity, this.options.roomId, theirs, ours);
    this.send({
      t: "hello",
      key: this.key,
      nonce: toBase64Url(ours),
      proof,
      ...(this.name ? { name: this.name } : {}),
      ...(this.options.bot ? { bot: true } : {}),
      // A reconnecting client already holds most of the game. It offers the
      // last state it knows is complete, and the room sends only what came
      // after, unless it has reason to doubt that state.
      ...this.offer(),
    });
  }

  private moves(moves: Move[]): void {
    const sim = this.sim;
    if (!sim) return;
    this.known.push(...moves);
    const earliest = Math.min(...moves.map((m) => m.step));
    if (earliest >= sim.step) return;

    // Late: rewind to before it and simulate forward again with it in.
    const point = [...this.rewind].reverse().find((r) => r.step <= earliest);
    if (!point) {
      this.send({ t: "resume", ...this.offer() });
      return;
    }
    const reached = sim.step;
    sim.restore(point.bytes.slice(0));
    this.rewind = this.rewind.filter((r) => r.step <= point.step);
    for (const step of [...this.reports.keys()]) if (step > point.step) this.reports.delete(step);
    while (sim.step < reached && !sim.ended) {
      const to = Math.min(reached, (Math.floor(sim.step / REWIND_EVERY) + 1) * REWIND_EVERY);
      const result = advanceTo(sim, to, this.known);
      for (const { step, hash } of result.checkpoints) {
        if (step % REPORT_EVERY === 0) this.reports.set(step, hash);
        this.remember(step, hash);
      }
      if (sim.step % REWIND_EVERY === 0) this.keepRewind();
    }
    this.onReset?.();
  }

  private offer(): { have?: { step: number; hash: number } } {
    this.offered = this.sim ? this.trusted() : undefined;
    return this.offered ? { have: { step: this.offered.step, hash: this.offered.hash } } : {};
  }

  private apply(game: Catchup): void {
    this.phase = "playing";
    const fresh = this.genesis?.gameId !== game.genesis.gameId;
    // Back to the state we offered, if the room is building on it.
    if (!game.snapshot && !fresh && this.sim && this.offered) {
      this.sim.restore(this.offered.bytes.slice(0));
    }
    this.offered = undefined;
    this.clock(game.now);
    this.genesis = game.genesis;
    if (game.snapshot || fresh || !this.sim) {
      const sim = new Sim(game.genesis);
      if (game.snapshot) {
        const bytes = fromBase64Url(game.snapshot.data);
        if (!bytes) return;
        sim.restore(bytes.slice().buffer);
      }
      this.sim = sim;
    }
    this.known = game.tail.map((s) => s.move);
    this.rewind = [];
    this.reports.clear();
    this.keepRewind();
    this.advance();
    this.onReset?.();
  }


  private setYou(you: You): void {
    this.you = you;
    // Never backwards: a seq this tab already spent is one the room refuses.
    this.nextSeq = Math.max(this.nextSeq, you.nextSeq);
  }

  private setLobby(lobby: LobbyView): void {
    this.lobby = lobby;
    this.onLobby?.(lobby);
  }

  private send(message: ClientMessage): void {
    this.options.send(encode(message));
  }
}
