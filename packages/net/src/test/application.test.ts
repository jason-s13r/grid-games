// Knocking, and the two ways it could have gone wrong quietly.
//
// Before this, a peer with a key and no seat had **no channel to the game at
// all**: `amend` needs a seat to propose from, and `say` needs one to attribute
// a message to. The problem statement's "no move available except saying so in
// chat" is generous — there was no chat either.
//
// The obvious implementation is an amendment with no signatures on it, and it is
// refused on purpose: that record would both spread junk and hold the pipeline
// open at a step nobody was going to vote on, which is a free denial of service.
// So an application is its own record, signed by the person asking, and the two
// properties worth pinning are the ones that would fail silently:
//
//   1. **It carries no scheduling weight.** An outstanding application must not
//      move `amendCeiling` — the claim the DoS answer rests on, and the reason
//      the field has a getter.
//   2. **Agreeing is two different calls.** The first member of an empire to say
//      yes starts a proposal; everybody after them signs the one that exists.
//      Get that wrong and a three-seat empire fails with no error anywhere: two
//      records at two steps, each one signature short, both drivers having spent
//      the single endorsement they are allowed for that key.

import { describe, expect, it } from "vitest";
import { FRAME, signApplication, verifyApplication } from "@tessera/protocol";
import { agreed, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

const peer = (t: Table, name: string) => t.peers.find((one) => one.name === name)!;

/** Everybody seated on that empire, so a test can walk a quorum through it. */
const members = (t: Table, empire: number) =>
  t.peers.filter((one) => one.seat?.empire === empire);

describe("a peer with a key and no seat", () => {
  it("can ask, and the empire's members hear about it", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    const asking = peer(t, "a1");
    const heard: number[] = [];
    peer(t, "e1m0").driver.onApplication = (application) => heard.push(application.empire);

    expect(await asking.driver.apply(1)).toBe(true);
    await settleNetwork(t);
    await run(t, 4);

    expect(heard).toEqual([1]);
    expect(peer(t, "e1m0").driver.applications()).toHaveLength(1);
  });

  it("is not on anybody else's list", async () => {
    // The whole of the flood answer in one assertion: a driver stores only what
    // is addressed to its own empire, so an opponent's applicants are a list it
    // never held and cannot have evicted anything from.
    const t = await table({ seats: [1, 1], applicants: 1 });
    await peer(t, "a1").driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);
    expect(peer(t, "e2m0").driver.applications()).toHaveLength(0);
  });

  it("cannot ask for a seat it already holds", async () => {
    const t = await table({ seats: [1, 1] });
    expect(await peer(t, "e1m0").driver.apply(2)).toBe(false);
  });

  it("is refused by a full empire rather than left waiting on it", async () => {
    // Four seats is the cap, checked in `validate` on every amendment, so a
    // request to a full empire is one no quorum could ever pass. An applicant
    // told no can ask somebody else; an applicant left waiting cannot tell the
    // difference between patience and a rule.
    const t = await table({ seats: [4, 1], applicants: 1 });
    expect(await peer(t, "a1").driver.apply(1)).toBe(false);
    expect(await peer(t, "a1").driver.apply(2)).toBe(true);
  });

  it("is refused by an empire that no longer exists", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    t.peers.forEach((one) => {
      one.driver.sim.state.empires[1]!.alive = 0;
    });
    expect(await peer(t, "a1").driver.apply(2)).toBe(false);
  });

  it("is refused once the join window has closed", async () => {
    // A seat that cannot be added is a request that cannot be answered. Same
    // window expression the simulation uses, read off the record.
    const t = await table({ seats: [1, 1], applicants: 1, rules: { joinWindow: 20 } });
    await run(t, 30);
    expect(await peer(t, "a1").driver.apply(1)).toBe(false);
  });
});

