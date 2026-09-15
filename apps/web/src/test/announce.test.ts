// Listing a game from a tab, and the two things that keeps honest.
//
// The first is the guard. A row on an address book is a promise that a door is
// open, and only one of the three ways this client reaches a game gives the tab
// a door of its own: a WebRTC room whose peer id *is* the room code. A tab that
// joined a host peer's room bus is a guest in it — the door is the host's, it
// is already on the board, and a second row for it would sit on a TTL that this
// tab happens to keep alive and takes down when it closes. So `doorOf` returns
// nothing for anything but the first case, and `Announcer` posts nothing
// without one.
//
// The second is the row itself. A board is allowed to lie and its readers know
// it, which means the only field worth carrying is the one a stranger cannot
// manufacture: a majority of this game's own seats signing (step, hash). That is
// read fresh at every beat rather than captured once, because a row whose proof
// is stuck at step 0 is a row that never becomes believable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Identity, sealGenesis } from "@tessera/protocol";
import { Directory } from "@tessera/net";
import type { ConnectionRef, Lobby, ResumePoint, SignedListing, SignedWithdrawal } from "@tessera/net";
import { Announcer, BEAT_MS, TTL_MS, doorOf, rowFor } from "../net/announce";

const BOARD = "https://board.example/games";
const NOW = 1_700_000_000_000;

async function sealed(): Promise<Genesis> {
  const one = await Identity.generate();
  const two = await Identity.generate();
  return sealGenesis(
    makeGenesis({
      seed: 3,
      startedAt: NOW,
      map: { width: 32, height: 32 },
      empires: [one, two].map((who) => ({
        control: CONTROL.HUMAN,
        members: [{ kind: MEMBER.HUMAN, key: who.key }],
      })),
    }),
  );
}

/** Only the two fields the guard reads. `Lobby` opens a connection to exist,
 *  and nothing here wants one. */
const asLobby = (hosting: boolean, ref: ConnectionRef): Lobby =>
  ({ hosting, ref }) as unknown as Lobby;

const point = (step: number): ResumePoint => ({
  step,
  hash: 0x1234 + step,
  data: "",
  amendments: [],
  drops: [],
  witnesses: [],
});

/** A board that records what was posted to it, and never fails. */
function board(): { directory: Directory; writes: Array<SignedListing | SignedWithdrawal>; urls: string[] } {
  const writes: Array<SignedListing | SignedWithdrawal> = [];
  const urls: string[] = [];
  const directory = new Directory(BOARD, {
    fetch: async (input, init) => {
      urls.push(String(input));
      writes.push(JSON.parse(String(init?.body)) as SignedListing);
      return new Response("{}", { status: 200 });
    },
  });
  return { directory, writes, urls };
}

