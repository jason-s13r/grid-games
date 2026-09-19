// A table anybody can check, and a total nobody can replay.
//
// Two claims hold this service's leaderboard up, and both are checked here
// rather than argued.
//
// The first: **the window table equals a local `rankArchives` over the same
// corpus.** The response ships the ids it counted; a reader fetches those files
// from this same service, runs the client's own function over them, and must get
// the same table. If that ever fails, the endpoint is a claim rather than a
// derivation and the reason for hosting it is gone. So the test does exactly
// that — fetches the corpus back over HTTP and re-derives it — rather than
// comparing two calls into the same object.
//
// The second: **an accumulated all-time table equals a recomputed one over the
// same games.** Every column is a sum or a maximum and both are monoids, so this
// should be equality rather than approximation. A monoid argument is easy to get
// subtly wrong, and the failure would be silent: the table still looks like a
// table.

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CONTROL, MEMBER, MOVE, Sim, hex, makeGenesis } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import { Identity, sealGenesis, signMove } from "@tessera/protocol";
import type { SignedMove } from "@tessera/protocol";
import { ARCHIVE_FORMAT, rankArchives, standingsFrom } from "@tessera/net";
import type { ArchivedGame, Leaderboard } from "@tessera/net";
import { fetchArchive } from "../../../web/src/net/archives.js";
import { Board } from "../board.js";
import { MemoryArchives, MemoryStore } from "../db.js";
import { Ingest } from "../ingest.js";
import { MemoryApplied, Rankings } from "../rank.js";
import type { Applied } from "../rank.js";
import { MemoryBlobs } from "../store.js";
import { serve } from "../serve.js";

interface Seated {
  genesis: Genesis;
  players: Identity[];
}

/** A game with two keyed seats and one SimBot empire. The bot is there on
 *  purpose: it holds no key, so it must contribute no row, and a table that
 *  credited it would be crediting nobody. */
async function game(seed: number): Promise<Seated> {
  const one = await Identity.generate();
  const two = await Identity.generate();
  const genesis = await sealGenesis(
    makeGenesis({
      seed,
      startedAt: 0,
      map: { width: 24, height: 24 },
      empires: [
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: one.key }] },
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: two.key }] },
        { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
      ],
    }),
  );
  return { genesis, players: [one, two] };
}

/** One archive of that game, `steps` long. Both seats move, so both have a row
 *  and the sums are not all zero. */
async function archiveOf(seated: Seated, steps = 40): Promise<ArchivedGame> {
  const { genesis, players } = seated;
  const sim = new Sim(genesis);
  const moveLog: Array<SignedMove | Move> = [];
  const seq = [0, 0];
  for (let step = 0; step < steps; step++) {
    const moves: Move[] = [];
    for (const [at, player] of players.entries()) {
      if (step % 6 !== at * 3) continue;
      const move: Move = {
        step,
        empire: at + 1,
        member: 0,
        seq: seq[at]!++,
        type: MOVE.HEARTBEAT,
        x: 0,
        y: 0,
      };
      const envelope = await signMove(player, genesis.gameId!, move);
      moveLog.push(envelope);
      moves.push(envelope.move);
    }
    sim.advance(moves);
  }
  return {
    format: ARCHIVE_FORMAT,
    genesis,
    moveLog,
    amendments: [],
    messages: [],
    steps,
    hash: hex(sim.hash()),
  };
}

const running: Server[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

interface Stood {
  base: string;
  ingest: Ingest;
  rankings: Rankings;
  blobs: MemoryBlobs;
  archives: MemoryArchives;
}

async function stand(options: { keep?: number } = {}): Promise<Stood> {
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1_000);
  const archives = new MemoryArchives();
  const blobs = new MemoryBlobs();
  const rankings = new Rankings({ archives, applied: new MemoryApplied(), now });
  const ingest = new Ingest({
    archives,
    blobs,
    rankings,
    now,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
  });
  const board = new Board({ store: new MemoryStore() });
  const server = serve({ board, ingest, rankings, bind: "127.0.0.1", port: 0, say: () => {} });
  running.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, ingest, rankings, blobs, archives };
}

