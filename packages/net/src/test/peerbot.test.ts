// A bot covering a seat in a human empire — the night shift.
//
// The whole point is that it is an ordinary peer. It signs, it heartbeats, it
// promises readiness, and so the teammates still awake are never blocked by it.
// What makes it a bot is only what the rules charge a BOT member: half rate, a
// lower cap, and coin claims that fire without chaining.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER, Rng, STAT, Sim } from "@tessera/sim";
import { PeerBot } from "../index.js";
import { agreed, clickAround, run, table } from "./harness.js";
import type { Table } from "./harness.js";

describe("a bot covers a seat", () => {
  let t: Table;
  let bot: Table["peers"][number];
  let human: Table["peers"][number];

  beforeAll(async () => {
    // Empire 1: one human and one bot sharing territory. Empire 2: a human.
    t = await table({ seats: [1, 1], bots: [1, 0] });
    await run(t, 240, await clickAround(t, 30));
    human = t.peers[0]!;
    bot = t.peers[1]!;
  });

  it("the bot holds a seat in a human empire", () => {
    expect(bot.seat).toEqual({ empire: 1, member: 1 });
    expect(t.genesis.empires[0]!.members[1]!.kind).toBe(MEMBER.BOT);
  });

  it("every peer still holds the same state", () => expect(agreed(t)).toBe(true));

  it("nobody was ejected and nothing arrived late", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
    expect(t.peers.reduce((sum, peer) => sum + peer.driver.lateMoves, 0)).toBe(0);
  });

  // The failure this guards against is a bot that connects, heartbeats, and
  // then never plays — which looks fine on every hash and loses the game.
  it("it actually spent its timer", () => {
    const member = bot.driver.sim.state.empires[0]!.members[1]!;
    expect(member.stats.some((n) => n > 0)).toBe(true);
  });

  it("and it never blocked the seats still playing", () => {
    expect(human.driver.blockedOn()).toEqual([]);
  });
});

describe("what a bot seat costs the empire", () => {
  // The rate, the cap and the cascade depth are rules, and packages/sim tests
  // them directly. What is worth checking here is that a BOT member is charged
  // them inside a *human* empire — the seat a PeerBot exists to fill — and not
  // only inside a SimBot one.
  let t: Table;

  beforeAll(async () => {
    // An interval past the length of the run: the bot is seated and connected
    // but never spends, so what is left is the accrual on its own.
    t = await table({ seats: [1, 1], bots: [1, 0], botInterval: 100_000 });
    await run(t, 240);
  });

  it("a bot seat accrues at half the human rate beside it", () => {
    const [alive, nightshift] = t.peers[0]!.driver.sim.state.empires[0]!.members;
    // Halved by an accumulator rather than a division, so on an odd step the
    // bot is holding the remainder rather than a fraction.
    expect(nightshift!.popTimer).toBe(Math.floor(alive!.popTimer / 2));
  });

  it("and it is still a live seat nobody is waiting on", () => {
    expect(t.peers[0]!.driver.blockedOn()).toEqual([]);
  });
});

describe("a bot's randomness stays out of the shared stream", () => {
  // A SimBot must draw from the seeded stream because every peer re-derives its
  // moves. A PeerBot's moves are validated rather than derived, so a draw it
  // made on its own peer and nowhere else would move that peer's RNG alone —
  // the quietest possible desync.
  it("deciding does not advance the simulation's rng", async () => {
    const t = await table({ seats: [1, 1], bots: [1, 0] });
    await run(t, 60);

    const driver = t.peers[1]!.driver;
    const sim: Sim = driver.sim;
    const before = sim.state.rng.s;
    const hash = sim.hash();

    const solo = new PeerBot({ lockstep: driver, rng: new Rng(1234) });
    for (let i = 0; i < 20; i++) solo.decide();

    expect(sim.state.rng.s).toBe(before);
    expect(sim.hash()).toBe(hash);
  });
});

