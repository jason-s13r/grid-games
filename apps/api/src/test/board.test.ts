// The real client, against the real server, over a real socket.
//
// Every assertion below reads rows back through `Directory` rather than looking
// at the JSON this service emits, and that is deliberate rather than tidy.
// `asRows` accepts four shapes and answers zero rows for anything else *without
// an error*, so a service bug returning `{"data": [...]}` looks exactly like an
// empty board. Asserting on our own output would pass; asserting on what the
// client can read from it would not.
//
// The fixtures are lifted from `packages/net/src/test/directory.test.ts` rather
// than rewritten. That suite already builds a genuine genesis, a fabricated one,
// rows with three-of-four witnesses and rows with two, and a row whose witnesses
// are for another game. Posting those through this service and reading them back
// proves the thing that actually matters — that the board is transparent — in a
// way that checking our own serialisation cannot.
//
// This is also the first HTTP-level test in the repository. `apps/host`,
// `apps/bot` and `apps/observer` all run `vitest run --passWithNoTests` and have
// no `src/test` at all; `apps/host/src/serve.ts` has never been executed by a
// test. A service whose entire contract is HTTP should not inherit that.

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CONTROL, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Identity, sealGenesis, signCheckpoint } from "@tessera/protocol";
import type { SignedCheckpoint } from "@tessera/protocol";
import { CAPS, Directory } from "@tessera/net";
import type { Listing } from "@tessera/net";
import { Board, LIMITS } from "../board.js";
import type { Limits } from "../board.js";
import { MemoryStore } from "../db.js";
import { serve } from "../serve.js";

const STEP = 240;
const HASH = 0x51d0a2c3;
/** Every clock in this file, so a TTL is arithmetic rather than a race. */
const NOW = 1_700_000_100_000;
const SOON = NOW + 120_000;

interface Game {
  genesis: Genesis;
  seats: Array<{ identity: Identity; empire: number; member: number }>;
}

/** A sealed game with `shape` human seats per empire. Nothing is simulated: a
 *  listing carries no bytes, so there is no state for this suite to need. */
async function game(shape: number[], over: Partial<Genesis> = {}): Promise<Game> {
  const seats: Game["seats"] = [];
  const empires = [];
  for (const [index, count] of shape.entries()) {
    const members = [];
    for (let member = 0; member < count; member++) {
      const identity = await Identity.generate();
      seats.push({ identity, empire: index + 1, member });
      members.push({ kind: MEMBER.HUMAN, key: identity.key });
    }
    empires.push({ control: CONTROL.HUMAN, members });
  }
  const genesis = makeGenesis({
    seed: 11,
    startedAt: 1_700_000_000_000,
    map: { width: 32, height: 32 },
    empires,
  });
  return { genesis: await sealGenesis({ ...genesis, ...over }), seats };
}

const row = (g: Game, over: Partial<Listing> = {}): Listing => ({
  gameId: g.genesis.gameId!,
  genesis: g.genesis,
  refs: ["tsr-abc234"],
  expiresAt: SOON,
  ...over,
});

async function witness(
  g: Game,
  seat: Game["seats"][number],
  over: { gameId?: string; step?: number } = {},
): Promise<SignedCheckpoint> {
  return signCheckpoint(seat.identity, over.gameId ?? g.genesis.gameId!, {
    step: over.step ?? STEP,
    hash: HASH,
    empire: seat.empire,
    member: seat.member,
  });
}

