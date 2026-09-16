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
import {
  Identity,
  checkConsent,
  composeGenesis,
  proposalFrom,
  proposalId,
  sealGenesis,
  signConsent,
} from "@tessera/protocol";
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

  it("refuses a room that is running a different game than the one looked up", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();

    const hostId = await Identity.generate();
    const host = await Lobby.open(hostId, undefined, { connect });
    // A ref that arrived from a person needs no `expect`: they were just told
    // what was behind it. A ref that arrived from an address book names a game,
    // and the record the room hands back is well formed either way — composed
    // correctly, hashing to its own id, refused by nothing in `inspectGenesis`.
    // Without this comparison a board could point a lookup at any room it liked
    // and the joiner would play whatever it found there.
    const guestId = await Identity.generate();
    const guest = await Lobby.open(
      guestId,
      { kind: "rtc", code: host.code },
      { connect, expect: "a".repeat(64) },
    );
    await room.run();

    await host.host({ empires: [[hostId.key], [guestId.key]], simbots: [], width: 24, height: 24 });
    await room.run();

    expect(host.phase).toBe("playing");
    expect(guest.phase).toBe("failed");
    expect(guest.problem).toMatch(/different game/);
  });

  it("joins normally when the game it was promised is the game it found", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();

    const hostId = await Identity.generate();
    const host = await Lobby.open(hostId, undefined, { connect });
    let listed = "";
    host.onStart = (genesis) => {
      listed = genesis.gameId ?? "";
    };
    const guestId = await Identity.generate();
    await Lobby.open(guestId, { kind: "rtc", code: host.code }, { connect });
    await room.run();

    await host.host({ empires: [[hostId.key], [guestId.key]], simbots: [], width: 24, height: 24 });
    await room.run();
    expect(listed).not.toBe("");

    // The arrival a board makes possible: somebody who was told an id, dialling
    // a ref they were told alongside it. The id known in advance is the whole
    // difference from every other join in this file.
    const later = await Identity.generate();
    const arriving = await Lobby.open(
      later,
      { kind: "rtc", code: host.code },
      { connect, expect: listed },
    );
    const seat = seatOf(arriving);
    await room.run();

    expect(arriving.phase, arriving.problem).toBe("playing");
    expect(await seat).toBeUndefined();
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

describe("a game everybody signed", () => {
  const world = (over: Record<string, unknown> = {}) =>
    proposalFrom({ seed: 1234, startedAt: 0, map: { width: 24, height: 24 }, ...over });

  /** Two peers in one room, connected and greeted. */
  async function room2() {
    const room = new LoopbackRoom();
    const connect = room.opener();
    const aliceId = await Identity.generate();
    const alice = await Lobby.open(aliceId, undefined, { connect });
    const bobId = await Identity.generate();
    const bob = await Lobby.open(bobId, { kind: "rtc", code: alice.code }, { connect });
    await room.run();
    return { room, connect, alice, bob, aliceId, bobId };
  }

  it("a proposal reaches the room, and signing it is what seats you", async () => {
    const { room, alice, bob, aliceId, bobId } = await room2();

    const id = await alice.propose(world());
    expect(id).toBeDefined();
    await room.run();

    // Everybody sees the same world, and nobody has signed it yet.
    expect(bob.phase).toBe("composing");
    expect(bob.proposals()).toHaveLength(1);
    expect(bob.proposals()[0]!.id).toBe(id);
    expect(bob.proposals()[0]!.signers).toEqual([]);

    expect(await bob.consent(id!)).toBe(true);
    expect(await alice.consent(id!)).toBe(true);
    await room.run();

    const seats = [seatOf(alice), seatOf(bob)];
    expect(await alice.seal(id)).toBe(true);
    await room.run();

    expect(alice.phase, alice.problem).toBe("playing");
    expect(bob.phase, bob.problem).toBe("playing");

    // One signer, one empire, in key order — so the seat you get is decided by
    // your key and not by who sealed.
    const order = [aliceId.key, bobId.key].sort();
    const mine = await seats[0]!;
    const theirs = await seats[1]!;
    expect(mine!.empire).toBe(order.indexOf(aliceId.key) + 1);
    expect(theirs!.empire).toBe(order.indexOf(bobId.key) + 1);
  });

  it("a record that came out of a proposal says who accepted the world", async () => {
    const { room, alice, bob } = await room2();
    const id = (await alice.propose(world({ simbots: [] })))!;
    await room.run();
    await alice.consent(id);
    await bob.consent(id);
    await room.run();

    let sealed: { consent?: unknown } | undefined;
    alice.onStart = (genesis) => {
      sealed = genesis;
    };
    await alice.seal(id);
    await room.run();

    expect(await checkConsent(sealed as never)).toEqual({
      state: "checked",
      signed: 2,
      seats: 2,
    });
  });

  // The deadlock the world/roster split exists to avoid, over the wire.
  it("a signature survives somebody else arriving and signing", async () => {
    const { room, connect, alice, bob } = await room2();
    const id = (await alice.propose(world()))!;
    await room.run();
    await alice.consent(id);
    await room.run();

    const laterId = await Identity.generate();
    const later = await Lobby.open(laterId, { kind: "rtc", code: alice.code }, { connect });
    await room.run();

    // Re-sent to somebody who was not here: a broadcast reaches whoever
    // happened to be connected in that instant, and a room is a place people
    // arrive into.
    expect(later.proposals()).toHaveLength(1);
    expect(later.proposals()[0]!.signers).toHaveLength(1);

    await bob.consent(id);
    await later.consent(id);
    await room.run();

    // Alice signed first and has not re-signed. Her signature is still good.
    expect(alice.proposals()[0]!.signers).toHaveLength(3);
    expect(await alice.seal(id)).toBe(true);
    await room.run();
    expect(alice.phase, alice.problem).toBe("playing");
    expect(later.phase, later.problem).toBe("playing");
  });

  it("a revision supersedes, and an older one replayed does not unseat it", async () => {
    const { room, alice, bob } = await room2();
    await alice.propose(world());
    await room.run();
    const second = (await alice.propose(world({ vacancies: 1 })))!;
    await room.run();

    expect(bob.proposals()).toHaveLength(1);
    expect(bob.proposals()[0]!.rev).toBe(1);
    expect(bob.proposals()[0]!.id).toBe(second);

    // The earlier world, replayed by anybody who kept it.
    bob.connection.broadcast({
      t: "proposal",
      proposal: world(),
      rev: 0,
      by: alice.identity.key,
    } as never);
    await room.run();
    expect(bob.proposals()[0]!.id).toBe(second);
  });

  // The lead finding, and the reason the exclusion check cannot be stateless.
  // Sealing a subset is a *valid* record — it is the sealer's one real power —
  // so a peer left out of a world it signed is the only one who can notice.
  it("a peer left out of a game it signed fails rather than observing", async () => {
    const { room, alice, bob, bobId } = await room2();
    const id = (await alice.propose(world()))!;
    await room.run();
    await alice.consent(id);
    await bob.consent(id);
    await room.run();

    // Alice seals with her own signature only. The record is impeccable.
    const honest = await sealGenesis(
      composeGenesis(alice.proposals()[0]!.proposal, [
        await signConsent(alice.identity, id),
      ]),
    );
    expect((await checkConsent(honest)).state).toBe("checked");

    alice.connection.broadcast({ t: "genesis", genesis: honest } as never);
    await room.run();

    expect(bob.phase).toBe("failed");
    expect(bob.problem).toContain("does not carry your signature");
    expect(honest.empires.some((e) => e.members[0]?.key === bobId.key)).toBe(false);
  });

  it("a peer that signed nothing still watches a game it was left out of", async () => {
    const { room, connect, alice } = await room2();
    const id = (await alice.propose(world()))!;
    await room.run();
    await alice.consent(id);
    await room.run();

    const watcherId = await Identity.generate();
    const watcher = await Lobby.open(watcherId, { kind: "rtc", code: alice.code }, { connect });
    const seat = seatOf(watcher);
    await room.run();
    await alice.seal(id);
    await room.run();

    // It never signed, so it has nothing to be excluded from. An observer by
    // construction, exactly as before.
    expect(watcher.phase, watcher.problem).toBe("playing");
    expect(await seat).toBeUndefined();
  });

  it("a sealed record whose consents do not verify is refused by everyone", async () => {
    const { room, alice, bob } = await room2();
    const id = (await alice.propose(world()))!;
    await room.run();
    await alice.consent(id);
    await bob.consent(id);
    await room.run();

    const honest = composeGenesis(alice.proposals()[0]!.proposal, [
      await signConsent(alice.identity, id),
      await signConsent(bob.identity, id),
    ]);
    const tampered = await sealGenesis({
      ...honest,
      rules: { ...honest.rules, popMax: honest.rules.popMax + 1 },
    });

    alice.connection.broadcast({ t: "genesis", genesis: tampered } as never);
    await room.run();
    expect(bob.phase).toBe("failed");
    expect(bob.problem).toContain("consent");
  });

  it("refuses to seal a world nobody signed", async () => {
    const { room, alice } = await room2();
    const id = (await alice.propose(world()))!;
    await room.run();
    expect(await alice.seal(id)).toBe(false);
    expect(alice.problem).toContain("nobody has signed");
  });

  // A record sealed for a future instant is adopted and does not begin. The
  // driver may be built early; it is the screen that must not claim the game is
  // running.
  it("a game sealed for later sits in `starting` until the instant", async () => {
    const { room, alice, bob } = await room2();
    const soon = Date.now() + 30_000;
    const id = (await alice.propose(world({ startedAt: soon })))!;
    await room.run();
    await alice.consent(id);
    await bob.consent(id);
    await room.run();

    // The driver is built now — a peer that waited would be a room nobody could
    // reach during the countdown, and `targetStep` clamps it at step 0 anyway.
    // What waits is the word "playing".
    let built = false;
    let begun = false;
    bob.onStart = () => {
      built = true;
    };
    bob.onBegin = () => {
      begun = true;
    };
    await alice.seal(id);
    await room.run();

    expect(bob.phase).toBe("starting");
    expect(built).toBe(true);
    expect(begun).toBe(false);
    expect(bob.startsIn).toBeGreaterThan(0);
    expect(bob.startsIn).toBeLessThanOrEqual(30_000);
    bob.close();
    alice.close();
  });
});

describe("the instant a game begins", () => {
  it("a record sealed for now begins immediately, as every record did before", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();
    const hostId = await Identity.generate();
    const host = await Lobby.open(hostId, undefined, { connect });
    const guestId = await Identity.generate();
    const guest = await Lobby.open(guestId, { kind: "rtc", code: host.code }, { connect });
    await room.run();

    let begun = false;
    guest.onBegin = () => {
      begun = true;
    };
    await host.host({ empires: [[hostId.key], [guestId.key]], simbots: [], width: 24, height: 24 });
    await room.run();

    expect(guest.phase).toBe("playing");
    expect(begun).toBe(true);
    expect(guest.startsIn).toBe(0);
  });

  it("a record sealed for later begins on the instant, everywhere at once", async () => {
    const room = new LoopbackRoom();
    const connect = room.opener();
    const aliceId = await Identity.generate();
    const alice = await Lobby.open(aliceId, undefined, { connect });
    const bobId = await Identity.generate();
    const bob = await Lobby.open(bobId, { kind: "rtc", code: alice.code }, { connect });
    await room.run();

    const id = (await alice.propose(
      proposalFrom({
        seed: 5,
        startedAt: Date.now() + 400,
        map: { width: 24, height: 24 },
      }),
    ))!;
    await room.run();
    await alice.consent(id);
    await bob.consent(id);
    await room.run();

    await alice.seal(id);
    await room.run();
    expect(alice.phase).toBe("starting");
    expect(bob.phase).toBe("starting");

    await new Promise((done) => setTimeout(done, 450));
    expect(alice.phase).toBe("playing");
    expect(bob.phase).toBe("playing");
    expect(bob.startsIn).toBe(0);

    alice.close();
    bob.close();
  });
});
