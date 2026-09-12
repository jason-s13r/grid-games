// The relay, as running code rather than as a paragraph.
//
// A room bus holds `room -> sockets` and forwards bytes. It parses its own
// envelope and never a game frame, keeps no game state, and has no dependency
// on the simulation — which is what makes it interchangeable: the host peer
// wraps `ws` around this, the tests wrap a fake around it, and somebody else's
// implementation in another language is correct if it obeys the table below.
//
// It ships in the package rather than beside a test for the same reason
// LoopbackNetwork does: a thing that defines a contract by implementing it is
// part of the contract, and a host process cannot import a file under src/test.
//
// It holds no authority. Every move is signed and every state is hash-verified,
// so a bus can drop, delay and reorder and cannot forge, alter, seat anybody or
// read a team line — the argument mesh.ts makes for a TURN relay, transferred
// whole. What it can do that a TURN relay cannot is silence one seat while
// carrying the rest, and the honest end of that is written down in
// docs/mesh/room-bus.md: the majority stops hearing that seat, the stall
// machinery proposes a Drop, a quorum endorses it, and the player is out. Denial
// of play escalating to ejection — never authority, and never invisible, because
// the ejection is a quorum-signed record in every archive of that game.

import { isRoomName } from "./ref.js";

/** The room-bus envelope version. Bumped when a server and a client can no
 *  longer understand each other, which is a different question from whether two
 *  peers can play the same game — that is PROTOCOL_VERSION, and it moves on a
 *  different clock. A bus carries frames it does not parse, so it can outlive
 *  several game protocols without changing at all. The two must never be
 *  checked against each other. */
export const BUS_VERSION = 1;

/** Client to server. */
export type Up =
  | { op: "join"; v: number; room: string; id?: string }
  | { op: "frame"; to?: string; d: string }
  | { op: "ping" };

/** Server to client. */
export type Down =
  | { op: "welcome"; id: string; peers: string[] }
  | { op: "frame"; from: string; d: string }
  | { op: "peers"; ids: string[] }
  | { op: "closed"; reason?: string }
  | { op: "pong" };

/** One connected client, from the bus's side. `ws` satisfies this; so does the
 *  test's fake. The bus never learns which. */
export interface BusSocket {
  send(text: string): void;
  close(): void;
}

export interface BusLimits {
  /** Sockets in one room. Observers are unlimited by design, so this is an
   *  abuse ceiling rather than a rule about who may watch. */
  peers?: number;
  rooms?: number;
  /** Bytes in one envelope. Six times the largest thing the game sends: a
   *  160x112 snapshot is around 170 kB of base64, and a WebSocket carries it
   *  whole — the mesh's 15 kB slicing is a data-channel limit, not a protocol
   *  one. */
  message?: number;
  /** Envelopes per second, per socket, sustained. The burst is four times it,
   *  because answering three joiners' snapshot requests at once must not trip a
   *  limit meant for a flood. */
  rate?: number;
}

const LIMITS: Required<BusLimits> = {
  peers: 64,
  rooms: 1024,
  message: 1_000_000,
  rate: 64,
};

const BURST = 4;

interface Client {
  socket: BusSocket;
  room: string;
  id: string;
  /** A token bucket, refilled by elapsed time rather than by a timer: a bus
   *  with a thousand rooms should not hold a thousand intervals open. */
  allowance: number;
  last: number;
}

export interface BusOptions {
  limits?: BusLimits;
  /** Injectable so a test is not at the mercy of a clock it does not own. */
  now?: () => number;
}

export class RoomBus {
  private readonly clients = new Map<BusSocket, Client>();
  private readonly byRoom = new Map<string, Set<BusSocket>>();
  private readonly limits: Required<BusLimits>;
  private readonly now: () => number;

