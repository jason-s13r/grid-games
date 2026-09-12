// A game composed by a process, accepted by a peer that was not asked.
//
// The composition is the only thing a host has ever had authority over, and it
// ends at the seal: the record is content-addressed, every peer runs
// `inspectGenesis` on it before agreeing to play, and after that a host is an
// ordinary peer. So what has to be proved here is narrow and load-bearing —
// a headless host can compose a record at all, and the record is one a browser
// join would accept.
//
// The reason it could not, before: `checkPlan` refuses a plan where anybody
// present has no seat, the composer's own key is always among those present, and
// a host peer never seats itself. Every plan a headless host composes failed that
// check on the first try.

import { describe, expect, it } from "vitest";
import { Identity, inspectGenesis } from "@tessera/protocol";
import { Lobby, RoomBus, SocketTransport, localPair } from "@tessera/net";
import type { ConnectionRef, Opener } from "@tessera/net";
import { hostGame } from "../peer.js";

const REF: ConnectionRef & { kind: "socket" } = {
  kind: "socket",
  url: "ws://127.0.0.1:8080",
  room: "abc234",
};

/** The host's own seat at its own bus: in process, with no socket under it.
 *
 *  Dialling itself would subject the one peer whose job is not to go away to its
 *  own rate limit, its own room cap and its own version check, and make its
 *  liveness inside its own game depend on a TCP connection to itself. */
function attach(bus: RoomBus): Opener {
  return async (_ref, options) => {
    // The lobby's own callbacks have to be forwarded: they are how it learns a
    // peer arrived, and a transport that swallows them is a lobby that greets
    // nobody.
    const transport = new SocketTransport(REF, { ...options, attach: () => localPair(bus) });
    await transport.opening;
    return transport;
  };
}

describe("hostGame", () => {
  it("seats the player who turned up, watches, and is accepted", async () => {
    const bus = new RoomBus({ serves: (room) => room === REF.room });
    const host = await Identity.generate();
    const player = await Identity.generate();

    const hosting = hostGame({
      identity: host,
      ref: REF,
      connect: attach(bus),
      // The shape `--auto 1` produces: seat everybody who is here, one empire
      // each, and put our own key under `watching`. A plan that seats nobody is
      // refused by `checkPlan` as "nobody is seated", which is right — a game
      // with no human seats is a game nobody is playing.
      compose: (players) => {
        const guests = players.filter((who) => !who.you);
        if (guests.length === 0) return null;
        return {
          empires: guests.map((who) => [who.key]),
          simbots: ["steady"],
          watching: [host.key],
          width: 24,
          height: 24,
        };
      },
    });

    // A peer that was never consulted about any of it.
    const joiner = await Lobby.open(player, REF, { connect: attach(bus) });
    const adopted = new Promise<{ seat?: { empire: number } }>((resolve) => {
      joiner.onStart = (_genesis, seat) => resolve({ seat });
    });

    const hosted = await hosting;
    expect(await inspectGenesis(hosted.genesis)).toEqual([]);
    // The host holds nothing: a host peer is an observer with a job, and its
    // authority ended at the seal.
    expect(hosted.seat).toBeUndefined();
    expect(hosted.shareable).toBe("ws://127.0.0.1:8080/abc234");

    const { seat } = await adopted;
    expect(seat).toEqual({ empire: 1, member: 0 });

    joiner.close();
    await hosted.stop();
  });

  it("waits rather than sealing a game nobody asked for", async () => {
    const bus = new RoomBus({ serves: () => true });
    const identity = await Identity.generate();
    let asked = 0;

    const hosting = hostGame({
      identity,
      ref: REF,
      connect: attach(bus),
      // Never ready: the room is empty and a host that seals a game nobody asked
      // it to seal is worse than one that waits.
      compose: () => {
        asked++;
        return null;
      },
    });

    const raced = await Promise.race([
      hosting.then(() => "sealed"),
      new Promise((done) => setTimeout(() => done("waiting"), 100)),
    ]);
    expect(raced).toBe("waiting");
    expect(asked).toBeGreaterThan(0);
  });

  it("is not killed by the joiner's watchdog while it waits", async () => {
    // The watchdog is armed for a joiner and fires if the phase is still
    // `waiting` with nobody there. A socket host joins its own room, where there
    // is nobody else by definition, so without `hosting: true` every `--plan` and
    // every `--auto` would fail fifteen seconds into waiting for the players the
    // host exists to wait for.
    const bus = new RoomBus({ serves: () => true });
    const identity = await Identity.generate();
    const lobby = await Lobby.open(identity, REF, { hosting: true, connect: attach(bus) });

    expect(lobby.phase).toBe("hosting");
    expect(lobby.code).toBe("abc234");
    lobby.close();
  });
});
