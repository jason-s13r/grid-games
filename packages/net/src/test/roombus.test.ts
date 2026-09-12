// The contract, one row per rule.
//
// This file is the specification a second implementation is written against, so
// it checks the bus's behaviour through nothing but the envelope: a fake socket
// that records what it was sent, and JSON in both directions. Nothing here
// imports the simulation, which is the point — a relay that needed the game to
// be correct would be a relay with authority.

import { describe, expect, it } from "vitest";
import { BUS_VERSION, RoomBus } from "../roombus.js";
import type { BusSocket, Down } from "../roombus.js";

class Recorder implements BusSocket {
  readonly got: Down[] = [];
  closed = false;
  send(text: string): void {
    this.got.push(JSON.parse(text) as Down);
  }
  close(): void {
    this.closed = true;
  }
  /** The last message of one op, which is what an assertion almost always
   *  wants: rosters arrive repeatedly and only the newest is the truth. */
  last<T extends Down["op"]>(op: T): Extract<Down, { op: T }> | undefined {
    const found = [...this.got].reverse().find((message) => message.op === op);
    return found as Extract<Down, { op: T }> | undefined;
  }
}

const join = (bus: RoomBus, socket: BusSocket, room = "abc234", id?: string): void =>
  bus.deliver(socket, JSON.stringify({ op: "join", v: BUS_VERSION, room, ...(id ? { id } : {}) }));

const frame = (bus: RoomBus, socket: BusSocket, d: string, to?: string): void =>
  bus.deliver(socket, JSON.stringify({ op: "frame", d, ...(to ? { to } : {}) }));

