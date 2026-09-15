// A board that is allowed to lie, and a client that assumes it does.
//
// Every row here is fiction of one kind or another, because that is the only
// interesting input. A board is not a peer: it signs nothing, it is party to
// nothing, and the rows it serves were written by whoever could reach it. So the
// suite is a catalogue of what a hostile one can try — a genesis that does not
// hash to its id, a row that has expired, a ref this build cannot read, a body
// that never ends — and of the one thing it cannot fake, which is a majority of
// somebody else's seats signing for a step.
//
// The fabrication test is the one that matters most, and it is the one that
// looks like a failure: a well-formed row for a game nobody has ever played is
// *returned*. It has to be. A game composed thirty seconds ago has no witnesses
// either, and a client that hid the unproven rows would hide every new game on
// the board it most needs to be on. What the client owes the player is the
// distinction, not the filter.

import { describe, expect, it } from "vitest";
import { CONTROL, MEMBER, PROTOCOL_VERSION, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Identity, sealGenesis, signCheckpoint } from "@tessera/protocol";
import type { SignedCheckpoint } from "@tessera/protocol";
import { Directory, verifyWrite } from "../directory.js";
import type { Listing, SignedListing, SignedWithdrawal } from "../directory.js";

const BOARD = "https://board.example/games";
const STEP = 240;
const HASH = 0x51d0a2c3;

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
  ...over,
});

async function witness(
  g: Game,
  seat: Game["seats"][number],
  over: { gameId?: string; step?: number; hash?: number } = {},
): Promise<SignedCheckpoint> {
  return signCheckpoint(seat.identity, over.gameId ?? g.genesis.gameId!, {
    step: over.step ?? STEP,
    hash: over.hash ?? HASH,
    empire: seat.empire,
    member: seat.member,
  });
}

/** A board that answers with whatever it was handed. `list` is the collection,
 *  `get` is one id; nothing here validates anything, which is the point. */
function board(rows: unknown[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    const id = url.startsWith(`${BOARD}/`) ? url.slice(BOARD.length + 1) : undefined;
    const body = id
      ? rows.filter((one) => (one as Listing)?.gameId === decodeURIComponent(id))
      : rows;
    return new Response(JSON.stringify({ games: body }), { status: 200 });
  };
}

const open = (rows: unknown[], options = {}): Directory =>
  new Directory(BOARD, { fetch: board(rows), now: () => 1_700_000_100_000, ...options });

