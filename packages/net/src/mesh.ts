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
// definition forwards packets. PeerJS ships relays of its own and uses them
// unless it is told otherwise, so the default path is covered; `iceServers`
// replaces them with a relay you run. Either way it holds no authority: every
// move through it is signed and every state is hash-verified, so a hostile
// relay can drop packets but cannot forge or alter a single move.
//
// Which makes PeerJS's `config` a trap worth naming. It is merged one level
// deep, so passing a `config` of our own does not add to its defaults — it
// replaces them wholesale, relays included. This package did exactly that for
// several versions, handing PeerJS a lone STUN server and quietly deleting the
// TURN entries that were the only thing standing between a symmetric-NAT pair
// and a game that never starts. So `config` is now sent only when a caller
// actually asks for one.
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
 *  star of connections into a mesh; `c` is one slice of a frame too large to
 *  cross a data channel in a single message. */
type Envelope =
  | { k: "f"; d: string }
  | { k: "p"; ids: string[] }
  | { k: "c"; id: string; i: number; n: number; d: string };

export interface PeerMeshOptions {
  /** The host's peer id, which doubles as the room code. Omit to be the host. */
  join?: string;
  /** Prefix for a generated host id, so a room code reads as a room code. */
  prefix?: string;
  /** Replaces PeerJS's own STUN and TURN servers rather than adding to them.
   *  Leave it unset to take PeerJS's, which include a relay; set it to point at
   *  a coturn you control, and the relay stops being someone else's free tier
   *  to lose. */
  iceServers?: RTCIceServer[];
  peerOptions?: PeerOptions;
  onOpen?: (id: string) => void;
  onJoin?: (id: string) => void;
  onLeave?: (id: string) => void;
  onError?: (error: Error) => void;
  /** How long to wait for the broker to assign an id. */
  openTimeoutMs?: number;
}

/** A broker that answers slowly is indistinguishable from one that never
 *  answers, and PeerJS reports neither: it retries quietly. Without a deadline
 *  the promise below never settles and the caller waits forever. */
const DEFAULT_OPEN_TIMEOUT_MS = 12_000;

/** PeerJS chunks a binary payload for us but refuses an oversized JSON one
 *  outright — "Message too big for JSON channel", raised on the sender, with
 *  the frame silently never arriving. Its ceiling is chunkedMTU, 16300 bytes,
 *  chosen because Firefox to Chrome truncates at 16384.
 *
 *  A snapshot of a 160x112 map is around 170 kB of base64, so it has to be cut
 *  up here. 15 kB a slice leaves room for the envelope's own JSON around it. */
const MAX_SLICE = 15_000;

/** A hostile peer must not be able to exhaust memory by opening reassemblies it
 *  never finishes, so each peer gets a small fixed number and the oldest is
 *  dropped to make room. */
const MAX_PARTIALS_PER_PEER = 4;

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
  try {
    await mesh.opening;
  } catch (error) {
    // PeerJS retries on its own, so a rejected open would otherwise leave a
    // connection attempt running for the life of the page.
    mesh.close();
    throw error;
  }
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
  /** Half-arrived frames, keyed by peer and then by the sender's slice id. */
  private readonly partials = new Map<string, Map<string, (string | undefined)[]>>();
  private opened = false;
  private slices = 0;

  constructor(
    PeerClass: PeerConstructor,
    private readonly options: PeerMeshOptions = {},
  ) {
    const id = options.join ? undefined : roomCode(options.prefix ?? "");

    // Absent unless asked for: an undefined `config` leaves PeerJS's defaults
    // whole, and any object at all would take their place.
    const config =
      options.iceServers || options.peerOptions?.config
        ? { ...(options.iceServers ? { iceServers: options.iceServers } : {}),
            ...options.peerOptions?.config }
        : undefined;

    this.peer = new PeerClass(id, {
      ...options.peerOptions,
      ...(config ? { config } : {}),
    });

    this.opening = new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (this.opened) return;
        reject(new Error("the matchmaking broker did not respond"));
      }, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);

      this.peer.on("open", (assigned: string) => {
        this.opened = true;
        clearTimeout(deadline);
        this.options.onOpen?.(assigned);
        if (options.join) this.dial(options.join);
        resolve(assigned);
      });
      this.peer.on("error", (error: Error) => {
        this.options.onError?.(error);
        if (this.opened) return;
        clearTimeout(deadline);
        reject(error);
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
      this.partials.delete(connection.peer);
      if (!this.connections.delete(connection.peer)) return;
      this.options.onLeave?.(connection.peer);
    };
    connection.on("close", forget);
    // An error is not a departure. A refused message — one too large, most
    // often — leaves the channel perfectly usable, and forgetting the peer over
    // it drops someone who is still there and still playing.
    connection.on("error", (error: Error) => this.options.onError?.(error));
  }

  private receive(from: string, envelope: Envelope): void {
    if (!envelope || typeof envelope !== "object") return;

    if (envelope.k === "p") {
      if (Array.isArray(envelope.ids)) for (const id of envelope.ids) this.dial(id);
      return;
    }
    let encoded: string | null = null;
    if (envelope.k === "c") encoded = this.reassemble(from, envelope);
    else if (envelope.k === "f" && typeof envelope.d === "string") encoded = envelope.d;
    if (encoded === null) return;

    // A peer can send whatever it likes; anything unrecognised is simply not
    // heard, and never reaches the driver.
    const frame = decodeFrame(encoded);
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
      if (envelope.k !== "f" || envelope.d.length <= MAX_SLICE) {
        connection.send(envelope);
        return;
      }
      // Only this peer's own counter appears in the id, so two peers slicing at
      // the same moment cannot collide: the reassembly map is keyed by sender
      // before it is keyed by id.
      const id = `${this.slices++}`;
      const n = Math.ceil(envelope.d.length / MAX_SLICE);
      for (let i = 0; i < n; i++) {
        connection.send({
          k: "c",
          id,
          i,
          n,
          d: envelope.d.slice(i * MAX_SLICE, (i + 1) * MAX_SLICE),
        } satisfies Envelope);
      }
    } catch (error) {
      this.options.onError?.(error as Error);
    }
  }

  /** Collect a slice, and return the whole frame once the last one lands.
   *  Everything here is attacker-controlled, so every field is checked and the
   *  bookkeeping is bounded. */
  private reassemble(from: string, envelope: Extract<Envelope, { k: "c" }>): string | null {
    const { id, i, n, d } = envelope;
    if (typeof id !== "string" || typeof d !== "string") return null;
    if (!Number.isInteger(i) || !Number.isInteger(n)) return null;
    if (n < 1 || i < 0 || i >= n || d.length > MAX_SLICE) return null;

    let held = this.partials.get(from);
    if (!held) this.partials.set(from, (held = new Map()));

    let parts = held.get(id);
    if (!parts) {
      if (held.size >= MAX_PARTIALS_PER_PEER) held.delete(held.keys().next().value!);
      // Filled, not merely sized. A sparse array's holes are skipped by every
      // iteration method, so the completeness check below would visit only the
      // slices that had arrived, find none of them undefined, and hand on a
      // truncated frame after the very first one.
      held.set(id, (parts = new Array<string | undefined>(n).fill(undefined)));
    }
    // A second slice claiming a different total is a different message wearing
    // the same id; the safe reading is that neither can be trusted.
    if (parts.length !== n) {
      held.delete(id);
      return null;
    }

    parts[i] = d;
    if (parts.some((part) => part === undefined)) return null;
    held.delete(id);
    return parts.join("");
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.peer.destroy();
  }
}