describe("a room bus", () => {
  it("welcomes a joiner with an id and the room, itself included", () => {
    const bus = new RoomBus();
    const a = new Recorder();
    join(bus, a, "abc234", "alice");

    expect(a.last("welcome")).toEqual({ op: "welcome", id: "alice", peers: ["alice"] });
  });

  it("gossips the roster to everyone on a join and on a leave", () => {
    const bus = new RoomBus();
    const a = new Recorder();
    const b = new Recorder();
    join(bus, a, "abc234", "alice");
    join(bus, b, "abc234", "bob");

    // The full room, self included, in one message broadcast to it — idempotent,
    // and the filtering belongs to whoever knows which id they hold.
    expect(a.last("peers")?.ids.sort()).toEqual(["alice", "bob"]);
    expect(b.last("peers")?.ids.sort()).toEqual(["alice", "bob"]);

    bus.gone(b);
    expect(a.last("peers")?.ids).toEqual(["alice"]);
  });

  it("routes a broadcast to the room and never to the sender", () => {
    const bus = new RoomBus();
    const [a, b, c] = [new Recorder(), new Recorder(), new Recorder()];
    join(bus, a, "abc234", "alice");
    join(bus, b, "abc234", "bob");
    join(bus, c, "other", "carol");

    frame(bus, a, "hello");
    expect(b.last("frame")).toEqual({ op: "frame", from: "alice", d: "hello" });
    expect(a.last("frame")).toBeUndefined();
    // Rooms are the whole of the routing: a bus with two games in it is two
    // games, not one with a filter over it.
    expect(c.last("frame")).toBeUndefined();
  });

  it("routes a `to` to one peer, and drops one nobody holds", () => {
    const bus = new RoomBus();
    const [a, b, c] = [new Recorder(), new Recorder(), new Recorder()];
    join(bus, a, "abc234", "alice");
    join(bus, b, "abc234", "bob");
    join(bus, c, "abc234", "carol");

    frame(bus, a, "for-bob", "bob");
    expect(b.last("frame")?.d).toBe("for-bob");
    expect(c.last("frame")).toBeUndefined();

    // A peer that left mid-frame is ordinary. There is nobody to report it to
    // who could do anything about it, so the frame is dropped and the sender is
    // still connected.
    frame(bus, a, "for-nobody", "dave");
    expect(a.closed).toBe(false);
    expect(b.got.filter((m) => m.op === "frame")).toHaveLength(1);
  });

  it("stamps `from` itself, so a client cannot claim to be someone else", () => {
    const bus = new RoomBus();
    const [a, b] = [new Recorder(), new Recorder()];
    join(bus, a, "abc234", "alice");
    join(bus, b, "abc234", "bob");

    // The one property every peer relies on. Spoofing it would not forge a move
    // — those are signed — but it would let one peer answer as another.
    bus.deliver(a, JSON.stringify({ op: "frame", from: "bob", d: "not-bob" }));
    expect(b.last("frame")).toEqual({ op: "frame", from: "alice", d: "not-bob" });
  });

  it("replaces a taken id rather than refusing it, and says so", () => {
    const bus = new RoomBus();
    const [a, b] = [new Recorder(), new Recorder()];
    join(bus, a, "abc234", "alice");
    join(bus, b, "abc234", "alice");

    // Two sockets under one id is a driver addressing both and neither. An id
    // carries no authority, so replacing costs nothing and refusing would buy
    // nothing.
    const welcome = b.last("welcome");
    expect(welcome?.id).not.toBe("alice");
    expect(welcome?.peers.sort()).toEqual(["alice", welcome!.id].sort());
  });

  it("refuses an id outside the room charset without refusing the peer", () => {
    const bus = new RoomBus();
    const a = new Recorder();
    join(bus, a, "abc234", "../etc/passwd");
    expect(a.closed).toBe(false);
    expect(a.last("welcome")?.id).not.toBe("../etc/passwd");
  });

  it("closes with a sentence, four ways", () => {
    const reasons = (fn: (bus: RoomBus, socket: Recorder) => void): string | undefined => {
      const bus = new RoomBus({ limits: { message: 200, rate: 2 } });
      const socket = new Recorder();
      fn(bus, socket);
      expect(socket.closed).toBe(true);
      return socket.last("closed")?.reason;
    };

    // A version nobody can speak is the difference between "the relay is
    // broken" and "update your tab".
    expect(
      reasons((bus, socket) =>
        bus.deliver(socket, JSON.stringify({ op: "join", v: 99, room: "abc234" })),
      ),
    ).toMatch(/room-bus v1/);

    // A relay that accepts `../` as a room name has a path traversal in
    // whatever it eventually logs to.
    expect(
      reasons((bus, socket) =>
        bus.deliver(socket, JSON.stringify({ op: "join", v: BUS_VERSION, room: "../etc" })),
      ),
    ).toMatch(/not a room name/);

    expect(reasons((bus, socket) => bus.deliver(socket, "x".repeat(201)))).toMatch(/too large/);

    expect(
      reasons((bus, socket) => {
        join(bus, socket);
        // Stopping on close is the faithful part: a real socket that has been
        // closed delivers nothing more, and a test that keeps pushing into one
        // is asserting against the second refusal rather than the first.
        for (let i = 0; i < 40 && !socket.closed; i++) frame(bus, socket, "flood");
      }),
    ).toMatch(/too many messages/);
  });

  it("refuses a frame from a socket that never joined", () => {
    const bus = new RoomBus();
    const a = new Recorder();
    frame(bus, a, "hello");
    expect(a.last("closed")?.reason).toMatch(/join a room first/);
  });

  it("answers a ping, which is the only keepalive a browser can send", () => {
    const bus = new RoomBus();
    const a = new Recorder();
    join(bus, a);
    bus.deliver(a, JSON.stringify({ op: "ping" }));
    expect(a.last("pong")).toEqual({ op: "pong" });
  });

  it("refills the rate budget with time, so a long game is not a flood", () => {
    let now = 0;
    const bus = new RoomBus({ limits: { rate: 2 }, now: () => now });
    const a = new Recorder();
    join(bus, a);
    for (let i = 0; i < 8; i++) frame(bus, a, "steady");
    expect(a.closed).toBe(false);

    now += 10_000;
    for (let i = 0; i < 8; i++) frame(bus, a, "steady");
    expect(a.closed).toBe(false);
  });

  it("holds rooms apart, and says what it is holding", () => {
    const bus = new RoomBus();
    const [a, b] = [new Recorder(), new Recorder()];
    join(bus, a, "abc234", "alice");
    join(bus, b, "other", "bob");

    expect([...bus.rooms().keys()].sort()).toEqual(["abc234", "other"]);
    expect(bus.rooms().get("abc234")).toEqual(["alice"]);

    bus.gone(a);
    expect(bus.rooms().has("abc234")).toBe(false);
  });
});