describe("reading a board that is allowed to lie", () => {
  it("drops a row whose genesis does not hash to the id it claims", async () => {
    const real = await game([1, 1]);
    const other = await game([1, 1]);
    // The whole attack in one line: a genuine record, filed under a real id
    // that is not its own. Both halves check out separately.
    const listings = await open([row(real, { gameId: other.genesis.gameId! })]).list();
    expect(listings).toEqual([]);
  });

  it("drops a row the record's own rules refuse", async () => {
    const one = await Identity.generate();
    // One key in two empires: `inspectGenesis` says duplicate-key, so no peer
    // would agree to play it and there is nothing behind the row to reach.
    const genesis = await sealGenesis(
      makeGenesis({
        seed: 3,
        startedAt: 1_700_000_000_000,
        map: { width: 32, height: 32 },
        empires: [
          { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: one.key }] },
          { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: one.key }] },
        ],
      }),
    );
    const listings = await open([
      { gameId: genesis.gameId, genesis, refs: ["tsr-abc234"] },
    ]).list();
    expect(listings).toEqual([]);
  });

  it("returns a game this build cannot play, marked unplayable", async () => {
    const future = await game([1, 1], { protocol: PROTOCOL_VERSION + 9 });
    const [listing] = await open([row(future)]).list();
    // Shown, not hidden. A lobby that silently omits the game a player is in is
    // worse than one that says "update to join this".
    expect(listing?.gameId).toBe(future.genesis.gameId);
    expect(listing?.playable).toBe(false);
  });

  it("keeps the refs it can read and reports the one it cannot", async () => {
    const g = await game([1, 1]);
    const [listing] = await open([
      row(g, { refs: ["tsr-abc234", "quic://tomorrow/room", "wss://relay.example/t/abc234"] }),
    ]).list();

    expect(listing?.refs.map((ref) => ref.kind)).toEqual(["rtc", "socket"]);
    expect(listing?.unreadable).toEqual(["quic://tomorrow/room"]);
  });

  it("does not return a row that has expired against our own clock", async () => {
    const g = await game([1, 1]);
    const rows = [row(g, { expiresAt: 1_700_000_050_000 })];
    expect(await open(rows).list()).toEqual([]);
    // The same row, read by a client whose clock has not got there yet.
    expect(await open(rows, { now: () => 1_700_000_000_000 }).list()).toHaveLength(1);
  });

  it("merges two announcers' doors into one game", async () => {
    const g = await game([1, 1]);
    const listings = await open([
      row(g, { refs: ["tsr-abc234"], resume: "https://one.example/room/a/resume" }),
      row(g, { refs: ["wss://relay.example/t/abc234"], resume: "https://two.example/room/b/resume" }),
    ]).list();

    // One game with two doors, never two games. Two hosts announcing the same
    // gameId is the normal case, not a conflict.
    expect(listings).toHaveLength(1);
    expect(listings[0]!.refs).toHaveLength(2);
    expect(listings[0]!.resume).toHaveLength(2);
  });

  it("derives the seat counts from the record and never from the row", async () => {
    const g = await game([2, 2]);
    const [listing] = await open([row(g, { seatsUsed: 99 })]).list();
    expect(listing?.seats).toEqual({ total: 4, keyed: 4 });
    // Live occupancy is derivable from nothing, so it stays a claim — carried
    // for rendering, never filtered on.
    expect(listing?.seatsUsed).toBe(99);
  });

  it("returns a well-formed fabrication, and gives it no proof", async () => {
    // Nobody has ever played this. Every check the client can make passes,
    // because composing a real record costs a spammer one key and no game.
    const fiction = await game([1, 1]);
    const [listing] = await open([row(fiction)]).list();
    expect(listing?.gameId).toBe(fiction.genesis.gameId);
    expect(listing?.proof).toBeUndefined();
  });
});

describe("the one field a stranger cannot manufacture", () => {
  it("marks a row proven when a majority of the seats signed for the step", async () => {
    const g = await game([2, 2]);
    const witnesses = [
      await witness(g, g.seats[0]!),
      await witness(g, g.seats[1]!),
      await witness(g, g.seats[2]!),
    ];
    const [listing] = await open([row(g, { step: STEP, hash: HASH, witnesses })]).list();

    expect(listing?.proof?.ok).toBe(true);
    expect(listing?.proof).toMatchObject({ endorsed: 3, needed: 3, step: STEP });
  });

  it("does not call a row proven one seat short of a majority", async () => {
    const g = await game([2, 2]);
    const witnesses = [await witness(g, g.seats[0]!), await witness(g, g.seats[1]!)];
    const [listing] = await open([row(g, { step: STEP, hash: HASH, witnesses })]).list();

    // Returned with its tally rather than dropped: two of four seats agreeing
    // is a fact about the game, and a player deciding whether to spend an
    // evening on it should see the number.
    expect(listing?.proof?.ok).toBe(false);
    expect(listing?.proof?.endorsed).toBe(2);
  });

  it("does not count a witness signed against another game", async () => {
    const g = await game([1, 1]);
    const elsewhere = await game([1, 1]);
    const witnesses = [
      await witness(g, g.seats[0]!),
      // Real signature, real seat, wrong game: the gameId is inside the signed
      // bytes, so a witness lifted from another board verifies nowhere else.
      await witness(g, g.seats[1]!, { gameId: elsewhere.genesis.gameId! }),
    ];
    const [listing] = await open([row(g, { step: STEP, hash: HASH, witnesses })]).list();

    expect(listing?.proof?.endorsed).toBe(1);
    expect(listing?.proof?.ok).toBe(false);
  });

  it("ignores witnesses for a step the row is not claiming", async () => {
    const g = await game([1, 1]);
    const witnesses = [
      await witness(g, g.seats[0]!, { step: 12 }),
      await witness(g, g.seats[1]!, { step: 12 }),
    ];
    const [listing] = await open([row(g, { step: STEP, hash: HASH, witnesses })]).list();
    expect(listing?.proof?.endorsed).toBe(0);
  });

  it("returns nothing when every row has been tampered with", async () => {
    const one = await game([1, 1]);
    const two = await game([2]);
    const rows = [
      row(one, { gameId: two.genesis.gameId! }),
      row(two, { gameId: one.genesis.gameId! }),
      { gameId: one.genesis.gameId, genesis: { protocol: 4, empires: [] }, refs: [] },
      { gameId: "", genesis: one.genesis, refs: [] },
      "not a row",
      null,
    ];
    expect(await open(rows).list()).toEqual([]);
  });
});