describe("an application holds nothing open", () => {
  it("does not move the ceiling, which is what makes it not a denial of service", async () => {
    // The claim the whole record shape exists for. An unsigned amendment would
    // pin `amendCeiling` below a step nobody was going to vote on; an
    // application names no step the pipeline must reach.
    const t = await table({ seats: [1, 1], applicants: 1 });
    const watcher = peer(t, "e1m0").driver;
    expect(watcher.ceiling).toBe(Number.MAX_SAFE_INTEGER);

    await peer(t, "a1").driver.apply(1);
    await settleNetwork(t);
    await run(t, 8);

    expect(watcher.applications()).toHaveLength(1);
    expect(watcher.ceiling).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("and the proposal it becomes does, which is the contrast", async () => {
    // Three seats, so the proposal is still outstanding when this is read. On a
    // one-seat empire the proposer *is* the quorum, so it carries in the same
    // call, books onto its step, and the ceiling is already released again —
    // which is correct and says nothing about the distinction being drawn.
    const t = await table({ seats: [3, 1], applicants: 1 });
    const holder = members(t, 1)[0]!;
    await peer(t, "a1").driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);

    await holder.driver.admit(1, peer(t, "a1").identity!.key);
    // A carried amendment books onto a step, and every peer has to know the
    // outcome before it simulates that step.
    expect(holder.driver.ceiling).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe("saying yes", () => {
  it("seats the applicant on a one-seat empire, on every peer", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    const asking = peer(t, "a1");
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);

    expect(await peer(t, "e1m0").driver.admit(1, asking.identity!.key)).toBe(true);
    await settleNetwork(t);
    await run(t, 60);

    for (const one of t.peers) {
      expect(one.driver.roster.has(asking.identity!.key)).toBe(true);
    }
    expect(asking.driver.seat).toEqual({ empire: 1, member: 1 });
    expect(agreed(t)).toBe(true);
  });

  it("needs two of three on a three-seat empire, and the second click is an endorsement", async () => {
    // The lead finding, asserted. If the second member's `admit` built a fresh
    // proposal instead of signing the standing one, there would be two records
    // at two steps, each one signature short of two, and nothing would ever
    // carry — with no error at any point.
    const t = await table({ seats: [3, 1], applicants: 1 });
    const asking = peer(t, "a1");
    const [first, second] = members(t, 1);
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);

    expect(await first!.driver.admit(1, asking.identity!.key)).toBe(true);
    await settleNetwork(t);
    // One of two: not seated yet.
    expect(first!.driver.roster.has(asking.identity!.key)).toBe(false);

    expect(await second!.driver.admit(1, asking.identity!.key)).toBe(true);
    await settleNetwork(t);
    await run(t, 60);

    expect(first!.driver.roster.has(asking.identity!.key)).toBe(true);
    expect(agreed(t)).toBe(true);
  });

  it("refuses a second click from somebody whose endorsement is already spent", async () => {
    // Refused here rather than dropped at the tally, where it is the same
    // silent no-op as a stranger's forgery — correct for the forgery, useless
    // to the member who clicked.
    const t = await table({ seats: [3, 1], applicants: 1 });
    const asking = peer(t, "a1");
    const [first] = members(t, 1);
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);

    expect(await first!.driver.admit(1, asking.identity!.key)).toBe(true);
    expect(await first!.driver.admit(1, asking.identity!.key)).toBe(false);
  });

  it("refuses a member of another empire admitting somebody else's applicant", async () => {
    // `amend` reads the empire off our own seat and ignores what it is told, so
    // an unguarded forward from a list showing every empire's applicants would
    // seat that person on the clicker's team — silently, signed, and correct as
    // far as every peer is concerned.
    const t = await table({ seats: [1, 1], applicants: 1 });
    const asking = peer(t, "a1");
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);
    expect(await peer(t, "e2m0").driver.admit(1, asking.identity!.key)).toBe(false);
  });

  it("refuses somebody who never asked", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    expect(await peer(t, "e1m0").driver.admit(1, peer(t, "a1").identity!.key)).toBe(false);
  });
});

describe("a standing request is re-signed, not remembered", () => {
  it("still seats after thousands of steps, at a fresh step", async () => {
    // The stale-step claim. `step` is "still asking, as of", so a request made
    // long ago becomes an amendment at `sim.step + AMENDMENT_DELAY` — it cannot
    // land in the past, which is the case that would otherwise be repaired by a
    // snapshot round trip.
    const t = await table({ seats: [1, 1], applicants: 1 });
    const asking = peer(t, "a1");
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 900);

    expect(peer(t, "e1m0").driver.applications()).toHaveLength(1);
    expect(await peer(t, "e1m0").driver.admit(1, asking.identity!.key)).toBe(true);
    await settleNetwork(t);
    await run(t, 60);
    expect(asking.driver.roster.has(asking.identity!.key)).toBe(true);
    expect(t.peers.every((one) => one.desyncs.length === 0)).toBe(true);
  });

  it("disappears when its owner stops asking", async () => {
    // Nothing withdraws it: it simply stops being renewed. Which is the
    // behaviour a list of people who are still interested needs, and the reason
    // the record is repeated rather than stored once.
    const t = await table({ seats: [1, 1], applicants: 1 });
    const asking = peer(t, "a1");
    await asking.driver.apply(1);
    await settleNetwork(t);
    await run(t, 4);
    expect(peer(t, "e1m0").driver.applications()).toHaveLength(1);

    asking.driver.withdraw();
    await run(t, 900);
    expect(peer(t, "e1m0").driver.applications()).toHaveLength(0);
  });
});

describe("what the list will not accept", () => {
  it("drops a forged application and does not gossip it", async () => {
    const t = await table({ seats: [1, 1], applicants: 2 });
    const one = peer(t, "a1");
    const two = peer(t, "a2");
    const signed = await signApplication(one.identity!, t.gameId, {
      empire: 1,
      step: 4,
    });
    // Right shape, wrong signer: the record names whose seat it is asking for,
    // so changing the name invalidates it.
    const forged = { ...signed, application: { ...signed.application, key: two.identity!.key } };
    expect(await verifyApplication(t.gameId, forged)).toBe(false);

    t.net.connect("stranger").broadcast({ t: FRAME.APPLICATION, signed: forged });
    await settleNetwork(t);
    await run(t, 4);
    expect(peer(t, "e1m0").driver.applications()).toHaveLength(0);
  });

  it("drops one naming a step nothing could be standing behind", async () => {
    const t = await table({ seats: [1, 1], applicants: 1 });
    const far = await signApplication(peer(t, "a1").identity!, t.gameId, {
      empire: 1,
      step: 4_000_000_000,
    });
    t.net.connect("stranger").broadcast({ t: FRAME.APPLICATION, signed: far });
    await settleNetwork(t);
    expect(peer(t, "e1m0").driver.applications()).toHaveLength(0);
  });

  it("holds at the cap under a flood of throwaway keys, and keeps playing", async () => {
    // Key generation is free, so the cap is the only defence — and it is per
    // empire, which is why a flood costs its target one list rather than costing
    // every empire every list.
    const t = await table({ seats: [1, 1], applicants: 1 });
    const wire = t.net.connect("stranger");
    const { Identity } = await import("@tessera/protocol");
    for (let i = 0; i < 64; i++) {
      const throwaway = await Identity.generate();
      const signed = await signApplication(throwaway, t.gameId, { empire: 1, step: 2 });
      wire.broadcast({ t: FRAME.APPLICATION, signed });
    }
    await settleNetwork(t);
    await run(t, 8);

    expect(peer(t, "e1m0").driver.applications().length).toBeLessThanOrEqual(32);
    expect(agreed(t)).toBe(true);
  });
});
