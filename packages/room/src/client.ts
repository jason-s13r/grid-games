// A client's side of a game room.
//
// It holds the client's own copy of the simulation and keeps it at the room's
// step: a batch says which moves land on which steps and how far the world has
// got, and the client simulates exactly that. Nothing it receives is board
// state except a snapshot, and a snapshot is only ever used to start from.
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
  signMove,
  toBase64Url,
} from "@tessera/protocol";
import { advanceTo } from "./advance.js";
import { decode, encode } from "./messages.js";
import type { Catchup, ClientMessage, LobbyView, Phase, ServerMessage, You } from "./messages.js";

export interface RoomClientOptions {
  identity: Identity;
  roomId: string;
  name?: string;
  /** Sends one message on the current connection. */
  send: (text: string) => void;
}

export class RoomClient {
  phase: Phase | undefined;
  lobby: LobbyView | undefined;
  genesis: Genesis | undefined;
  sim: Sim | undefined;
  you: You | undefined;

  /** The world moved; `dirty` is what a renderer must repaint. */
  onAdvance: ((dirty: Set<number>) => void) | null = null;
  /** The world was replaced wholesale (joined, resynced): repaint everything. */
  onReset: (() => void) | null = null;
  onLobby: ((lobby: LobbyView) => void) | null = null;
  onStart: ((genesis: Genesis) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private queue: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private name: string | undefined;

  constructor(private readonly options: RoomClientOptions) {
    this.name = options.name;
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
    this.send({ t: "lobby", name });
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
        this.genesis = message.genesis;
        this.sim = new Sim(message.genesis);
        this.setYou(message.you);
        this.onStart?.(message.genesis);
        this.onReset?.();
        return;
      case "batch":
        return this.batch(message.from, message.upTo, message.moves.map((s) => s.move));
      case "resync":
        return this.apply(message.game);
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
      // A reconnecting client already holds most of the game. The room sends
      // only what it is missing, unless it has reason to doubt this state.
      ...(this.sim ? { have: { step: this.sim.step, hash: this.sim.hash() } } : {}),
    });
  }

  private batch(from: number, upTo: number, moves: Move[]): void {
    const sim = this.sim;
    if (!sim) return;
    if (from !== sim.step) {
      // A gap: something was missed. Ask for what is needed to close it rather
      // than simulating past a step whose moves we never saw.
      this.send({ t: "resume", have: { step: sim.step, hash: sim.hash() } });
      return;
    }
    const { dirty, checkpoints } = advanceTo(sim, upTo, moves);
    for (const checkpoint of checkpoints) this.send({ t: "hash", ...checkpoint });
    this.onAdvance?.(dirty);
  }

  private apply(game: Catchup): void {
    this.phase = "playing";
    const fresh = this.genesis?.gameId !== game.genesis.gameId;
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
    advanceTo(
      this.sim,
      game.upTo,
      game.tail.map((s) => s.move),
    );
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
