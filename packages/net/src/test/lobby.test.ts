// Two lobbies getting to one game, without a broker.
//
// There was no lobby suite before this, and the reason was structural:
// `createMesh` reaches for PeerJS through a dynamic import with no injection
// point, so any test of this file needed a real broker and nobody wrote one.
// The `connect` option is that injection point, and it costs four words in a
// signature.
//
// What it buys is a check on the seam every later plan in this series leans on.
// The host peer, the co-signed proposal and vacant empires all edit `lobby.ts`,
// and until now none of them could prove they had not broken the handshake.
//
// The third lobby is the observer-by-construction claim, which this repository
// has only ever asserted in prose: a peer whose key is not in the roster adopts
// the same genesis, verifies it like anyone else, and simply holds no seat. No
// mechanism keeps it out because none is needed.

import { describe, expect, it } from "vitest";
import { Identity } from "@tessera/protocol";
import { LoopbackNetwork, Lobby } from "../index.js";
import type { Connection, ConnectionRef, Opener, Seat } from "../index.js";
import { settle } from "./harness.js";

/** A loopback switch with a door on it.
 *
 *  A loopback `Transport` has no `close` and no join/leave events, because the
 *  harness it was written for wires its peers up front and never loses one. A
 *  lobby needs both, and the join event is honest news for a transport to
 *  deliver: "a peer appeared" is exactly what a broker or a room bus tells us.
 *  So the room announces each arrival to everyone already in it, both ways,
 *  which is what PeerJS's `connection` event amounts to. */
class LoopbackRoom {
  readonly network = new LoopbackNetwork();
  private readonly arrivals = new Map<string, (peer: string) => void>();
  private readonly departures = new Map<string, (peer: string) => void>();
  private next = 0;

  /** An opener for one peer. `undefined` means host, exactly as in production:
   *  the room hands out an id rather than dialling one. */
  opener(): Opener {
    return async (ref: ConnectionRef | undefined, options): Promise<Connection> => {
      const id = options.id ?? (ref?.kind === "rtc" ? `peer-${++this.next}` : `room-${++this.next}`);
      const transport = this.network.connect(id);
      if (options.onJoin) this.arrivals.set(id, options.onJoin);
      if (options.onLeave) this.departures.set(id, options.onLeave);

      // Everyone here learns about the arrival, and the arrival learns about
      // everyone here. A peer that dialled in knows the room it asked for; one
      // that was dialled does not, which is why this is not one call.
      //
      // Deferred, and that detail is load-bearing rather than cosmetic: the
      // lobby installs these callbacks while opening and only exists once
      // `open` has resolved, so a transport that announced an arrival from
      // inside its own constructor would find nobody home and drop the
      // greeting. PeerJS delivers the news a turn later; so does this.
      const here = transport.peers();
      setImmediate(() => {
        for (const peer of here) {
          this.arrivals.get(peer)?.(id);
          this.arrivals.get(id)?.(peer);
        }
      });

      const room = this;
      return {
        ...transport,
        id,
        peers: () => transport.peers(),
        listen: (handler) => transport.listen(handler),
        close() {
          room.network.disconnect(id);
          room.arrivals.delete(id);
          for (const [peer, leave] of room.departures) if (peer !== id) leave(id);
        },
      };
    };
  }

  /** Deliver until nothing is in flight. A HELLO begets a HELLO and a GENESIS
   *  begets an adoption two promises deep, so neither a flush nor a settle is
   *  enough on its own. */
  async run(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      this.network.flush();
      await settle(2);
    }
  }
}

const seatOf = (lobby: Lobby): Promise<Seat | undefined> =>
  new Promise((resolve) => {
    lobby.onStart = (_genesis, seat) => resolve(seat);
  });

describe("two lobbies over a loopback", () => {
  it("gets a joiner's key to the host, a sealed game back, and a seat each", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();

    const hostId = await Identity.generate();
    const host = await Lobby.open(hostId, undefined, { connect });
    expect(host.phase).toBe("hosting");
    // A ref the host was handed rather than one it typed — and on WebRTC the
    // room code is the peer id, which is what this asserts.
    expect(host.ref).toEqual({ kind: "rtc", code: host.connection.id });
    expect(host.code).toBe(host.connection.id);
    expect(host.shareable).toBe(host.connection.id);

    const guestId = await Identity.generate();
    const guest = await Lobby.open(guestId, { kind: "rtc", code: host.code }, { connect });
    expect(guest.phase).toBe("waiting");

    const hostSeat = seatOf(host);
    const guestSeat = seatOf(guest);
    await room.run();

    // The host can see somebody to seat, and the hello proved nothing beyond
    // "here is a key to seat me under" — which is all the host needs.
    const players = host.players();
    expect(players).toHaveLength(2);
    expect(players[0]!.you).toBe(true);
    expect(players[1]!.key).toBe(guestId.key);

    const sealed = await host.host({
      empires: [[hostId.key], [guestId.key]],
      simbots: [],
      width: 24,
      height: 24,
    });
    expect(sealed, host.problem).toBe(true);
    await room.run();

    expect(host.phase).toBe("playing");
    expect(guest.phase).toBe("playing");
    expect(await hostSeat).toEqual({ empire: 1, member: 0 });
    expect(await guestSeat).toEqual({ empire: 2, member: 0 });
  });

  it("lets a peer nobody seated adopt the same game and hold nothing", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();

    const hostId = await Identity.generate();
    const host = await Lobby.open(hostId, undefined, { connect });
    const guestId = await Identity.generate();
    const guest = await Lobby.open(guestId, { kind: "rtc", code: host.code }, { connect });
    await room.run();

    await host.host({ empires: [[hostId.key], [guestId.key]], simbots: [], width: 24, height: 24 });
    await room.run();

    // Arriving after the seal. The host re-sends the record unasked, because
    // until a peer has it, it does not know the game id every other frame is
    // signed against and so cannot ask for anything.
    const watcherId = await Identity.generate();
    const watcher = await Lobby.open(watcherId, { kind: "rtc", code: host.code }, { connect });
    const watching = seatOf(watcher);
    await room.run();

    expect(watcher.phase).toBe("playing");
    expect(await watching).toBeUndefined();
  });

  it("tells a joiner which room went unanswered", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();
    const id = await Identity.generate();

    // The watchdog's message is the one place the lobby prints where it was
    // going, and for a socket joiner the short code would name no server.
    const lobby = await Lobby.open(id, { kind: "rtc", code: "tsr-missing" }, { connect });
    expect(lobby.shareable).toBe("tsr-missing");
    lobby.close();
  });
});
