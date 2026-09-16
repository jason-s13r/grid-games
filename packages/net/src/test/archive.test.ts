// What an observer is *for*.
//
// A peer with no seat already validates every move and holds the same world as
// everyone else. The question these tests answer is whether what it writes down
// is worth anything to somebody who was not there — which means two things and
// not one: that replaying the file reaches the hash the table agreed on, and
// that every input in it can be traced to a key the genesis record names.
//
// The second is the half that makes a leaderboard checkable. A log that only
// replays proves that *some* game happened; a log whose signatures verify
// proves it was this one, played by these people.

import { beforeAll, describe, expect, it } from "vitest";
import { MOVE, Sim, hex } from "@tessera/sim";
import {
  CHANNEL,
  Identity,
  composeGenesis,
  proposalFrom,
  proposalId,
  sealGenesis,
  signConsent,
} from "@tessera/protocol";
import type { SignedMove } from "@tessera/protocol";
import { ARCHIVE_FORMAT, Archive, consentLine, verifyArchive } from "../index.js";
import type { ArchivedGame } from "../index.js";
import { clickAround, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** The archive an observer would have written, plus the table it watched. */
async function watched(): Promise<{ t: Table; game: ArchivedGame }> {
  const t = await table({ seats: [2, 1], observer: true, seed: 7 });
  const observer = t.peers.at(-1)!;
  const archive = new Archive(t.genesis, observer.driver);
  archive.attach(observer.driver);

  await run(t, 40, await clickAround(t, 5));
  const speaker = t.peers[0]!;
  await speaker.driver.say("good game");
  await speaker.driver.say("go for the middle", CHANNEL.TEAM);
  await settleNetwork(t);

  return { t, game: archive.toJSON() };
}

describe("an archived game", () => {
  let t: Table;
  let game: ArchivedGame;

  beforeAll(async () => {
    ({ t, game } = await watched());
  });

  it("is the record the peers agreed to play", () => {
    expect(game.genesis.gameId).toBe(t.gameId);
    // The number a reader checks before it trusts the shape. Asserted against
    // the constant rather than a literal: what matters is that an archive stamps
    // the format this build writes, and pinning the digit would make every
    // future bump a test edit that carries no information.
    expect(game.format).toBe(ARCHIVE_FORMAT);
  });

  it("kept every move that was applied", () => {
    expect(game.moveLog.length).toBeGreaterThan(0);
    // Claims and heartbeats both: an archive that dropped the heartbeats would
    // replay to a different world, because liveness is hashed state.
    const types = new Set(game.moveLog.map((entry) => ("move" in entry ? entry.move : entry).type));
    expect(types.has(MOVE.CLAIM)).toBe(true);
    expect(types.has(MOVE.HEARTBEAT)).toBe(true);
  });

  it("replays to the hash the table reached", () => {
    const sim = new Sim(game.genesis);
    sim.fastForward(game.steps, game.moveLog.map((entry) => ("move" in entry ? entry.move : entry)));
    expect(hex(sim.hash())).toBe(game.hash);
    expect(game.hash).toBe(hex(t.peers[0]!.driver.hash()));
  });

  it("verifies against the roster in the genesis record", async () => {
    const verdict = await verifyArchive(game);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.verified).toBe(game.moveLog.length);
    expect(verdict.hash).toBe(game.hash);
  });

  it("keeps chat, and keeps a team line sealed", () => {
    expect(game.messages).toHaveLength(2);
    const [open, team] = game.messages;
    expect(open!.message.body).toBe("good game");
    // The observer holds no key on that empire, so what it archived is what it
    // saw: ciphertext. An archive is not a place where privacy quietly lapses.
    expect(team!.message.channel).toBe(CHANNEL.TEAM);
    expect(team!.message.body).not.toContain("middle");
  });
});

describe("a doctored archive", () => {
  let game: ArchivedGame;

  beforeAll(async () => {
    ({ game } = await watched());
  });

  const copy = (): ArchivedGame => JSON.parse(JSON.stringify(game)) as ArchivedGame;

  it("is caught when a move is edited", async () => {
    const doctored = copy();
    const claim = doctored.moveLog.find(
      (entry): entry is SignedMove => "move" in entry && entry.move.type === MOVE.CLAIM,
    )!;
    claim.move.x += 1;

    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((one) => one.startsWith("bad signature"))).toBe(true);
  });

  it("is caught when a move is invented", async () => {
    const doctored = copy();
    doctored.moveLog.push({ step: 4, empire: 1, member: 0, seq: 9999, type: MOVE.CLAIM, x: 3, y: 3 });

    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("unsigned move at step 4");
  });

  it("is caught when a move is removed", async () => {
    const doctored = copy();
    const at = doctored.moveLog.findIndex(
      (entry) => "move" in entry && entry.move.type === MOVE.CLAIM,
    );
    doctored.moveLog.splice(at, 1);

    // Every signature still checks out — the forger removed a move rather than
    // writing one — so the only thing that catches this is the hash.
    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((one) => one.startsWith("hash mismatch"))).toBe(true);
  });

  it("is caught when the outcome is simply asserted", async () => {
    const doctored = copy();
    doctored.hash = "deadbeef";

    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.hash).toBe(game.hash);
  });

  it("is caught when it claims to be a different game", async () => {
    const doctored = copy();
    doctored.genesis.seed += 1;

    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("genesis: gameId");
  });
});

