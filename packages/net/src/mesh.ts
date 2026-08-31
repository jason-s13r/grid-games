// The real transport: a full mesh of WebRTC data channels, introduced by
// PeerJS's public broker.
//
// The broker is signalling and nothing else. It hands two browsers each other's
// connection details and then has no part in the game — it never sees a move,
// cannot alter one, and can be swapped for any other broker without the game
// noticing. That is what "serverless" means here: zero *authority* servers.
//
// The honest caveat is TURN. Roughly one peer pair in five sits behind
// symmetric NAT and cannot form a direct connection without a relay, which by
// definition forwards packets. Pass `iceServers` to use one. It still holds no
// authority: every move through it is signed and every state is hash-verified,
// so a hostile relay can drop packets but cannot forge or alter a single move.
//
// PeerJS is loaded on demand rather than imported at the top. The lockstep
// driver has to stay runnable under Node for the harness, and PeerJS is a
// browser library; a static import would drag it into every consumer of this
// package. It also means a solo game never downloads it at all.

import type { DataConnection, Peer, PeerOptions } from "peerjs";
import { decodeFrame, encodeFrame } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import type { FrameHandler, Transport } from "./transport.js";

/** Mesh housekeeping, kept in its own envelope so it can never be confused with
 *  a game frame. `f` carries a game frame; `p` is the peer list that turns a
 *  star of connections into a mesh. */
type Envelope = { k: "f"; d: string } | { k: "p"; ids: string[] };

export interface PeerMeshOptions {
  /** The host's peer id, which doubles as the room code. Omit to be the host. */
  join?: string;
  /** Prefix for a generated host id, so a room code reads as a room code. */
  prefix?: string;
  iceServers?: RTCIceServer[];
  peerOptions?: PeerOptions;
  onOpen?: (id: string) => void;
  onJoin?: (id: string) => void;
  onLeave?: (id: string) => void;
  onError?: (error: Error) => void;
}

const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes

function roomCode(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return `${prefix}${code}`;
}

/** Just enough of PeerJS's shape to construct it. The module itself arrives
 *  through createMesh below. */
export type PeerConstructor = new (id?: string, options?: PeerOptions) => Peer;

/** Loads PeerJS and opens a mesh. Resolves once the broker has assigned an id,
 *  because until then there is no room code to show anyone. */
export async function createMesh(options: PeerMeshOptions = {}): Promise<PeerMesh> {
  const module = await import("peerjs");
  const constructor = (module.default ?? module.Peer) as unknown as PeerConstructor;
  const mesh = new PeerMesh(constructor, options);
  await mesh.opening;
  return mesh;
}

export class PeerMesh implements Transport {
  readonly peer: Peer;
  /** Resolves when the broker assigns an id, rejects if it never does. */
  readonly opening: Promise<string>;
  private readonly connections = new Map<string, DataConnection>();
  private readonly handlers: FrameHandler[] = [];
  /** Frames that arrived before anyone was listening. A joiner cannot build its
   *  driver until the genesis record turns up, and the genesis record arrives
   *  on the same channel as everything after it — so the first moves would be
   *  lost in the gap between connecting and being ready. */
  private readonly backlog: Array<{ from: string; frame: Frame }> = [];
  private opened = false;

  constructor(
    PeerClass: PeerConstructor,
    private readonly options: PeerMeshOptions = {},
  ) {
    const id = options.join ? undefined : roomCode(options.prefix ?? "");
    this.peer = new PeerClass(id, {
      ...options.peerOptions,
      config: {
        iceServers: options.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
        ...options.peerOptions?.config,
      },
    });

    this.opening = new Promise<string>((resolve, reject) => {
      this.peer.on("open", (assigned: string) => {
        this.opened = true;
        this.options.onOpen?.(assigned);
        if (options.join) this.dial(options.join);
        resolve(assigned);
      });
      this.peer.on("error", (error: Error) => {
        this.options.onError?.(error);
        if (!this.opened) reject(error);
      });
    });
    this.peer.on("connection", (connection: DataConnection) => this.adopt(connection));
  }

  get id(): string {
    return this.peer.id;
  }

  get ready(): boolean {
    return this.opened;
  }

  peers(): readonly string[] {
    return [...this.connections.keys()];
  }

  broadcast(frame: Frame): void {
    const envelope: Envelope = { k: "f", d: encodeFrame(frame) };
    for (const connection of this.connections.values()) this.push(connection, envelope);
  }

  send(to: string, frame: Frame): void {
    const connection = this.connections.get(to);
    if (connection) this.push(connection, { k: "f", d: encodeFrame(frame) });
  }

  listen(handler: FrameHandler): () => void {
    this.handlers.push(handler);
    // Hand over anything that arrived while nobody was ready for it.
    if (this.handlers.length === 1) {
      const waiting = this.backlog.splice(0, this.backlog.length);
      for (const { from, frame } of waiting) handler(from, frame);
    }
    return () => {
      const at = this.handlers.indexOf(handler);
      if (at >= 0) this.handlers.splice(at, 1);
    };
  }

  /** Dial a peer we have been told about. Idempotent, and skips ourselves —
   *  both matter, because every peer gossips the same list to every other. */
  dial(id: string): void {
    if (id === this.peer.id || this.connections.has(id)) return;
    this.adopt(this.peer.connect(id, { reliable: true, serialization: "json" }));
  }

  private adopt(connection: DataConnection): void {
    connection.on("open", () => {
      this.connections.set(connection.peer, connection);
      this.options.onJoin?.(connection.peer);
      // Introduce the newcomer to everyone we already know, and vice versa, so
      // a star of connections through the host becomes a full mesh. At six
      // peers that is fifteen channels and no relay in the middle.
      this.push(connection, { k: "p", ids: [...this.connections.keys(), this.peer.id] });
    });

    connection.on("data", (data: unknown) => this.receive(connection.peer, data as Envelope));

    const forget = (): void => {
      if (!this.connections.delete(connection.peer)) return;
      this.options.onLeave?.(connection.peer);
    };
    connection.on("close", forget);
    connection.on("error", forget);
  }

  private receive(from: string, envelope: Envelope): void {
    if (!envelope || typeof envelope !== "object") return;

    if (envelope.k === "p") {
      if (Array.isArray(envelope.ids)) for (const id of envelope.ids) this.dial(id);
      return;
    }
    if (envelope.k !== "f" || typeof envelope.d !== "string") return;

    // A peer can send whatever it likes; anything unrecognised is simply not
    // heard, and never reaches the driver.
    const frame = decodeFrame(envelope.d);
    if (!frame) return;

    if (this.handlers.length === 0) {
      // Bounded, so a peer cannot exhaust memory by talking at a client that is
      // never going to listen.
      if (this.backlog.length < 4096) this.backlog.push({ from, frame });
      return;
    }
    for (const handler of this.handlers) handler(from, frame);
  }

  private push(connection: DataConnection, envelope: Envelope): void {
    try {
      connection.send(envelope);
    } catch (error) {
      this.options.onError?.(error as Error);
    }
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.peer.destroy();
  }
}