/** Everything posted is posted from a `void`ed promise — announcing must never
 *  be something a player waits on — and signing a write is real WebCrypto, which
 *  resolves on a turn of the actual event loop rather than on the microtask
 *  queue. So a test that wants to see a write has to yield a real one, which is
 *  why the fake clock below fakes the interval and nothing else. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe("which door a tab may announce", () => {
  it("announces its own WebRTC room, whose peer id is the room", () => {
    const ref: ConnectionRef = { kind: "rtc", code: "tsr-abc234" };
    expect(doorOf(asLobby(true, ref))).toEqual(ref);
  });

  it("announces nothing about a room it is a guest in", () => {
    // The door belongs to whoever is serving the bus, and 0006 has it announce
    // its own room. A row from here would be a second lease on somebody else's
    // door, expiring when this tab closes.
    expect(doorOf(asLobby(false, { kind: "rtc", code: "tsr-abc234" }))).toBeUndefined();
  });

  it("announces nothing about a socket room, even one it is serving", () => {
    // A browser cannot serve a room bus, so `hosting` on a socket ref means a
    // host peer is the door — and it is already on the board.
    const ref: ConnectionRef = { kind: "socket", url: "wss://host.example", room: "blue-fox" };
    expect(doorOf(asLobby(true, ref))).toBeUndefined();
  });
});

describe("the row a tab posts", () => {
  it("carries the door and the sealed record, and claims no occupancy", async () => {
    const genesis = await sealed();
    const row = rowFor(genesis, { kind: "rtc", code: "tsr-abc234" }, undefined, NOW);
    expect(row.gameId).toBe(genesis.gameId);
    expect(row.refs).toEqual(["tsr-abc234"]);
    expect(row.expiresAt).toBe(NOW + TTL_MS);
    // A tab knows how many peers are connected, not how many seats are held,
    // and announcing the first as the second is exactly the claim a reader is
    // right not to trust.
    expect(row.seatsUsed).toBeUndefined();
  });

  it("carries witnesses without the snapshot they came with", async () => {
    const genesis = await sealed();
    const row = rowFor(genesis, { kind: "rtc", code: "tsr-abc234" }, point(400), NOW);
    expect(row.step).toBe(400);
    expect(row.witnesses).toEqual([]);
    // The claim is a few hundred bytes; the bytes are a megabyte and answer a
    // different question. `resolve` fetches those from `/resume` when it needs
    // them.
    expect(row).not.toHaveProperty("data");
  });

  it("has no proof at all before the game has one", async () => {
    const genesis = await sealed();
    const row = rowFor(genesis, { kind: "rtc", code: "tsr-abc234" }, undefined, NOW);
    expect(row.step).toBeUndefined();
    expect(row.witnesses).toBeUndefined();
  });
});

describe("keeping the row alive, and taking it down", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("posts nothing when the tab holds no door", async () => {
    const genesis = await sealed();
    const { directory, writes } = board();
    const announcer = new Announcer(directory, await Identity.generate());
    announcer.start(genesis, undefined, () => undefined);
    await settle();
    expect(writes).toHaveLength(0);
    expect(announcer.listed).toBe(false);
  });

  it("posts the door once, immediately, signed by this tab's key", async () => {
    const genesis = await sealed();
    const identity = await Identity.generate();
    const { directory, writes } = board();
    new Announcer(directory, identity).start(genesis, { kind: "rtc", code: "tsr-abc234" }, () => undefined);
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.by).toBe(identity.key);
  });

  it("re-reads the proof each beat, so a row's witnesses keep up with the game", async () => {
    const genesis = await sealed();
    const { directory, writes } = board();
    let step = 0;
    const announcer = new Announcer(directory, await Identity.generate());
    announcer.start(genesis, { kind: "rtc", code: "tsr-abc234" }, () => (step ? point(step) : undefined));
    await settle();

    step = 900;
    await vi.advanceTimersByTimeAsync(BEAT_MS);
    await settle();

    expect(writes).toHaveLength(2);
    expect((writes[0] as SignedListing).listing.step).toBeUndefined();
    expect((writes[1] as SignedListing).listing.step).toBe(900);
    announcer.stop();
  });

  it("stops beating and withdraws the door it put up", async () => {
    const genesis = await sealed();
    const { directory, writes, urls } = board();
    const announcer = new Announcer(directory, await Identity.generate());
    announcer.start(genesis, { kind: "rtc", code: "tsr-abc234" }, () => undefined);
    await settle();

    announcer.stop();
    await settle();
    expect(urls.at(-1)).toBe(`${BOARD}/withdraw`);
    expect((writes.at(-1) as SignedWithdrawal).refs).toEqual(["tsr-abc234"]);

    // And nothing after it: a beat that fired after leaving would put the row
    // straight back up.
    await vi.advanceTimersByTimeAsync(BEAT_MS * 3);
    await settle();
    expect(writes).toHaveLength(2);
    expect(announcer.listed).toBe(false);
  });

  it("withdraws nothing when it announced nothing", async () => {
    const { directory, writes } = board();
    new Announcer(directory, await Identity.generate()).stop();
    await settle();
    expect(writes).toHaveLength(0);
  });

  it("keeps the game when the board is unreachable", async () => {
    // A board being down is never a reason to stop holding a game open for the
    // people already in it. It is reported and that is all.
    const genesis = await sealed();
    const problems: string[] = [];
    const directory = new Directory(BOARD, { fetch: async () => new Response("no", { status: 405 }) });
    const announcer = new Announcer(directory, await Identity.generate(), {
      onProblem: (message) => problems.push(message),
    });
    announcer.start(genesis, { kind: "rtc", code: "tsr-abc234" }, () => undefined);
    await settle();
    expect(problems.join(" ")).toMatch(/read-only/);
    expect(announcer.listed).toBe(true);
    announcer.stop();
  });
});