describe("an archive that does not retain", () => {
  it("emits every record and holds none of them", async () => {
    const t = await table({ seats: [1], observer: true, seed: 3 });
    const observer = t.peers.at(-1)!;
    const archive = new Archive(t.genesis, observer.driver, { retain: false });
    const records: string[] = [];
    archive.onRecord = (record) => records.push(record.k);
    archive.attach(observer.driver);

    await run(t, 20, await clickAround(t, 5));

    expect(records.length).toBeGreaterThan(0);
    expect(archive.size).toBe(records.length);
    // The sink is the archive; what stays behind is a header and nothing else.
    expect(archive.toJSON().moveLog).toHaveLength(0);
    expect(archive.steps).toBe(observer.driver.step);
  });
});

// The one move in a log that carries no signature of its own. Its authority is
// the endorsements on the amendment that produced it, which is why the archive
// keeps those separately and why verification would otherwise have to either
// reject the log or wave the move through.
describe("an archive of a game that seated someone mid-way", () => {
  let game: ArchivedGame;

  beforeAll(async () => {
    const t = await table({ seats: [1, 1], observer: true, seed: 5 });
    const observer = t.peers.at(-1)!;
    const archive = new Archive(t.genesis, observer.driver);
    archive.attach(observer.driver);

    await run(t, 10);
    const substitute = await Identity.generate();
    await t.peers[0]!.driver.amend(substitute.key); // a solo empire is its own quorum
    await settleNetwork(t);
    await run(t, 60);

    game = archive.toJSON();
  });

  it("kept the endorsements the seat rests on", () => {
    expect(game.amendments).toHaveLength(1);
    expect(game.amendments[0]!.signatures.length).toBeGreaterThan(0);
  });

  it("carries the seat arrival as an unsigned move", () => {
    const arrivals = game.moveLog.filter(
      (entry) => !("move" in entry) && entry.type === MOVE.ROSTER_AMEND,
    );
    expect(arrivals).toHaveLength(1);
  });

  it("verifies anyway, because the amendment is the authority", async () => {
    const verdict = await verifyArchive(game);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("but not once the endorsements are taken away", async () => {
    const doctored = JSON.parse(JSON.stringify(game)) as ArchivedGame;
    doctored.amendments = [];

    const verdict = await verifyArchive(doctored);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((one) => one.startsWith("unsigned move"))).toBe(true);
  });
});

describe("what an archive says about consent", () => {
  // An archive could already prove what happened. It could not prove anybody
  // agreed to the rules it happened under — which starts mattering the moment
  // there is a leaderboard and a disputed game.
  async function agreed(over: Record<string, unknown> = {}) {
    const people = await Promise.all([Identity.generate(), Identity.generate()]);
    const world = proposalFrom({
      seed: 99,
      startedAt: 0,
      map: { width: 24, height: 24 },
      ...over,
    });
    const id = await proposalId(world);
    const consents = await Promise.all(people.map((one) => signConsent(one, id)));
    return { genesis: await sealGenesis(composeGenesis(world, consents)), people };
  }

  const logOf = (genesis: Awaited<ReturnType<typeof agreed>>["genesis"]): ArchivedGame => {
    const sim = new Sim(genesis);
    sim.fastForward(4, []);
    return {
      format: ARCHIVE_FORMAT,
      genesis,
      from: 0,
      steps: 4,
      hash: hex(sim.hash()),
      moveLog: [],
    };
  };

  it("says how many seats signed the world it was played under", async () => {
    const { genesis } = await agreed();
    const verdict = await verifyArchive(logOf(genesis));
    expect(verdict.ok, verdict.problems.join(", ")).toBe(true);
    expect(verdict.consent).toEqual({ state: "checked", signed: 2, seats: 2 });
    expect(consentLine(verdict.consent)).toBe("consent: 2 of 2 keyed seats signed this world");
  });

  // Every archive written before consent existed. "Not stated" is a fact about
  // the record, not a mark against it — which is the whole reason this is three
  // states and not a boolean.
  it("says nothing was stated when the record claims nothing", async () => {
    const { t, game } = await watched();
    const verdict = await verifyArchive(game);
    expect(verdict.consent.state).toBe("absent");
    expect(consentLine(verdict.consent)).toBe("consent: not stated");
    expect(verdict.ok, verdict.problems.join(", ")).toBe(true);
    t.stop?.();
  });

  it("a tampered consent list is failed, and is a problem as well", async () => {
    const { genesis } = await agreed();
    const forged = await sealGenesis({
      ...genesis,
      consent: genesis.consent!.map((one, at) =>
        at === 0 ? { ...one, sig: "not-a-signature" } : one,
      ),
    });
    const verdict = await verifyArchive(logOf(forged));
    expect(verdict.consent.state).toBe("failed");
    expect(verdict.problems).toContain("genesis: consent");
    expect(verdict.ok).toBe(false);
  });
});