// The balance lever an always-on seat needs.
//
// A bot that is resting must not look like a bot that has crashed — to the
// simulation or to the mesh. It keeps pumping, so it keeps heartbeating and
// keeps promising readiness; it simply stops spending. Getting this wrong in
// either direction is bad: a bot that stops pumping is dropped for stalling and
// the empire loses the seat, and a bot that keeps spending was never resting.
describe("a resting bot", () => {
  let t: Table;
  let bot: PeerBot;
  let seat: Table["peers"][number];
  let human: Table["peers"][number];

  beforeAll(async () => {
    t = await table({ seats: [1, 1], bots: [1, 0] });
    seat = t.peers[1]!;
    human = t.peers[0]!;
    // Replace the harness's bot with one that is never awake.
    bot = new PeerBot({ lockstep: seat.driver, awake: () => false });
    seat.bot = bot;
    await run(t, 240, await clickAround(t, 30));
  });

  it("says so, rather than looking broken", () => expect(bot.resting).toBe(true));

  it("spends nothing, and banks it instead", () => {
    const member = seat.driver.sim.state.empires[0]!.members[1]!;
    expect(member.stats[STAT.POP_SPENT]).toBe(0);
    // Which is what makes a rest a rest rather than a waste: the population is
    // still there in the morning.
    expect(member.popTimer).toBeGreaterThan(0);
  });

  // The one move a resting bot still makes, and the reason its seat survives.
  it("but goes on answering, because a heartbeat is not spending", () => {
    const member = seat.driver.sim.state.empires[0]!.members[1]!;
    expect(member.stats[STAT.MOVES]).toBeGreaterThan(0);
  });

  it("but keeps its seat, because it never stopped answering", () => {
    expect(t.peers.flatMap((peer) => peer.ejections)).toEqual([]);
    expect(human.driver.blockedOn()).toEqual([]);
    expect(agreed(t)).toBe(true);
  });
});

describe("how a bot is told to play", () => {
  let t: Table;

  beforeAll(async () => {
    t = await table({ seats: [1, 1, 1], bots: [1, 0, 0] });
    await run(t, 240, await clickAround(t, 30));
  });

  const botFor = (options: Partial<ConstructorParameters<typeof PeerBot>[0]> = {}): PeerBot =>
    new PeerBot({ lockstep: t.peers[1]!.driver, ...options });

  // Faster than the genesis rule is not on offer: an always-on seat that
  // out-reflexed the people it covers for is the one thing it must not be.
  it("cannot be asked to act faster than the rules allow", () => {
    const floor = t.genesis.rules.botActionInterval;
    const eager = botFor({ interval: 1 });
    const patient = botFor({ interval: floor * 10 });
    // Read through decide()'s effect rather than a private field: an eager bot
    // and a floored one are the same bot.
    expect(eager["interval"]).toBe(floor);
    expect(patient["interval"]).toBe(floor * 10);
  });

  it("attacks a named empire rather than the nearest", () => {
    const state = t.peers[1]!.driver.sim.state;
    const focused = botFor({ mode: "attack", target: 3 });
    // Its focus is empire 3's capital, whoever happens to be closer.
    expect(focused["focus"](state, 1)).toBe(3);
  });

  it("takes them in turn when asked to rotate", () => {
    const state = t.peers[1]!.driver.sim.state;
    const rotating = botFor({ mode: "attack", target: "rotate" });
    const chosen = rotating["focus"](state, 1);
    expect(chosen).not.toBe(1); // never ourselves
    expect(state.empires.some((one) => one.id === chosen && one.alive)).toBe(true);
  });

  it("and asks the simulation to choose when it is not told", () => {
    const state = t.peers[1]!.driver.sim.state;
    expect(botFor({ mode: "attack" })["focus"](state, 1)).toBeUndefined();
  });

  // "cycle" is the absence of a forced mode, which is also what re-opens the
  // coin grab — a pinned bot skips coins, because taking one is expansion.
  it("can be let off the leash entirely", () => {
    const cycling = botFor({ mode: "cycle" });
    expect(cycling.decide()).not.toBeNull();
  });
});
