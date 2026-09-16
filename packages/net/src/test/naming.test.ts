// A name over a real mesh.
//
// `protocol`'s naming suite pins the record and the store. What it cannot see is
// the two things that make a name different from a chat line, and both are
// properties of a running game rather than of a function:
//
//   * **A name is persistent UI state.** A missed chat line scrolls away; a
//     missed name leaves a peer showing bare hex for the rest of the game with
//     nothing that would ever fix it. `Transport` has no connection hook, so the
//     re-assert and the first-sight answer are the whole recovery story.
//   * **A name must not be able to desync anything.** It is signed and
//     attributable and never hashed, which is only worth saying if a run with
//     names in it reaches the same hash as one without.

import { describe, expect, it } from "vitest";
import { FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { agreed, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

const seated = (t: Table) => t.peers.filter((peer) => peer.seat && peer.identity);

describe("names over a mesh", () => {
  it("reaches everybody, and is keyed by the person", async () => {
    const t = await table({ seats: [1, 1] });
    const [alice, bob] = seated(t);

    await alice!.driver.rename("master5o1");
    await bob!.driver.rename("neighbour");
    await settleNetwork(t);

    for (const peer of seated(t)) {
      expect(peer.driver.nameOf(alice!.identity!.key)).toBe("master5o1");
      expect(peer.driver.nameOf(bob!.identity!.key)).toBe("neighbour");
    }
    // Our own name is not news we hear from somebody else.
    expect(alice!.driver.nameOf(alice!.identity!.key)).toBe("master5o1");
  });

  it("is cleaned on the way in, by the reader", async () => {
    const t = await table({ seats: [1, 1] });
    const [alice, bob] = seated(t);

    await alice!.driver.rename("alice‮evil");
    await settleNetwork(t);

    // The bidi override would otherwise reverse the fingerprint rendered beside
    // it, which is the entire anti-impersonation story.
    expect(bob!.driver.nameOf(alice!.identity!.key)).toBe("aliceevil");
  });

  it("does not move the hash, which is the whole reason it is safe", async () => {
    const quiet = await table({ seats: [2, 1], seed: 4242 });
    await run(quiet, 60);
    const without = quiet.peers[0]!.driver.sim.hash();

    const chatty = await table({ seats: [2, 1], seed: 4242 });
    await run(chatty, 60, async (step) => {
      if (step % 7 !== 0) return;
      for (const peer of seated(chatty)) await peer.driver.rename(`peer-${step}`);
    });

    expect(chatty.peers[0]!.driver.sim.hash()).toBe(without);
    expect(agreed(chatty)).toBe(true);
  });

  // The failure the appendix predicted: a single broadcast reaches whoever
  // happened to be connected in that instant, and a name is not something that
  // can be missed and forgotten.
  it("survives a peer that was not listening when it was first said", async () => {
    let deaf = true;
    const t = await table({
      seats: [1, 1],
      loopback: { drop: (_from, to, frame: Frame) => deaf && to === "e2m0" && frame.t === FRAME.NAME },
    });
    const [alice, bob] = seated(t);

    await alice!.driver.rename("master5o1");
    await settleNetwork(t);
    expect(bob!.driver.nameOf(alice!.identity!.key)).toBe("");

    // The wire comes back, and bob says his own name for the first time. Alice
    // answers a key she has never heard from with hers, which is what makes a
    // late arrival learn the names of everybody already here.
    deaf = false;
    await bob!.driver.rename("neighbour");
    await settleNetwork(t);
    await settleNetwork(t);

    expect(alice!.driver.nameOf(bob!.identity!.key)).toBe("neighbour");
    expect(bob!.driver.nameOf(alice!.identity!.key)).toBe("master5o1");
  });

  it("tells a screen only when what it would render actually changed", async () => {
    const t = await table({ seats: [1, 1] });
    const [alice, bob] = seated(t);

    const heard: string[] = [];
    bob!.driver.onNamed = (_key, name) => heard.push(name);

    await alice!.driver.rename("master5o1");
    await settleNetwork(t);
    await alice!.driver.rename("master5o1");
    await settleNetwork(t);
    await alice!.driver.rename("someone else");
    await settleNetwork(t);

    expect(heard).toEqual(["master5o1", "someone else"]);
  });

  it("a seatless peer cannot name itself, because nothing could check it", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    const watcher = t.peers.find((peer) => !peer.seat && peer.identity);
    expect(watcher).toBeDefined();
    expect(await watcher!.driver.rename("lurker")).toBe(false);
  });

  // The additive-frame rule, from the other side.
  it("an old build drops a name frame and keeps playing", async () => {
    const t = await table({
      seats: [2, 1],
      loopback: { drop: (_from, to, frame: Frame) => to === "e1m1" && frame.t === FRAME.NAME },
    });
    await run(t, 48, async (step) => {
      if (step % 8 !== 0) return;
      for (const peer of seated(t)) await peer.driver.rename(`peer-${step}`);
    });
    expect(agreed(t)).toBe(true);
  });
});