const running: Server[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

/** One board on a real port, and a `Directory` pointed at it. `listen(0)` so
 *  suites never collide, and both clocks are ours so a TTL is deterministic. */
async function stand(
  options: { now?: () => number; limits?: Limits } = {},
): Promise<{ base: string; directory: Directory; board: Board }> {
  const now = options.now ?? (() => NOW);
  const board = new Board({ store: new MemoryStore(), now, ...(options.limits ? { limits: options.limits } : {}) });
  const server = serve({ board, bind: "127.0.0.1", port: 0, say: () => {} });
  running.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/games`;
  return { base, directory: new Directory(base, { now }), board };
}

describe("a board the shipped client can use", () => {
  it("lists a row it was given, checked by the client that reads it", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    await directory.announce(host, row(g));
    const listings = await directory.list();

    expect(listings).toHaveLength(1);
    expect(listings[0]!.gameId).toBe(g.genesis.gameId);
    expect(listings[0]!.refs.map((ref) => ref.kind)).toEqual(["rtc"]);
    expect(listings[0]!.seats).toEqual({ total: 2, keyed: 2 });
  });

  it("finds one game by id, and cannot substitute another", async () => {
    const { directory } = await stand();
    const wanted = await game([1, 1]);
    const other = await game([2]);
    const host = await Identity.generate();

    await directory.announce(host, row(wanted));
    await directory.announce(host, row(other, { refs: ["tsr-other1"] }));

    expect((await directory.get(wanted.genesis.gameId!))?.gameId).toBe(wanted.genesis.gameId);
    // Never seen. The client refuses a board that answers the wrong game, and
    // this one has no way to answer at all.
    expect(await directory.get("not-a-game-id")).toBeUndefined();
  });

  it("treats a heartbeat as the announcement it is, and keeps one row", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    await directory.announce(host, row(g));
    await directory.present(host, row(g));
    await directory.present(host, row(g));

    // `present` is `announce` — the service cannot tell a first announcement
    // from a refresh and must not try. Three posts, one door.
    const listings = await directory.list();
    expect(listings).toHaveLength(1);
    expect(listings[0]!.refs).toHaveLength(1);
  });

  it("withdraws a door, and a game with no doors left is off the board", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    await directory.announce(host, row(g));
    await directory.withdraw(host, g.genesis.gameId!, ["tsr-abc234"]);
    expect(await directory.list()).toEqual([]);
  });

  it("never returns a row whose lease has run out", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    await directory.announce(host, row(g, { expiresAt: NOW - 1 }));
    // A crash withdraws nothing; the TTL is what removes the door. Checked
    // here on the way out of the service, before the client's own clock gets
    // a chance to agree — the two clocks are not the same clock.
    expect(await directory.list()).toEqual([]);
  });

  it("fans a multi-ref post out into rows, and merge() puts it back together", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const refs = ["tsr-abc234", "wss://relay.example/t/abc234"];

    await directory.announce(host, row(g, { refs }));
    const listings = await directory.list();

    // One row per door, one TTL per door — and one game to the reader, because
    // `merge()` unions the refs back. The round trip is lossless.
    expect(listings).toHaveLength(1);
    expect(listings[0]!.refs.map((ref) => ref.kind)).toEqual(["rtc", "socket"]);
  });

  it("keeps two hosts' doors into one game apart, so neither overwrites the other", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const one = await Identity.generate();
    const two = await Identity.generate();

    await directory.announce(one, row(g, { refs: ["tsr-abc234"] }));
    await directory.announce(two, row(g, { refs: ["wss://relay.example/t/abc234"] }));

    // 0006 is explicit that redundancy for the door is the address book's job,
    // and a row keyed on the game alone would have thrown one of these away.
    const listings = await directory.list();
    expect(listings).toHaveLength(1);
    expect(listings[0]!.refs).toHaveLength(2);
  });

  it("carries a field this build has never heard of through untouched", async () => {
    const { directory, base } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    // The argument for storing the document whole. A row posted by a newer
    // client has to survive to reach a reader who understands it, and a service
    // that normalised its rows into columns would drop this silently.
    await directory.announce(host, row(g, { tomorrow: { some: ["shape"] } } as Partial<Listing>));

    const body = (await (await fetch(`${base}?limit=10`)).json()) as { games: Listing[] };
    expect(body.games[0]).toMatchObject({ tomorrow: { some: ["shape"] } });
  });

  it("forwards an occupancy claim verbatim and filters on nothing", async () => {
    const { directory } = await stand();
    const g = await game([2, 2]);
    const host = await Identity.generate();

    await directory.announce(host, row(g, { seatsUsed: 99 }));
    const [listing] = await directory.list();

    // Nonsense on a four-seat game, and still 99 on the way out. It is a claim
    // permanently — it moves by amendment and by drop and the board sees
    // neither — and a `joinable` filter that trusted it would be a hostile
    // board deciding which games a player sees.
    expect(listing?.seatsUsed).toBe(99);
    expect(listing?.seats).toEqual({ total: 4, keyed: 4 });
  });

  it("honours limit, and keeps a hundred rows under the cap the client reads through", async () => {
    // The operator limits are what this suite is not testing here, so they are
    // lifted out of the way; `CAPS.list` is the client's and stays.
    const { directory, base } = await stand({
      limits: { ...LIMITS, rowsPerOwner: 1_000, rowsPerGame: 1_000, writesPerMinute: 1_000 },
    });
    const host = await Identity.generate();
    const g = await game([2, 2]);
    for (let index = 0; index < 100; index++) {
      const port = 20_000 + index;
      await directory.announce(host, row(g, { refs: [`wss://relay.example:${port}/t/abc234`] }));
    }

    expect((await directory.list({ limit: 5 })).length).toBeLessThanOrEqual(5);
    const five = (await (await fetch(`${base}?limit=5`)).json()) as { games: Listing[] };
    expect(five.games).toHaveLength(5);

    const text = await (await fetch(`${base}?limit=100`)).text();
    // `DEFAULT_LIMIT` is 100 and a row with a genesis and witnesses costs 2–4 kB,
    // which is what `CAPS.list` was sized for. A board that exceeds it is cut
    // off mid-stream and the failure reads as an unreachable board rather than
    // a large one, so honouring `limit` is not optional in practice.
    expect(text.length).toBeLessThan(CAPS.list);
  });
});

