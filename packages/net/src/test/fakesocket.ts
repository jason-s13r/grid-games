// A wire a test owns.
//
// fakepeer.ts's sibling, and LoopbackNetwork's in discipline: **nothing arrives
// until flush()**. The real SocketTransport and the real RoomBus sit in the
// middle of this, so what is being tested is the client and the contract; the
// only fake thing is the wire between them, which is the one part a test needs
// to control the interleaving of.
//
// It is also how an outage is expressed. `world.cut()` stops delivery in both
// directions without telling either side, which is exactly what a proxy dying
// mid-game does and exactly what no amount of loopback wiring could reproduce.

import { RoomBus } from "../roombus.js";
import type { BusSocket } from "../roombus.js";
import type { SocketConstructor, SocketLike } from "../socket.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** One end of a fake wire. Both directions queue; `flush` delivers one
 *  generation of each, so a reaction lands in the next flush rather than
 *  starving the caller. */
export class FakeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  /** Client to server, and server to client. */
  readonly up: string[] = [];
  readonly down: string[] = [];
  /** The id the bus gave this socket, read off the wire as it passed. The world
   *  owns the wire, so reading it is honest — and it is the only way a test can
   *  say "cut *that* peer's connection" rather than "cut the third one". */
  assigned = "";
  /** The bus's side of this same socket. */
  readonly far: BusSocket;
  /** The server said goodbye and the goodbye is still in flight. A real socket
   *  delivers what was sent before the close and *then* closes, which matters
   *  here more than it looks: the bus's refusals are a `closed` envelope
   *  immediately followed by a close, and a client that never saw the envelope
   *  would redial a relay that had just told it not to. */
  private goodbye = false;

  constructor(
    readonly url: string,
    private readonly world: SocketWorld,
  ) {
    const socket = this;
    this.far = {
      send(text: string): void {
        socket.down.push(text);
      },
      close(): void {
        socket.goodbye = true;
      },
    };
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return; // discarded silently, exactly as a real one does
    this.up.push(data);
  }

  close(): void {
    this.shut();
  }

  /** The socket dies without either side being told, which is what a proxy
   *  timing out looks like from in here. Anything still in flight is lost, which
   *  is the difference between this and a close. */
  kill(): void {
    this.up.length = 0;
    this.down.length = 0;
    this.shut();
  }

  /** Deliver the goodbye, if there is one, then close. Called by the world after
   *  a generation of messages has been delivered. */
  finish(): boolean {
    if (!this.goodbye || this.readyState === CLOSED) return false;
    this.shut();
    return true;
  }

  private shut(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.world.bus.gone(this.far);
    this.onclose?.();
  }

  open(): void {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.onopen?.();
  }
}

export interface WorldOptions {
  bus?: RoomBus;
}

export class SocketWorld {
  readonly bus: RoomBus;
  readonly sockets: FakeSocket[] = [];
  /** While true, nothing crosses in either direction and neither side is told —
   *  a relay that has stopped answering rather than one that closed. */
  cut = false;

  constructor(options: WorldOptions = {}) {
    this.bus = options.bus ?? new RoomBus();
  }

  /** A constructor to hand `SocketTransport`. */
  get Socket(): SocketConstructor {
    const world = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(url, world);
        world.sockets.push(this);
      }
    } as unknown as SocketConstructor;
  }

  /** Deliver one generation each way. Returns how many messages moved, so a
   *  caller can loop until the world is quiet. */
  flush(): number {
    if (this.cut) return 0;
    let moved = 0;

    for (const socket of [...this.sockets]) {
      if (socket.readyState === CONNECTING) {
        socket.open();
        moved++;
      }
    }
    for (const socket of [...this.sockets]) {
      const up = socket.up.splice(0, socket.up.length);
      for (const text of up) {
        moved++;
        if (socket.readyState === OPEN) this.bus.deliver(socket.far, text);
      }
    }
    for (const socket of [...this.sockets]) {
      const down = socket.down.splice(0, socket.down.length);
      for (const text of down) {
        moved++;
        if (socket.readyState !== OPEN) continue;
        const welcome = JSON.parse(text) as { op: string; id?: string };
        if (welcome.op === "welcome" && typeof welcome.id === "string") {
          socket.assigned = welcome.id;
        }
        socket.onmessage?.({ data: text });
      }
      if (socket.finish()) moved++;
    }
    return moved;
  }

  /** Flush until nothing is in flight. */
  settle(rounds = 20): void {
    for (let i = 0; i < rounds; i++) if (this.flush() === 0) return;
  }

  /** Every socket a transport has opened and not closed. */
  live(): FakeSocket[] {
    return this.sockets.filter((socket) => socket.readyState === OPEN);
  }

  /** The open socket a given peer is holding, by the id the bus gave it. */
  socketOf(id: string): FakeSocket | undefined {
    return this.live().find((socket) => socket.assigned === id);
  }
}
