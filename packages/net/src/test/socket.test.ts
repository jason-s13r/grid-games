// The client, against the real bus over a wire the test owns.
//
// The interesting assertions are the ones about the third state a WebSocket has
// and a data channel never did: back, having missed things. A transport that
// merely reconnected would pass every other test in this file and lose a seat in
// a real game, which is what `the outbound buffer` below is about.

import { describe, expect, it } from "vitest";
import { FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { RoomBus } from "../roombus.js";
import { SocketTransport } from "../socket.js";
import { SocketWorld } from "./fakesocket.js";

const REF = { kind: "socket" as const, url: "wss://relay.example/tessera", room: "abc234" };

const hello = (nonce: string): Frame =>
  ({ t: FRAME.HELLO, protocol: 4, gameId: "", key: "k", nonce }) as unknown as Frame;

interface Opened {
  world: SocketWorld;
  transport: SocketTransport;
  id: string;
}

async function open(id?: string, world = new SocketWorld()): Promise<Opened> {
  const transport = new SocketTransport(REF, { socket: world.Socket, ...(id ? { id } : {}) });
  world.settle();
  return { world, transport, id: await transport.opening };
}

describe("SocketTransport", () => {
  it("dials the room's own URL, opens, and takes the id it is given", async () => {
    const { world, transport, id } = await open("nightwatch");
    // The room is a path segment, which is what makes one listing row able to
    // name the same room on both transports.
    expect(world.sockets[0]!.url).toBe("wss://relay.example/tessera/abc234");
    expect(id).toBe("nightwatch");
    expect(transport.id).toBe("nightwatch");
    transport.close();
  });

  it("lists the room minus itself", async () => {
    const world = new SocketWorld();
    const a = await open("alice", world);
    const b = await open("bob", world);
    world.settle();

    expect(a.transport.peers()).toEqual(["bob"]);
    expect(b.transport.peers()).toEqual(["alice"]);
    a.transport.close();
    b.transport.close();
  });

  it("reports joins and leaves derived from the roster", async () => {
    const world = new SocketWorld();
    const joins: string[] = [];
    const leaves: string[] = [];
    const transport = new SocketTransport(REF, {
      socket: world.Socket,
      id: "alice",
      onJoin: (peer) => joins.push(peer),
      onLeave: (peer) => leaves.push(peer),
    });
    world.settle();
    await transport.opening;

    const other = await open("bob", world);
    world.settle();
    expect(joins).toEqual(["bob"]);

    other.transport.close();
    world.settle();
    expect(leaves).toEqual(["bob"]);
    transport.close();
  });

  it("replays frames that arrived before anyone was listening", async () => {
    const world = new SocketWorld();
    const a = await open("alice", world);
    const b = await open("bob", world);
    world.settle();

    // PeerMesh's backlog property, re-proved: a joiner cannot build its driver
    // until the genesis record turns up, and the genesis record arrives on the
    // same channel as everything after it.
    b.transport.broadcast(hello("early"));
    world.settle();

    const heard: string[] = [];
    a.transport.listen((from, frame) => heard.push(`${from}:${(frame as { nonce: string }).nonce}`));
    expect(heard).toEqual(["bob:early"]);
    a.transport.close();
    b.transport.close();
  });

  it("sends to one peer, and never echoes to the sender", async () => {
    const world = new SocketWorld();
    const a = await open("alice", world);
    const b = await open("bob", world);
    const c = await open("carol", world);
    world.settle();

    const heard: string[] = [];
    for (const peer of [a, b, c]) {
      peer.transport.listen((from, frame) =>
        heard.push(`${peer.id}<-${from}:${(frame as { nonce: string }).nonce}`),
      );
    }

    a.transport.send("bob", hello("direct"));
    a.transport.broadcast(hello("all"));
    world.settle();

    expect(heard).toEqual([
      "bob<-alice:direct",
      "bob<-alice:all",
      "carol<-alice:all",
    ]);
    for (const peer of [a, b, c]) peer.transport.close();
  });

  describe("the outbound buffer", () => {
    it("holds what was written while the socket was down and sends it in order", async () => {
      const world = new SocketWorld();
      const a = await open("alice", world);
      const b = await open("bob", world);
      world.settle();

      const heard: string[] = [];
      b.transport.listen((_from, frame) => heard.push((frame as { nonce: string }).nonce));

      // The socket dies mid-write, which is the whole fault this buffer exists
      // for: a real WebSocket in CLOSING or CLOSED discards a send silently, so
      // a move written here would vanish while the readiness that promised it
      // was faithfully re-sent.
      world.sockets[0]!.kill();
      a.transport.broadcast(hello("one"));
      a.transport.broadcast(hello("two"));
      world.settle();
      expect(heard).toEqual([]);

      // The transport redials on its own timer; this test drives it rather than
      // waiting, because the backoff is jittered and a test should not be.
      await redial(world);
      expect(heard).toEqual(["one", "two"]);
      a.transport.close();
      b.transport.close();
    });

    it("comes back as itself, so the room sees a reconnection", async () => {
      const world = new SocketWorld();
      const a = await open("alice", world);
      world.sockets[0]!.kill();
      await redial(world);

      // Not a departure and a stranger: the held frames have to land under the
      // name that promised them.
      expect(a.transport.id).toBe("alice");
      a.transport.close();
    });

    it("says the room is empty while the socket is down", async () => {
      const world = new SocketWorld();
      const a = await open("alice", world);
      const b = await open("bob", world);
      world.settle();
      expect(a.transport.peers()).toEqual(["bob"]);

      // The truth, and what stops a resuming peer asking nobody for a snapshot.
      world.sockets[0]!.kill();
      expect(a.transport.peers()).toEqual([]);
      a.transport.close();
      b.transport.close();
    });

    it("announces the reconnection, because nothing replays what others said", async () => {
      const world = new SocketWorld();
      let backs = 0;
      const transport = new SocketTransport(REF, {
        socket: world.Socket,
        id: "alice",
        onReconnect: () => backs++,
      });
      world.settle();
      await transport.opening;
      expect(backs).toBe(0);

      world.sockets[0]!.kill();
      await redial(world);
      expect(backs).toBe(1);
      transport.close();
    });
  });

  it("stops redialling once closed", async () => {
    const world = new SocketWorld();
    const { transport } = await open("alice", world);
    const before = world.sockets.length;

    transport.close();
    world.sockets[0]!.kill();
    await new Promise((done) => setTimeout(done, 60));
    world.settle();

    expect(world.sockets.length).toBe(before);
  });

  it("does not redial a relay that said go away", async () => {
    // A real refusal from the real bus rather than an injected message: a full
    // relay is the cheapest one to arrange, and the point of the assertion is
    // that `closed` and a socket merely falling over are different events.
    const world = new SocketWorld({ bus: new RoomBus({ limits: { rooms: 0 } }) });
    const transport = new SocketTransport(REF, { socket: world.Socket });
    world.settle();

    await expect(transport.opening).rejects.toThrow(/relay is full/);
    const before = world.sockets.length;
    await new Promise((done) => setTimeout(done, 80));
    world.settle();
    expect(world.sockets.length).toBe(before);
  });

  it("refuses to send a frame larger than a relay will carry", async () => {
    const world = new SocketWorld();
    const errors: string[] = [];
    const transport = new SocketTransport(REF, {
      socket: world.Socket,
      id: "alice",
      onError: (error) => errors.push(error.message),
    });
    world.settle();
    await transport.opening;

    transport.broadcast(hello("x".repeat(1_100_000)));
    expect(errors).toEqual(["that frame is too large to send."]);
    transport.close();
  });

  it("carries a payload no data channel would take, whole", async () => {
    const world = new SocketWorld();
    const a = await open("alice", world);
    const b = await open("bob", world);
    world.settle();

    const heard: number[] = [];
    b.transport.listen((_from, frame) => heard.push((frame as { nonce: string }).nonce.length));

    // Around ten times the mesh's 15 kB slice, which is the size a snapshot of a
    // large map actually is. There is no chunking here and no need for any.
    const big = "y".repeat(170_000);
    a.transport.broadcast(hello(big));
    world.settle();
    expect(heard).toEqual([big.length]);
    a.transport.close();
    b.transport.close();
  });
});

/** Let the jittered backoff fire, then carry the rejoin through. Waiting on real
 *  time is the one concession in this file: the backoff is jittered on purpose,
 *  so that a relay coming back is not met by every client it dropped on the same
 *  millisecond, and a test should not pretend to know when it fires. */
async function redial(world: SocketWorld): Promise<void> {
  // A *new* socket, not a live one: every other peer in the world still has one
  // open, so "something is live" is true before the redial has even happened.
  const before = world.sockets.length;
  for (let i = 0; i < 60; i++) {
    await new Promise((done) => setTimeout(done, 25));
    world.settle();
    if (world.sockets.length === before) continue;
    // Open is not rejoined: the join has to reach the bus and the welcome has to
    // come back before the held frames go anywhere.
    for (let j = 0; j < 4; j++) {
      await new Promise((done) => setTimeout(done, 5));
      world.settle();
    }
    return;
  }
  throw new Error("the transport never redialled");
}