describe("fetching from a server you do not trust", () => {
  it("gives up on a board that answers and then says nothing", async () => {
    const hangs: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const directory = new Directory(BOARD, { fetch: hangs, timeoutMs: 20 });
    // Not "eventually": `fetch` has no default timeout, so without this the
    // lobby screen waits for as long as the tab is open.
    await expect(directory.list()).rejects.toThrow(/did not answer within/);
  });

  it("cuts off a board that streams forever", async () => {
    let sent = 0;
    const flood: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent++;
            controller.enqueue(new Uint8Array(64_000));
          },
        }),
        { status: 200 },
      );
    const directory = new Directory(BOARD, { fetch: flood });
    await expect(directory.list()).rejects.toThrow(/more than 1000000 bytes/);
    // Cut off rather than buffered to the end — `response.json()` would have
    // waited politely for a body that never finishes.
    expect(sent).toBeLessThan(40);
  });

  it("turns a fetch that simply fails into something a player can read", async () => {
    const blocked: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const directory = new Directory(BOARD, { fetch: blocked });
    await expect(directory.list()).rejects.toThrow(/may not allow this page to read it/);
  });

  it("asks for nothing that says who is asking", async () => {
    const seen: RequestInit[] = [];
    const watching: typeof fetch = async (_input, init) => {
      seen.push(init ?? {});
      return new Response("[]", { status: 200 });
    };
    await new Directory(BOARD, { fetch: watching }).list();
    expect(seen[0]!.credentials).toBe("omit");
    expect(seen[0]!.headers).toBeUndefined();
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a board answering /games/<id> with a different game", async () => {
    const wanted = await game([1, 1]);
    const other = await game([1, 1]);
    const directory = new Directory(BOARD, {
      fetch: async () => new Response(JSON.stringify({ games: [row(other)] }), { status: 200 }),
    });
    expect(await directory.get(wanted.genesis.gameId!)).toBeUndefined();
  });
});

describe("the board's one rule", () => {
  it("signs an announcement the board can check, over the door and not the game", async () => {
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const posted: SignedListing[] = [];
    const directory = new Directory(BOARD, {
      fetch: async (_input, init) => {
        posted.push(JSON.parse(String(init?.body)) as SignedListing);
        return new Response("{}", { status: 200 });
      },
    });

    await directory.announce(host, row(g, { expiresAt: 1_700_000_200_000 }));
    const write = posted[0]!;
    expect(write.by).toBe(host.key);
    expect(await verifyWrite(write)).toBe(true);

    // The signature says who posted the row. It does not say the row is true,
    // and moving the door is exactly what it is there to catch.
    write.listing.refs = ["tsr-elsewhere"];
    expect(await verifyWrite(write)).toBe(false);
  });

  it("signs a withdrawal so a public board is not something anyone can clear", async () => {
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const posted: SignedWithdrawal[] = [];
    const directory = new Directory(BOARD, {
      fetch: async (_input, init) => {
        posted.push(JSON.parse(String(init?.body)) as SignedWithdrawal);
        return new Response("{}", { status: 200 });
      },
    });

    await directory.withdraw(host, g.genesis.gameId!, ["tsr-abc234"]);
    expect(await verifyWrite(posted[0]!)).toBe(true);
    posted[0]!.gameId = "somebody-elses-game";
    expect(await verifyWrite(posted[0]!)).toBe(false);
  });

  it("says so when the board is a static file that cannot be written to", async () => {
    const g = await game([1, 1]);
    const host = await Identity.generate();
    const directory = new Directory(BOARD, {
      fetch: async () => new Response("no", { status: 405 }),
    });
    await expect(directory.announce(host, row(g))).rejects.toThrow(/read-only/);
  });
});
