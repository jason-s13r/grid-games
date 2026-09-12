// A room on a relay: the other thing a ConnectionRef can name.
//
// The relay is fanout and nothing else. It holds room -> sockets, stamps the
// sender's id on what it forwards, and never parses a game frame — the frame
// crosses as the JSON text encodeFrame already produced, carried as a string
// inside the envelope rather than nested as an object, so that parsing the
// envelope cannot become parsing the game. On a snapshot, which is base64url and
// therefore escapes to itself, that costs about a dozen bytes.
//
// It holds no authority, exactly as a TURN relay holds none. What it can do that
// a TURN relay cannot is silence one seat while carrying the rest, and where
// that ends is written down in docs/mesh/room-bus.md.
//
// The difference from a data channel that this file exists to absorb: a data
// channel is reliable and ordered, and when it stops being either it is gone and
// so is the peer. A WebSocket has a third state — back, having missed things —
// and every recovery path in the driver was written when that state did not
// exist. The outbound buffer below is what keeps that state from costing a seat.

import { decodeFrame, encodeFrame } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { BUS_VERSION } from "./roombus.js";
import type { Down, Up } from "./roombus.js";
import type { ConnectionRef } from "./ref.js";
import type { Connection, ConnectOptions } from "./connect.js";
import type { FrameHandler } from "./transport.js";

/** Just enough WebSocket to talk to one. Named rather than imported so a test
 *  can pass a fake, which is the same reason mesh.ts names PeerConstructor
 *  rather than importing Peer. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type SocketConstructor = new (url: string) => SocketLike;

const OPEN = 1;

/** Six times the largest thing the game sends. A 160x112 snapshot is around
 *  170 kB of base64, and a WebSocket carries it whole — the 15 kB slicing in the
 *  mesh is a data-channel limit, not a protocol one. */
const MAX_MESSAGE = 1_000_000;

/** Frames written while the socket was down. Bounded, and an overflow is a
 *  failure rather than a truncation: dropping the oldest held frame is precisely
 *  the reordering this buffer exists to prevent, and doing it silently would
 *  reproduce the exact bug the buffer was added to stop. */
const MAX_HELD = 2_000_000;

const IDLE_PING_MS = 25_000;
const DEAD_AFTER_MS = 60_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const OPEN_TIMEOUT_MS = 12_000;

export interface SocketOptions extends ConnectOptions {
  /** Injectable for the same reason PeerConstructor is. */
  socket?: SocketConstructor;
  now?: () => number;
  openTimeoutMs?: number;
}

export class SocketTransport implements Connection {
  /** Resolves on the first `welcome`, rejects if none arrives — the same
   *  contract createMesh has with the broker, and for the same reason: until the
   *  server has named us there is no id to be a peer under. */
  readonly opening: Promise<string>;

  private socket?: SocketLike;
  private assigned = "";
  /** Everyone else in the room. Empty while the socket is down, which is the
   *  truth and is what stops a resuming peer asking nobody for a snapshot. */
  private roster: string[] = [];
  private readonly handlers: FrameHandler[] = [];
  /** Frames that arrived before anyone was listening. PeerMesh's property,
   *  re-proved here for the same reason it holds there: the connection is open
   *  before the lobby exists, and the genesis record arrives on the same channel
   *  as everything after it. */
  private readonly backlog: Array<{ from: string; frame: Frame }> = [];
  private held: string[] = [];
  private heldBytes = 0;
  private shut = false;
  private attempt = 0;
  private lastHeard = 0;
  private keepalive?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private settle?: { resolve: (id: string) => void; reject: (error: Error) => void };
  private deadline?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;

