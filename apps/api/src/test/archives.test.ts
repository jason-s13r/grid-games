// A store that trusts nobody to have written the files it holds.
//
// Every archive posted below is a real game: a real genesis, real signatures, a
// real simulation and the hash it actually reached. Nothing is stubbed, because
// the whole claim of this service is that it runs the same check a stranger
// would run — and a stubbed verifier would be the one thing that could make that
// claim false without any test noticing.
//
// The read path is exercised through `fetchArchive`, the web client's own
// function, rather than a hand-written fetch. It sends `accept:
// application/json`, a thirty-second deadline and nothing else, and it is the
// thing that actually has to work.

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CONTROL, MEMBER, MOVE, Sim, hex, makeGenesis } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import { Identity, sealGenesis, signMove } from "@tessera/protocol";
import type { SignedMove } from "@tessera/protocol";
import { ARCHIVE_FORMAT } from "@tessera/net";
import type { ArchivedGame } from "@tessera/net";
import { fetchArchive } from "../../../web/src/net/archives.js";
import { Board } from "../board.js";
import { MemoryArchives, MemoryStore } from "../db.js";
import { Ingest } from "../ingest.js";
import { MemoryBlobs } from "../store.js";
import { serve } from "../serve.js";

/** One game, from which several archives of it can be written. Two observers on
 *  one game is the normal way to keep an archive safe, and the copies they
 *  produce differ — so a fixture that could only make one archive per game could
 *  not reach the case this store is most careful about. */
interface Played {
  genesis: Genesis;
  identity: Identity;
}

async function game(seed = 21): Promise<Played> {
  const identity = await Identity.generate();
  const genesis = await sealGenesis(
    makeGenesis({
      seed,
      startedAt: 0,
      map: { width: 24, height: 24 },
      empires: [
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: identity.key }] },
        { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
      ],
    }),
  );
  return { genesis, identity };
}

/** One archive of that game, `steps` long and signed as the mesh would have
 *  signed it. */