async function upload(where: Stood, archive: ArchivedGame): Promise<void> {
  await fetch(`${where.base}/archives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(archive),
  });
  await where.ingest.idle();
}

interface Hosted extends Omit<Leaderboard, "counted"> {
  /** Null for all-time, and that is not "nothing counted": an all-time corpus
   *  is unbounded, so it is published at `/rankings/applied` instead. */
  counted: string[] | null;
  games: number;
  derivedAt: string;
  scope: string;
}

const table = async (base: string, query = ""): Promise<Hosted> =>
  (await (await fetch(`${base}/rankings${query}`)).json()) as Hosted;

describe("a table a reader can falsify", () => {
  it("equals a local rankArchives over the corpus it published", async () => {
    const where = await stand();
    const games = [await game(1), await game(2)];
    for (const one of games) await upload(where, await archiveOf(one));

    const hosted = await table(where.base);
    expect(hosted.counted).toHaveLength(2);

    // The recipe, done for real: take the ids the service says it counted,
    // fetch those files back from it, and re-derive the table with the client's
    // own function. Nothing here reaches into the service's objects.
    const files = [];
    for (const gameId of hosted.counted!) {
      files.push(await fetchArchive(`${where.base}/archives/${encodeURIComponent(gameId)}`));
    }
    const mine = await rankArchives(files);

    expect(hosted.standings).toEqual(mine.standings);
    expect(hosted.unfinished).toBe(mine.unfinished);
    expect(new Set(hosted.counted)).toEqual(new Set(mine.counted));
  });

  it("says what it is over, in the sentence that bounds it", async () => {
    const where = await stand();
    await upload(where, await archiveOf(await game(1)));

    // A hosted leaderboard that quietly drops the qualifier is the failure mode,
    // and it fails silently — the table looks identical either way.
    expect((await table(where.base)).scope).toMatch(/not every game ever played/);
    expect((await table(where.base, "?window=all")).scope).toMatch(/no longer held/);
  });

  it("serves its refusals rather than swallowing them", async () => {
    const where = await stand();
    const good = await game(1);
    const bad = await game(2);
    await upload(where, await archiveOf(good));
    await upload(where, { ...(await archiveOf(bad)), hash: "0000dead" });

    const hosted = await table(where.base);
    // A leaderboard that silently drops what it could not check is one nobody
    // can audit, and that is precisely the property the signatures were for.
    expect(hosted.counted).toEqual([good.genesis.gameId]);
    expect(hosted.refused.map((one) => one.game)).toEqual([bad.genesis.gameId]);
    expect(hosted.refused[0]!.problems.join(" ")).toMatch(/hash mismatch/);
  });

  it("credits no row to a seat nobody signed for", async () => {
    const where = await stand();
    const one = await game(1);
    await upload(where, await archiveOf(one));

    const hosted = await table(where.base);
    // Two keyed seats and one SimBot empire. The bot holds no key, so there is
    // nobody to credit — the players are exactly the seats with one.
    expect(hosted.standings).toHaveLength(2);
    expect(hosted.standings.map((row) => row.key).sort()).toEqual(
      one.players.map((player) => player.key).sort(),
    );
  });
});

describe("the all-time total, which is exact rather than approximate", () => {
  it("equals a recomputation over the same games", async () => {
    const where = await stand();
    const games = [await game(1), await game(2), await game(3)];
    const files = [];
    for (const one of games) {
      const archive = await archiveOf(one);
      files.push(archive);
      await upload(where, archive);
    }

    const accumulated = await table(where.base, "?window=all");
    const recomputed = await rankArchives(files);

    // The monoid claim, checked rather than argued: five sums and three maxima,
    // all associative and commutative with an identity, so a total folded one
    // game at a time equals the same total folded all at once. Equality, not an
    // approximation — nothing is estimated, nothing decays, no figure is a
    // sample.
    expect(accumulated.standings).toEqual(recomputed.standings);
    expect(accumulated.games).toBe(3);
  });

  it("does not depend on the order games were applied in", async () => {
    const orders = [
      [1, 2, 3],
      [3, 1, 2],
      [2, 3, 1],
    ];
    const made = new Map<number, ArchivedGame>();
    for (const seed of [1, 2, 3]) made.set(seed, await archiveOf(await game(seed)));

    const tables = [];
    for (const order of orders) {
      const where = await stand();
      for (const seed of order) await upload(where, made.get(seed)!);
      tables.push(await table(where.base, "?window=all"));
    }

    expect(tables[1]!.standings).toEqual(tables[0]!.standings);
    expect(tables[2]!.standings).toEqual(tables[0]!.standings);
  });

  it("does not double a key's games when one game arrives twice", async () => {
    const where = await stand();
    const one = await game(1);
    const archive = await archiveOf(one);
    await upload(where, archive);
    await upload(where, archive);

    const hosted = await table(where.base, "?window=all");
    expect(hosted.games).toBe(1);
    expect(hosted.standings.every((row) => row.games === 1)).toBe(true);
  });

  it("does not double it when the second copy is different bytes", async () => {
    const where = await stand();
    const one = await game(1);
    // Same game, two archives of it, materially different files. Keyed on a
    // hash of the bytes these would be two rows and every key in the game would
    // be counted twice; keyed on the game id they are one. `gameId` is a
    // SHA-256 over the canonical genesis, so it identifies the *game*.
    const short = await archiveOf(one, 24);
    const long = await archiveOf(one, 40);
    expect(JSON.stringify(short)).not.toBe(JSON.stringify(long));

    await upload(where, short);
    await upload(where, long);

    const hosted = await table(where.base, "?window=all");
    expect(hosted.games).toBe(1);
    expect(hosted.standings.every((row) => row.games === 1)).toBe(true);
  });

  it("supersedes an applied game with a longer archive of it, sums and maxima both", async () => {
    const where = await stand();
    const one = await game(1);
    const short = await archiveOf(one, 24);
    const long = await archiveOf(one, 40);

    await upload(where, short);
    const before = await table(where.base, "?window=all");
    await upload(where, long);
    const after = await table(where.base, "?window=all");

    // Whichever copy happened to arrive first must not become the game's
    // contribution forever: an observer that closed its laptop early and one
    // that ran on both produce a verifiable archive, and neither is wrong.
    const mine = await rankArchives([long]);
    expect(after.standings).toEqual(mine.standings);
    expect(after.games).toBe(1);
    expect(after.standings[0]!.moves).toBeGreaterThan(before.standings[0]!.moves);
  });
});

describe("what eviction costs each table", () => {
  it("leaves the all-time table untouched", async () => {
    const where = await stand({ keep: 1 });
    const games = [await game(1), await game(2)];
    const files = [];
    for (const one of games) {
      const archive = await archiveOf(one);
      files.push(archive);
      await upload(where, archive);
    }

    // The first game's file is gone and its contribution is not. A monoid does
    // not need its inputs back, which is the trade the retention rests on: a
    // few hundred bytes survive the megabytes.
    expect(await where.blobs.get(games[0]!.genesis.gameId!)).toBeNull();
    const all = await table(where.base, "?window=all");
    expect(all.standings).toEqual((await rankArchives(files)).standings);
    expect(all.games).toBe(2);
  });

  it("removes it from the window table entirely", async () => {
    const where = await stand({ keep: 1 });
    const games = [await game(1), await game(2)];
    for (const one of games) await upload(where, await archiveOf(one));

    const held = await table(where.base);
    // That table is defined as over the archives this service holds, so a game
    // whose file is gone is not in it — and the reader can tell, because the
    // ids it counted are the ids it will serve.
    expect(held.counted).toEqual([games[1]!.genesis.gameId]);
    expect(held.games).toBe(1);
  });

  it("publishes an applied-set complete enough to re-derive the total from", async () => {
    const where = await stand({ keep: 1 });
    for (const seed of [1, 2, 3]) await upload(where, await archiveOf(await game(seed)));

    const page = (await (await fetch(`${where.base}/rankings/applied`)).json()) as {
      applied: Applied[];
    };
    expect(page.applied).toHaveLength(3);

    // The narrowing that makes an all-time table worth having. Once a blob is
    // evicted a game's contribution is the service's own word — but the fold
    // over it is a pure function of a list the service publishes, so an
    // arithmetic error is visible without holding a single archive.
    const mine = standingsFrom(page.applied.map((row) => row.contribution));
    expect(mine.standings).toEqual((await table(where.base, "?window=all")).standings);
  });

  it("ships no inline corpus for all-time, and says so with null", async () => {
    const where = await stand();
    await upload(where, await archiveOf(await game(1)));

    // An all-time corpus is unbounded and shipping it inline would eventually
    // be the largest response this service has. Null rather than an empty list,
    // so a reader cannot mistake "fetch /rankings/applied" for "nothing counted".
    expect((await table(where.base, "?window=all")).counted).toBeNull();
    expect((await table(where.base)).counted).not.toBeNull();
  });
});