describe("the witnesses, which are the one thing a board cannot fake", () => {
  it("returns a row proven, with the tally the client computed itself", async () => {
    const { directory } = await stand();
    const g = await game([2, 2]);
    const host = await Identity.generate();
    const witnesses = [
      await witness(g, g.seats[0]!),
      await witness(g, g.seats[1]!),
      await witness(g, g.seats[2]!),
    ];

    await directory.announce(host, row(g, { step: STEP, hash: HASH, witnesses }));
    const [listing] = await directory.list();

    // Signed by three of this game's four seats — and posted by `host`, which
    // holds none of them and could not have produced any of it.
    expect(listing?.proof).toMatchObject({ ok: true, endorsed: 3, needed: 3, step: STEP });
  });

  it("does not let the service launder a witness from another game", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const elsewhere = await game([1, 1]);
    const host = await Identity.generate();
    const witnesses = [
      await witness(g, g.seats[0]!),
      await witness(g, g.seats[1]!, { gameId: elsewhere.genesis.gameId! }),
    ];

    await directory.announce(host, row(g, { step: STEP, hash: HASH, witnesses }));
    const [listing] = await directory.list();

    // Stored without comment, refused by the reader. The board is not where
    // this is caught and must not try to be.
    expect(listing?.proof).toMatchObject({ ok: false, endorsed: 1 });
  });

  it("returns a well-formed fabrication, and gives it no proof", async () => {
    const { directory } = await stand();
    // Nobody has ever played this. Composing a real record costs a spammer one
    // key and no game, and the board is not allowed to guess which is which —
    // a game composed thirty seconds ago has no witnesses either.
    const fiction = await game([1, 1]);
    const host = await Identity.generate();

    await directory.announce(host, row(fiction));
    const [listing] = await directory.list();
    expect(listing?.gameId).toBe(fiction.genesis.gameId);
    expect(listing?.proof).toBeUndefined();
  });
});

describe("the one rule: who posted a row, never whether it is true", () => {
  it("refuses a write whose door was moved after it was signed", async () => {
    const { base } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const posted: unknown[] = [];
    const watching = new Directory(base, {
      now: () => NOW,
      fetch: async (input, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return fetch(input, init);
      },
    });
    await watching.announce(host, row(g));

    const tampered = structuredClone(posted[0]) as { listing: Listing };
    tampered.listing.refs = ["wss://relay.attacker.example/t/abc234"];
    const answer = await post(base, tampered);

    // Refs are sorted before signing, so ref *membership* is covered — this is
    // precisely the attack the signature exists for.
    expect(answer.status).toBe(403);
  });

  it("refuses a write signed by nobody at all", async () => {
    const { base } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    const answer = await post(base, { listing: row(g), by: host.key, sig: "not-a-signature" });
    expect(answer.status).toBe(403);
  });

  it("will not let a second key take over a live door", async () => {
    const { base, directory } = await stand();
    const g = await game([1, 1]);
    const one = await Identity.generate();
    const two = await Identity.generate();

    await directory.announce(one, row(g));
    // A perfectly valid signature, over a door somebody else is holding. This
    // is access control and not adjudication: both writes are honest, and one
    // of them is not the owner.
    await expect(directory.announce(two, row(g))).rejects.toThrow(/board answered 403/);
    expect(await directory.list()).toHaveLength(1);
    expect(base).toContain("/games");
  });

  it("will not let a second key clear somebody else's row", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const one = await Identity.generate();
    const two = await Identity.generate();

    await directory.announce(one, row(g));
    // 200, and nothing happens. A withdrawal is not a query, and telling a
    // stranger which of the refs they named exist is information the board has
    // no reason to hand out.
    await directory.withdraw(two, g.genesis.gameId!, ["tsr-abc234"]);
    expect(await directory.list()).toHaveLength(1);
  });

  it("lets a key take a door over once the lease on it has run out", async () => {
    let clock = NOW;
    const { directory } = await stand({ now: () => clock });
    const g = await game([1, 1]);
    const one = await Identity.generate();
    const two = await Identity.generate();

    await directory.announce(one, row(g, { expiresAt: NOW + 1_000 }));
    clock = NOW + 2_000;
    await directory.announce(two, row(g, { expiresAt: clock + 60_000 }));
    expect(await directory.list()).toHaveLength(1);
  });
});