  constructor(
    private readonly ref: ConnectionRef & { kind: "socket" },
    private readonly options: SocketOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.opening = new Promise<string>((resolve, reject) => {
      this.settle = { resolve, reject };
      // A relay that answers slowly is indistinguishable from one that never
      // answers, and the redial loop would otherwise keep a caller waiting on a
      // promise nothing was going to settle.
      this.deadline = setTimeout(() => {
        if (this.assigned) return;
        this.giveUp("the relay did not answer.");
      }, options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
      unref(this.deadline);
    });
    this.dial();
  }

  get id(): string {
    return this.assigned;
  }

  peers(): readonly string[] {
    return this.live ? this.roster : [];
  }

  broadcast(frame: Frame): void {
    this.write({ op: "frame", d: encodeFrame(frame) });
  }

  send(to: string, frame: Frame): void {
    this.write({ op: "frame", to, d: encodeFrame(frame) });
  }

  listen(handler: FrameHandler): () => void {
    this.handlers.push(handler);
    const waiting = this.backlog.splice(0, this.backlog.length);
    for (const { from, frame } of waiting) handler(from, frame);
    return () => {
      const at = this.handlers.indexOf(handler);
      if (at >= 0) this.handlers.splice(at, 1);
    };
  }

  close(): void {
    this.shut = true; // before the socket, so onclose does not redial
    this.stopTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  private get live(): boolean {
    return !!this.socket && this.socket.readyState === OPEN && this.assigned !== "";
  }

  private write(message: Up): void {
    const text = JSON.stringify(message);
    if (text.length > MAX_MESSAGE) {
      this.options.onError?.(new Error("that frame is too large to send."));
      return;
    }
    if (this.live) {
      this.socket!.send(text);
      return;
    }
    if (this.shut) return;

    // The whole reason this class is longer than a wrapper. A socket in CLOSING
    // or CLOSED discards a send silently, so a move written across a 900 ms
    // outage would vanish while `repeatReady` faithfully re-sent the readiness
    // that promised it — everyone else simulating the step without the move, the
    // sender with it, and one permanent divergence that ends in a quorum-signed
    // drop about 20 seconds later.
    this.held.push(text);
    this.heldBytes += text.length;
    if (this.heldBytes > MAX_HELD) this.giveUp("the connection has been down too long.");
  }

  private flushHeld(): void {
    const waiting = this.held;
    this.held = [];
    this.heldBytes = 0;
    // In order, and before anything else is written: the game resumes as though
    // it had merely been slow.
    for (const text of waiting) this.socket?.send(text);
  }

  private dial(): void {
    if (this.shut) return;
    const Socket = this.options.socket ?? (globalThis.WebSocket as unknown as SocketConstructor);
    if (!Socket) {
      this.giveUp("this build has no WebSocket to open.");
      return;
    }

    let socket: SocketLike;
    try {
      socket = new Socket(`${this.ref.url}/${this.ref.room}`);
    } catch (error) {
      this.redial();
      this.options.onError?.(error as Error);
      return;
    }
    this.socket = socket;
    this.lastHeard = this.now();

    socket.onopen = () => {
      // The id we already hold, not the one we were configured with: coming back
      // as ourselves means the room sees a reconnection rather than a departure
      // and a stranger, and the held frames land under the name that promised
      // them.
      const want = this.assigned || this.options.id;
      socket.send(
        JSON.stringify({
          op: "join",
          v: BUS_VERSION,
          room: this.ref.room,
          ...(want ? { id: want } : {}),
        } satisfies Up),
      );
      this.tick();
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.redial();
    socket.onerror = () => {}; // a close always follows; one report is enough
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: Down;
    try {
      message = JSON.parse(data) as Down;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    this.lastHeard = this.now();

    switch (message.op) {
      case "welcome": {
        if (typeof message.id !== "string") return;
        const first = this.assigned === "";
        // Whatever we asked for, this is what we got: a requested id is a
        // request on both transports and a right on neither.
        this.assigned = message.id;
        this.attempt = 0;
        this.setRoster(message.peers);
        this.flushHeld();
        if (first) {
          clearTimeout(this.deadline);
          this.deadline = undefined;
          this.settle?.resolve(message.id);
          this.settle = undefined;
        } else this.options.onReconnect?.();
        return;
      }
      case "peers":
        return this.setRoster(message.ids);
      case "frame": {
        const { from, d } = message;
        if (typeof from !== "string" || typeof d !== "string") return;
        const frame = decodeFrame(d);
        if (frame) this.deliver(from, frame);
        return;
      }
      case "closed":
        // Deliberate, so it is not redialled. A server that means "go away" and
        // a socket that merely fell over are different events.
        return this.giveUp(said(message.reason));
      case "pong":
        return;
    }
  }

  private deliver(from: string, frame: Frame): void {
    if (this.handlers.length === 0) {
      if (this.backlog.length < 4096) this.backlog.push({ from, frame });
      return;
    }
    for (const handler of [...this.handlers]) handler(from, frame);
  }

  /** Joins and departures, derived rather than announced. A room bus tells
   *  everyone who is in the room; the mesh's onJoin/onLeave are what the lobby
   *  is written against, so the difference between two rosters is where they
   *  come from. It is also self-healing: a roster arriving after an outage
   *  produces exactly the joins and leaves that happened during it, without the
   *  server having to remember what we missed. */
  private setRoster(ids: unknown): void {
    if (!Array.isArray(ids)) return;
    const next = ids.filter((id): id is string => typeof id === "string" && id !== this.assigned);
    const before = new Set(this.roster);
    this.roster = next;
    for (const id of next) if (!before.delete(id)) this.options.onJoin?.(id);
    for (const id of before) this.options.onLeave?.(id);
  }

  /** One repeating timeout rather than an interval, unref'd where unref exists,
   *  so a headless peer's process is not held open by its own heartbeat. */
  private tick(): void {
    if (this.shut) return;
    clearTimeout(this.keepalive);
    const timer = setTimeout(() => {
      if (this.shut) return;
      const quiet = this.now() - this.lastHeard;
      // A WebSocket through a proxy dies silently after roughly a minute of
      // idle, and a client cannot tell a dead socket from a quiet room. Seated
      // peers are never quiet for long — a HEARTBEAT move goes out every 30 s —
      // but an observer sends nothing at all, and an observer that never notices
      // its socket died is a host peer failing to be a door.
      if (quiet >= DEAD_AFTER_MS) {
        this.socket?.close();
        this.redial();
        return;
      }
      if (quiet >= IDLE_PING_MS && this.live) {
        this.socket!.send(JSON.stringify({ op: "ping" } satisfies Up));
      }
      this.tick();
    }, IDLE_PING_MS);
    unref(timer);
    this.keepalive = timer;
  }

  private redial(): void {
    if (this.shut || this.retry) return;
    this.socket = undefined;
    this.roster = [];
    clearTimeout(this.keepalive);

    // Jittered, because a relay restarting must not be met by every client it
    // dropped, at once, on the same millisecond.
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt++);
    const timer = setTimeout(
      () => {
        this.retry = undefined;
        this.dial();
      },
      backoff / 2 + Math.random() * (backoff / 2),
    );
    unref(timer);
    this.retry = timer;
  }

  private giveUp(reason: string): void {
    const error = new Error(reason);
    this.close();
    if (this.settle) {
      this.settle.reject(error);
      this.settle = undefined;
      return;
    }
    this.options.onError?.(error);
  }

  private stopTimers(): void {
    clearTimeout(this.keepalive);
    clearTimeout(this.retry);
    clearTimeout(this.deadline);
    this.keepalive = undefined;
    this.retry = undefined;
    this.deadline = undefined;
  }
}

/** A relay's own words, or ours if it had none. Either way a sentence: the
 *  lobby prints this, and "closed" is not something to show a player. */
function said(reason?: string): string {
  return reason && typeof reason === "string" ? reason : "the relay closed the connection.";
}

/** Node holds the loop open for a pending timer; a browser has no such method. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