async function archiveOf(played: Played, steps = 40): Promise<ArchivedGame> {
  const { genesis, identity } = played;
  const sim = new Sim(genesis);
  const moveLog: Array<SignedMove | Move> = [];
  let seq = 0;
  for (let step = 0; step < steps; step++) {
    const moves: Move[] = [];
    if (step % 12 === 0) {
      const move: Move = { step, empire: 1, member: 0, seq: seq++, type: MOVE.HEARTBEAT, x: 0, y: 0 };
      const envelope = await signMove(identity, genesis.gameId!, move);
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

/** The common case: a game, and one archive of it. */
const played = async (options: { seed?: number; steps?: number } = {}): Promise<ArchivedGame> =>
  archiveOf(await game(options.seed ?? 21), options.steps ?? 40);

const running: Server[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

interface Stood {
  base: string;
  ingest: Ingest;
  blobs: MemoryBlobs;
  archives: MemoryArchives;
}

async function stand(options: { keep?: number; now?: () => number } = {}): Promise<Stood> {
  const archives = new MemoryArchives();
  const blobs = new MemoryBlobs();
  const ingest = new Ingest({
    archives,
    blobs,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const board = new Board({ store: new MemoryStore() });
  const server = serve({ board, ingest, bind: "127.0.0.1", port: 0, say: () => {} });
  running.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/archives`, ingest, blobs, archives };
}

/** Post a game and wait for the replay. The queue is the point of the design —
 *  a ten-day game is ten million steps and cannot run on a request thread — so
 *  a test that did not wait would be asserting on a row mid-flight. */
async function upload(
  where: Stood,
  game: ArchivedGame,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await fetch(where.base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(game),
  });
  const body = (await answer.json()) as Record<string, unknown>;
  await where.ingest.idle();
  return { status: answer.status, body };
}

const corpus = async (
  base: string,
  query = "",
): Promise<{ archives: Array<Record<string, unknown>>; next?: string }> =>
  (await (await fetch(`${base}${query}`)).json()) as {
    archives: Array<Record<string, unknown>>;
    next?: string;
  };

describe("an archive on the way in", () => {
  it("is filed under the id it hashes to, never the one it claims", async () => {
    const where = await stand();
    const honest = await played();
    const real = honest.genesis.gameId!;

    // A genuine file, filed under a name that is not its own. Taking the
    // claimed id would let anybody put a game in the corpus under somebody
    // else's — so the id is recomputed, and the file is then refused on top,
    // because a record whose own `gameId` field is wrong is one no peer would
    // have agreed to play.
    const answer = await upload(where, {
      ...honest,
      genesis: { ...honest.genesis, gameId: "mine" },
    });

    expect(answer.body.gameId).toBe(real);
    const row = await where.archives.head(real);
    expect(row?.status).toBe("refused");
    expect(row?.problems.join(" ")).toMatch(/genesis/);
    expect(await where.archives.head("mine")).toBeUndefined();
  });

  it("verifies it the way a stranger would, and says so", async () => {
    const where = await stand();
    const { body } = await upload(where, await played());

    const row = await where.archives.head(String(body.gameId));
    expect(row?.status).toBe("held");
    expect(row?.verdict?.ok).toBe(true);
    // Off the replay rather than off the file: a result nobody had the chance
    // to assert, and a step count that was only a claim until now.
    expect(row?.winner).toBe(row?.verdict?.winner);
    expect(row?.steps).toBe(40);
  });

  it("refuses a tampered move and keeps the reasons", async () => {
    const where = await stand();
    const game = await played();
    const entry = game.moveLog[1] as SignedMove;
    // One field moved, after signing. The signature is real and the move is
    // not the one it covers.
    const broken = {
      ...game,
      moveLog: [...game.moveLog.slice(0, 1), { ...entry, move: { ...entry.move, x: 3 } }, ...game.moveLog.slice(2)],
    };

    const answer = await upload(where, broken);
    expect(answer.status).toBe(202);
    const row = await where.archives.head(String(answer.body.gameId));
    expect(row?.status).toBe("refused");
    expect(row?.problems.join(" ")).toMatch(/bad signature/);
    // The store holds verified games. A file that failed is a row saying so,
    // which is what makes the refusal auditable without making this a dump.
    expect(await where.blobs.get(String(answer.body.gameId))).toBeNull();
  });

  it("refuses a fragment, because it cannot be replayed from the start", async () => {
    const where = await stand();
    const game = await played();
    const answer = await upload(where, { ...game, from: 900 });

    const row = await where.archives.head(String(answer.body.gameId));
    expect(row?.status).toBe("refused");
    expect(row?.problems.join(" ")).toMatch(/begins at step 900/);
  });

  it("tells a file that is not a saved game from one that does not check out", async () => {
    const where = await stand();
    const answer = await fetch(where.base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "there" }),
    });
    // The shape check is not verification and the two have different sentences,
    // exactly as the web client keeps them apart.
    expect(answer.status).toBe(400);
  });

  it("cuts off a body larger than a game rather than buffering it", async () => {
    const where = await stand();
    const answer = await fetch(where.base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 64 MB is the client's own `ARCHIVE_CAP`, so it is the ceiling here too.
      body: `{"genesis":{},"moveLog":[],"pad":"${"a".repeat(65_000_000)}"}`,
    }).catch(() => undefined);
    expect(answer === undefined || answer.status === 413).toBe(true);
  });
});

describe("two archives of one game", () => {
  it("makes a second upload of a held game a no-op", async () => {
    const where = await stand();
    const one = await played();
    const first = await upload(where, one);
    const before = await where.archives.head(String(first.body.gameId));

    const second = await upload(where, one);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("held");
    // Not verified twice. `rankArchives` verifies before it dedupes, so N
    // copies of one game cost N full replays there; here the id is the content
    // address and the second copy costs a lookup.
    expect(await where.archives.head(String(first.body.gameId))).toEqual(before);
  });

  it("lets a longer archive of an applied game through the dedupe gate", async () => {
    const where = await stand();
    const one = await game();
    const short = await archiveOf(one, 20);
    const long = await archiveOf(one, 60);
    // Two observers on one game: the same genesis, two files, different lengths.
    expect(long.genesis.gameId).toBe(short.genesis.gameId);

    await upload(where, short);
    const answer = await upload(where, long);

    // Neither is wrong, and the longer one supersedes. A gate that stopped here
    // would bake whichever copy happened to arrive first into the total forever.
    expect(answer.status).toBe(202);
    expect(await where.archives.head(one.genesis.gameId!)).toMatchObject({ steps: 60 });
  });

  it("does not let a shorter one overwrite what is already applied", async () => {
    const where = await stand();
    const one = await game();
    await upload(where, await archiveOf(one, 60));
    const answer = await upload(where, await archiveOf(one, 20));

    expect(answer.status).toBe(200);
    expect(await where.archives.head(one.genesis.gameId!)).toMatchObject({ steps: 60 });
  });
});

describe("what the store serves", () => {
  it("hands back bytes that are the bytes it was given", async () => {
    const where = await stand();
    const game = await played();
    const posted = JSON.stringify(game);
    await fetch(where.base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: posted,
    });
    await where.ingest.idle();

    const answer = await fetch(`${where.base}/${encodeURIComponent(game.genesis.gameId!)}`);
    // Not re-serialised, not key-sorted, not stripped of anything this build
    // does not recognise. The hash in the file is over the replay, so
    // re-serialising would not break verification — which is exactly why the
    // discipline has to be stated rather than left to the implementation.
    expect(await answer.text()).toBe(posted);
  });

  it("can be read by the web client's own fetchArchive", async () => {
    const where = await stand();
    const game = await played();
    await upload(where, game);

    const read = await fetchArchive(`${where.base}/${encodeURIComponent(game.genesis.gameId!)}`);
    expect(read.genesis.gameId).toBe(game.genesis.gameId);
    expect(read.hash).toBe(game.hash);
  });

  it("tags on the archive's own hash, so the tag is correct forever", async () => {
    const where = await stand();
    const game = await played();
    await upload(where, game);
    const url = `${where.base}/${encodeURIComponent(game.genesis.gameId!)}`;

    const one = await fetch(url);
    const two = await fetch(url);
    const tag = one.headers.get("etag");
    expect(tag).toBeTruthy();
    // `apps/host` tags on the driver's current step, which moves twelve times a
    // second, so for a running game the tag never repeats and the cache in
    // front of it never hits. A stored archive is immutable once verified.
    expect(two.headers.get("etag")).toBe(tag);
    expect((await fetch(url, { headers: { "if-none-match": tag! } })).status).toBe(304);
  });

  it("lists what it holds, and what it refused, with the reasons", async () => {
    const where = await stand();
    const good = await played({ seed: 1 });
    const bad = await played({ seed: 2 });
    await upload(where, good);
    await upload(where, { ...bad, hash: "0000dead" });

    const held = await corpus(where.base, "?status=held");
    expect(held.archives.map((one) => one.gameId)).toEqual([good.genesis.gameId]);

    const refused = await corpus(where.base, "?status=refused");
    expect(refused.archives[0]!.gameId).toBe(bad.genesis.gameId);
    // A store that hid what it could not check would be making the same mistake
    // a leaderboard makes when it drops a row silently.
    expect(String(refused.archives[0]!.problems)).toMatch(/hash mismatch/);
  });

  it("pages the corpus with a cursor rather than an offset", async () => {
    const where = await stand();
    for (const seed of [1, 2, 3]) await upload(where, await played({ seed }));

    const first = await corpus(where.base, "?limit=2");
    expect(first.archives).toHaveLength(2);
    expect(first.next).toBeTruthy();

    const rest = await corpus(where.base, `?limit=2&cursor=${encodeURIComponent(first.next!)}`);
    const seen = [...first.archives, ...rest.archives].map((one) => one.gameId);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("retention: the file goes, the row does not", () => {
  it("evicts the oldest verdicts and keeps every row", async () => {
    let clock = 1_700_000_000_000;
    const where = await stand({ keep: 2, now: () => (clock += 1_000) });
    const games = [];
    for (const seed of [1, 2, 3]) {
      const game = await played({ seed });
      games.push(game);
      await upload(where, game);
    }

    // The first one in is the first one out. By `checkedAt` rather than by the
    // game's own `startedAt`: a game uploaded late is new to this service
    // whatever its age.
    expect(await where.blobs.get(games[0]!.genesis.gameId!)).toBeNull();
    expect(await where.blobs.get(games[2]!.genesis.gameId!)).not.toBeNull();

    const row = await where.archives.head(games[0]!.genesis.gameId!);
    // The whole basis of an all-time table: a few hundred bytes survive the
    // megabytes, and a monoid does not need its inputs back.
    expect(row).toBeTruthy();
    expect(row?.verdict?.ok).toBe(true);
    expect(row?.verdict?.summary.length).toBeGreaterThan(0);
    expect(row?.winner).toBe(row?.verdict?.winner);
  });

  it("answers 410 for a game it no longer holds and 404 for one it never saw", async () => {
    let clock = 1_700_000_000_000;
    const where = await stand({ keep: 1, now: () => (clock += 1_000) });
    const one = await played({ seed: 1 });
    await upload(where, one);
    await upload(where, await played({ seed: 2 }));

    const gone = await fetch(`${where.base}/${encodeURIComponent(one.genesis.gameId!)}`);
    expect(gone.status).toBe(410);
    expect((await fetch(`${where.base}/never-heard-of-it`)).status).toBe(404);
  });

  it("still lists an evicted game, marked as not held", async () => {
    let clock = 1_700_000_000_000;
    const where = await stand({ keep: 1, now: () => (clock += 1_000) });
    const one = await played({ seed: 1 });
    await upload(where, one);
    await upload(where, await played({ seed: 2 }));

    const listed = await corpus(where.base);
    const row = listed.archives.find((each) => each.gameId === one.genesis.gameId);
    expect(row).toMatchObject({ held: false, status: "held" });
  });

  it("recognises a re-upload of an evicted game rather than resurrecting it", async () => {
    let clock = 1_700_000_000_000;
    const where = await stand({ keep: 1, now: () => (clock += 1_000) });
    const one = await played({ seed: 1 });
    await upload(where, one);
    await upload(where, await played({ seed: 2 }));

    const again = await upload(where, one);
    // Refused politely rather than verified again and double-counted. Restoring
    // the blob would let anybody pin a game in the store forever by re-posting
    // it, and the retention would stop meaning anything.
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("held");
    expect(await where.blobs.get(one.genesis.gameId!)).toBeNull();
  });
});

describe("the store is off unless an operator turns it on", () => {
  it("404s the archive routes when no store is configured", async () => {
    const board = new Board({ store: new MemoryStore() });
    const server = serve({ board, bind: "127.0.0.1", port: 0, say: () => {} });
    running.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    // A board on its own is a whole deployment, and an operator who wants one
    // should not be made to find a disk for archives.
    expect((await fetch(`http://127.0.0.1:${port}/archives`)).status).toBe(404);
  });
});