describe("what an operator bounds, and what they do not", () => {
  it("caps how long a lease can be, without rewriting the row that asked", async () => {
    let clock = NOW;
    const { base } = await stand({ now: () => clock });
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const asked = NOW + 48 * 60 * 60_000;

    await new Directory(base, { now: () => clock }).announce(host, row(g, { expiresAt: asked }));
    const body = (await (await fetch(`${base}?limit=10`)).json()) as { games: Listing[] };
    // The document is stored whole, so the row still says what its announcer
    // said. The clamp is the service's own lease column and nothing else.
    expect(body.games[0]!.expiresAt).toBe(asked);

    // Two days later by this service's clock — and, as far as it is concerned,
    // long gone. A row that outlived the process holding the door open would be
    // a door into nothing, advertised with a full set of witnesses.
    clock = NOW + LIMITS.ttlCeilingMs + 1;
    const after = (await (await fetch(`${base}?limit=10`)).json()) as { games: Listing[] };
    expect(after.games).toEqual([]);
  });

  it("refuses more doors into one game than redundancy could want", async () => {
    const { directory } = await stand();
    const g = await game([1, 1]);
    const host = await Identity.generate();

    for (let index = 0; index < LIMITS.rowsPerGame; index++) {
      await directory.announce(host, row(g, { refs: [`wss://relay.example/t/abc2${index}0`] }));
    }
    await expect(
      directory.announce(host, row(g, { refs: ["wss://relay.example/t/abc299"] })),
    ).rejects.toThrow(/board answered 429/);
  });

  it("does not refuse a heartbeat from a key sitting at the row limit", async () => {
    const { directory } = await stand({
      limits: { ...LIMITS, rowsPerOwner: 2, writesPerMinute: 100 },
    });
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const refs = ["tsr-abc234", "wss://relay.example/t/abc234"];

    await directory.announce(host, row(g, { refs }));
    // The limit is on rows held, not on writes that mention them. A host at the
    // ceiling that could not refresh would watch its own game fall off the
    // board — which is the subtle failure the happy-path tests above catch.
    await directory.present(host, row(g, { refs }));
    expect(await directory.list()).toHaveLength(1);
  });

  it("throttles a key writing far faster than any announcer does", async () => {
    const { directory } = await stand({ limits: { ...LIMITS, writesPerMinute: 3 } });
    const g = await game([1, 1]);
    const host = await Identity.generate();

    for (let index = 0; index < 3; index++) await directory.present(host, row(g));
    await expect(directory.present(host, row(g))).rejects.toThrow(/board answered 429/);
  });
});

describe("the headers, without which none of this works from a page", () => {
  it("answers a preflight that allows the one header the client sends", async () => {
    const { base } = await stand();
    const answer = await fetch(base, {
      method: "OPTIONS",
      headers: {
        origin: "https://someone.github.io",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("access-control-allow-methods")).toContain("POST");
    // The failure mode worth naming: without this, reads work, writes fail, and
    // the browser console is the only place that says why. `Content-Type:
    // application/json` is the only header the client ever sends and it is not
    // a CORS-simple type. The host peer's preflight answers `GET, OPTIONS` and
    // would be wrong here if it had been copied.
    expect(answer.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("allows a page to read the board with no headers at all", async () => {
    const { base, directory } = await stand();
    const g = await game([1, 1]);
    await directory.announce(await Identity.generate(), row(g));

    // `readJson` sends `credentials: "omit"` and no headers — not an API key,
    // not a bearer token, not even `Accept` — and `directory.test.ts` pins it.
    // A board needing any of them would need a client change first.
    const answer = await fetch(`${base}?limit=100`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("cuts off a write that never ends rather than buffering it", async () => {
    const { base } = await stand();
    const answer = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"listing":{"gameId":"x","refs":["${"a".repeat(2_000_000)}"]}}`,
    }).catch(() => undefined);
    // Either the service refused it or it hung up mid-body; both are the cap
    // doing its job, and neither is this process holding two megabytes.
    expect(answer === undefined || answer.status === 413).toBe(true);
  });
});

/** A raw write, for the cases where the point is that the client would never
 *  send this. */
const post = (base: string, body: unknown): Promise<Response> =>
  fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
