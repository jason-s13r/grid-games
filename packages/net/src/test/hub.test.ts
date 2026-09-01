// Two drivers in one page, sharing one connection to everyone else.

import { describe, it, expect } from "vitest";
import { FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { LoopbackNetwork, LocalHub } from "../index.js";
import { MEMBER } from "@tessera/sim";
import { agreed, run, table, clickAround } from "./harness.js";

const ping = (step: number): Frame => ({ t: FRAME.SNAPSHOT_REQUEST, step });

describe("a local hub", () => {
  it("keeps the mesh id for the first port", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    expect(hub.port().id).toBe("page");
    expect(hub.port().id).not.toBe("page");
    hub.close();
  });

  it("delivers a broadcast sideways but not back to its sender", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    const heardA: string[] = [];
    const heardB: string[] = [];
    a.listen((from) => heardA.push(from));
    b.listen((from) => heardB.push(from));

    a.broadcast(ping(1));
    expect(heardA).toEqual([]);
    expect(heardB).toEqual(["page"]);
    hub.close();
  });

  it("offers a remote frame to every port", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    const seen: string[] = [];
    a.listen(() => seen.push("a"));
    b.listen(() => seen.push("b"));

    const far = net.connect("far");
    far.broadcast(ping(2));
    net.flush();
    expect(seen.sort()).toEqual(["a", "b"]);
    hub.close();
  });

  it("routes a reply to a sibling locally and to a stranger over the wire", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    const far = net.connect("far");
    let toB = 0;
    let toFar = 0;
    b.listen(() => toB++);
    far.listen(() => toFar++);

    a.send(b.id, ping(3));
    expect(toB).toBe(1);
    expect(net.pending()).toBe(0); // nothing left the page

    a.send("far", ping(4));
    net.flush();
    expect(toFar).toBe(1);
    hub.close();
  });

  it("counts its siblings among a port's peers", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    net.connect("far");
    expect([...a.peers()].sort()).toEqual([b.id, "far"].sort());
    hub.close();
  });

  // A driver that broadcasts while handling a frame must not recurse into a
  // second delivery halfway through the first, or two drivers see the same
  // sequence of frames in different orders.
  it("finishes one delivery before starting the next", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    const c = hub.port();
    const order: string[] = [];
    a.listen(() => order.push("a"));
    b.listen((_, frame) => {
      order.push("b");
      if ((frame as { step: number }).step === 1) b.broadcast(ping(9));
    });
    c.listen(() => order.push("c"));

    a.broadcast(ping(1));
    // b and c both hear the first frame before either hears b's answer.
    expect(order).toEqual(["b", "c", "a", "c"]);
    hub.close();
  });

  it("stops delivering once closed", () => {
    const net = new LoopbackNetwork();
    const hub = new LocalHub(net.connect("page"));
    const a = hub.port();
    const b = hub.port();
    let heard = 0;
    b.listen(() => heard++);
    hub.close();
    a.broadcast(ping(5));
    expect(heard).toBe(0);
  });
});

describe("a bot seated in someone else's page", () => {
  it("plays its seat and stays in step with the rest of the game", async () => {
    // e1 is two people and a bot, all three of whom would desync if the bot's
    // moves reached the mesh and not its own page.
    const t = await table({ seats: [2, 1], bots: [1, 0], hosted: true, botInterval: 6 });
    expect(t.hubs.length).toBe(1);

    await run(t, 60, await clickAround(t, 5));

    expect(agreed(t)).toBe(true);
    const bot = t.peers.find((peer) => peer.bot)!;
    expect(bot.driver.nextSeq).toBeGreaterThan(0); // it actually moved
    expect(t.peers.every((peer) => peer.ejections.length === 0)).toBe(true);
    expect(t.peers.every((peer) => peer.desyncs.length === 0)).toBe(true);

    const roster = bot.driver.roster.seatOf(bot.identity!.key)!;
    expect(roster.kind).toBe(MEMBER.BOT);
  });
});