  constructor(options: BusOptions = {}) {
    this.limits = { ...LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** One inbound message from a socket that has not been dropped. */
  deliver(socket: BusSocket, raw: string): void {
    if (raw.length > this.limits.message) {
      this.refuse(socket, "that message is too large.");
      return;
    }

    let message: Up;
    try {
      message = JSON.parse(raw) as Up;
    } catch {
      this.refuse(socket, "that was not a room-bus message.");
      return;
    }
    if (!message || typeof message !== "object") {
      this.refuse(socket, "that was not a room-bus message.");
      return;
    }

    const client = this.clients.get(socket);
    if (client && !this.spend(client)) {
      this.refuse(socket, "too many messages.");
      return;
    }

    switch (message.op) {
      case "join":
        return this.join(socket, message);
      case "frame":
        return this.frame(socket, message);
      case "ping":
        return socket.send(JSON.stringify({ op: "pong" } satisfies Down));
      default:
        return this.refuse(socket, "that is not something a room bus does.");
    }
  }

  /** That socket went away, for any reason. */
  gone(socket: BusSocket): void {
    const client = this.clients.get(socket);
    this.clients.delete(socket);
    if (!client) return;

    const room = this.byRoom.get(client.room);
    if (!room) return;
    room.delete(socket);
    if (room.size === 0) {
      this.byRoom.delete(client.room);
      return;
    }
    this.gossip(client.room);
  }

  /** For a host that wants to say what it is holding. */
  rooms(): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, readonly string[]>();
    for (const [name, sockets] of this.byRoom) out.set(name, this.idsIn(sockets));
    return out;
  }

  private join(socket: BusSocket, message: Up & { op: "join" }): void {
    // Exactly once. A second join would move a socket between rooms while the
    // first room still believes it is there, and every `from` it had stamped
    // would now name a peer somewhere else.
    if (this.clients.has(socket)) {
      this.refuse(socket, "already in a room.");
      return;
    }
    if (message.v !== BUS_VERSION) {
      // A sentence, not a silence: the difference between "the relay is broken"
      // and "update your tab" is the whole value of the version field.
      this.refuse(socket, `this relay speaks room-bus v${BUS_VERSION}.`);
      return;
    }
    if (typeof message.room !== "string" || !isRoomName(message.room)) {
      this.refuse(socket, "that is not a room name.");
      return;
    }

    let room = this.byRoom.get(message.room);
    if (!room) {
      if (this.byRoom.size >= this.limits.rooms) {
        this.refuse(socket, "this relay is full.");
        return;
      }
      room = new Set();
      this.byRoom.set(message.room, room);
    }
    if (room.size >= this.limits.peers) {
      this.refuse(socket, "that room is full.");
      return;
    }

    const id = this.mint(room, message.id);
    room.add(socket);
    this.clients.set(socket, {
      socket,
      room: message.room,
      id,
      allowance: this.limits.rate * BURST,
      last: this.now(),
    });

    // Whatever they asked for, this is what they got: an id is a request on
    // both transports and a right on neither, and `welcome.id` is the truth.
    socket.send(JSON.stringify({ op: "welcome", id, peers: this.idsIn(room) } satisfies Down));
    this.gossip(message.room);
  }

  /** A requested id, if it is free and legal; otherwise one nobody holds.
   *
   *  Replaced rather than refused, because an id carries no authority — it is an
   *  address, and `welcome.id` already says which one — so a refusal would be a
   *  failure path in exchange for nothing. Two sockets under one id, on the
   *  other hand, is a driver addressing both and neither. */
  private mint(room: Set<BusSocket>, wanted?: string): string {
    const taken = new Set(this.idsIn(room));
    if (typeof wanted === "string" && isRoomName(wanted) && !taken.has(wanted)) return wanted;
    let id = mintId();
    while (taken.has(id)) id = mintId();
    return id;
  }

  private frame(socket: BusSocket, message: Up & { op: "frame" }): void {
    const client = this.clients.get(socket);
    // A frame from a socket in no room has no `from` to stamp, which is the
    // whole reason join comes first.
    if (!client) {
      this.refuse(socket, "join a room first.");
      return;
    }
    if (typeof message.d !== "string") return;

    // Stamped, never read from the client: a client cannot spoof another's id,
    // and this one line is the property every peer relies on.
    const out = JSON.stringify({ op: "frame", from: client.id, d: message.d } satisfies Down);
    const room = this.byRoom.get(client.room);
    if (!room) return;

    if (typeof message.to === "string") {
      for (const peer of room) {
        const other = this.clients.get(peer);
        // A peer that left mid-frame is ordinary, and dropping is the whole of
        // the response: there is nobody to report it to who could act on it.
        if (other && other.id === message.to && peer !== socket) peer.send(out);
      }
      return;
    }
    // Never echoed to the sender. LocalHub adds loopback as an explicit special
    // case; its absence is what every driver is written against.
    for (const peer of room) if (peer !== socket) peer.send(out);
  }

  /** Tell the room who is in it. One message broadcast to everyone, listing
   *  everyone including the recipient — rather than a tailored message each —
   *  so it is idempotent, cheap, and leaves the filtering to the one party that
   *  knows which id it holds. */
  private gossip(name: string): void {
    const room = this.byRoom.get(name);
    if (!room) return;
    const ids = this.idsIn(room);
    const out = JSON.stringify({ op: "peers", ids } satisfies Down);
    for (const peer of room) peer.send(out);
  }

  private idsIn(room: Set<BusSocket>): string[] {
    const ids: string[] = [];
    for (const peer of room) {
      const client = this.clients.get(peer);
      if (client) ids.push(client.id);
    }
    return ids;
  }

  /** A token bucket. Refused messages still cost, or a flood of rejects would
   *  be free. */
  private spend(client: Client): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - client.last) / 1000;
    client.last = now;
    client.allowance = Math.min(
      this.limits.rate * BURST,
      client.allowance + elapsed * this.limits.rate,
    );
    if (client.allowance < 1) return false;
    client.allowance -= 1;
    return true;
  }

  /** Say why, then go. A client that is told `closed` does not redial, which is
   *  the difference between a server that means "go away" and a socket that
   *  merely fell over. */
  private refuse(socket: BusSocket, reason: string): void {
    socket.send(JSON.stringify({ op: "closed", reason } satisfies Down));
    this.gone(socket);
    socket.close();
  }
}

/** Ids the bus hands out. Not `mintName`'s room alphabet: a room name is read
 *  aloud and typed back in, and a peer id inside a room is neither. */
function mintId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}
