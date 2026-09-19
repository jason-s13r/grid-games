// The table, and the half of it that is the refusals.
//
// Every figure in a Tessera leaderboard is derived — read out of hashed state
// after replaying a signed log — which makes "what did not get counted, and why"
// the part a reader has to be able to see. `tessera-observe rank` prints its
// refusals for exactly this reason, and a browser that swallowed them would be
// giving back the property the signatures were for.
//
// Two things are pinned here and neither is arithmetic. A refusal is named by
// the *file* it came from, because two archives of one game share a game id and
// which of them was the duplicate is the whole point of saying so. And the
// table's scope is stated on screen, because there is no index of finished games
// anywhere in Tessera and a heading that said "Leaderboard" alone would be
// claiming one exists.

import { describe, expect, it } from "vitest";
import { MEMBER } from "@tessera/sim";
import type { Leaderboard as Table, Standing } from "@tessera/net";
import { shortKey, view } from "../view/Leaderboard";
import { isArchive, urlsFrom } from "../net/archives";
import { fetchTable, hostOf } from "../net/rankings";
import type { HostedTable } from "../net/rankings";

const standing = (over: Partial<Standing> = {}): Standing => ({
  key: "MCowBQYDK2VwAyEAabcdefghijklmnop",
  kind: MEMBER.HUMAN,
  games: 3,
  wins: 2,
  moves: 400,
  popSpent: 900,
  tilesTaken: 1_240,
  bestMove: 61,
  bestCascade: 18,
  peakTiles: 800,
  ...over,
});

const table = (over: Partial<Table> = {}): Table => ({
  standings: [standing()],
  counted: ["abc123"],
  unfinished: 0,
  refused: [],
  ...over,
});

describe("before there is anything to count", () => {
  it("says what to do rather than showing an empty table", () => {
    const shown = view({ kind: "unset" });
    expect(shown.rows).toHaveLength(0);
    expect(shown.label).toContain("archive URLs");
    // Nothing to build from, so the button does not pretend otherwise.
    expect(shown.canBuild).toBe(false);
  });

  it("counts URLs and files together, because the table does not care", () => {
    expect(view({ kind: "idle", sources: 1 }).label).toBe("1 saved game to check.");
    expect(view({ kind: "idle", sources: 4 }).canBuild).toBe(true);
  });
});

describe("while it is working", () => {
  it("separates reading from replaying, because they fail differently", () => {
    // One is a network problem with a URL attached; the other is a minute of
    // CPU. Rolling them into one spinner makes a slow host and a long game
    // indistinguishable.
    expect(view({ kind: "reading", done: 1, total: 3 }).label).toContain("Reading 1 of 3");
    expect(view({ kind: "checking", games: 3 }).label).toContain("Replaying 3 games");
  });

  it("does not offer to start a second one on top of the first", () => {
    expect(view({ kind: "checking", games: 1 }).canBuild).toBe(false);
  });
});

describe("the table itself", () => {
  it("says what it is over, so the heading does not claim an index exists", () => {
    const shown = view({ kind: "table", table: table(), names: ["a.json"], unreadable: [] });
    expect(shown.scope).toContain("not every game ever played");
  });

  it("carries the figures through without touching them", () => {
    const shown = view({ kind: "table", table: table(), names: [], unreadable: [] });
    expect(shown.rows[0]).toMatchObject({ games: 3, wins: 2, tiles: 1_240, best: 61 });
  });

  it("marks a key that only ever held bot seats", () => {
    const only = table({ standings: [standing({ kind: MEMBER.BOT })] });
    expect(view({ kind: "table", table: only, names: [], unreadable: [] }).rows[0]!.kind).toBe("bot");
  });

  it("says when a counted game has not finished", () => {
    // A table of zeroes is otherwise indistinguishable from a table of losses.
    const running = table({ counted: ["a", "b"], unfinished: 1 });
    const shown = view({ kind: "table", table: running, names: [], unreadable: [] });
    expect(shown.label).toContain("2 games counted");
    expect(shown.label).toContain("no wins");
  });

  it("shortens a key without losing it", () => {
    const key = "MCowBQYDK2VwAyEAabcdefghijklmnop";
    expect(shortKey(key)).toHaveLength(17);
    expect(view({ kind: "table", table: table(), names: [], unreadable: [] }).rows[0]!.key).toBe(key);
  });
});

describe("what did not get counted", () => {
  it("names the file, not the game", () => {
    // The distinction the whole refusal list turns on: `rankArchives` refuses by
    // position precisely so a caller can say which of two archives of one game
    // was the duplicate.
    const refused = table({
      refused: [{ index: 1, game: "abc123", problems: ["already counted from another archive"] }],
    });
    const shown = view({
      kind: "table",
      table: refused,
      names: ["from-alice.json", "https://host.example/room/blue-fox/archive"],
      unreadable: [],
    });
    expect(shown.refusals[0]!.source).toBe("https://host.example/room/blue-fox/archive");
  });

  it("keeps every problem with a file, not the first one", () => {
    const refused = table({
      refused: [{ index: 0, game: "abc", problems: ["unsigned move at step 12", "hash mismatch"] }],
    });
    const shown = view({ kind: "table", table: refused, names: ["one.json"], unreadable: [] });
    expect(shown.refusals[0]!.problems).toHaveLength(2);
  });

  it("lists what could not even be read beside what would not verify", () => {
    // A host that was down and a log that was forged are different failures and
    // a player can act on only one of them — but leaving either out is the same
    // silence.
    const shown = view({
      kind: "table",
      table: table({ refused: [{ index: 0, game: "abc", problems: ["hash mismatch"] }] }),
      names: ["one.json"],
      unreadable: [{ source: "https://gone.example/archive", problems: ["could not read it"] }],
    });
    expect(shown.refusals).toHaveLength(2);
    expect(shown.refusals[0]!.source).toContain("gone.example");
  });

  it("falls back to the game id when a refusal has no file to name", () => {
    const refused = table({ refused: [{ index: 9, game: "abcdef0123456789", problems: ["no"] }] });
    const shown = view({ kind: "table", table: refused, names: [], unreadable: [] });
    expect(shown.refusals[0]!.source).toContain("abcdef012345");
  });
});

describe("what counts as a saved game before any of that", () => {
  it("takes a shape check and nothing more", () => {
    // Everything that decides whether a file is *true* is `verifyArchive`'s.
    // This only exists so "not a saved game" and "a saved game that did not
    // check out" stay different sentences.
    expect(isArchive({ genesis: {}, moveLog: [] })).toBe(true);
    expect(isArchive({ genesis: {} })).toBe(false);
    expect(isArchive("[]")).toBe(false);
    expect(isArchive(null)).toBe(false);
  });

  it("reads a list of URLs the way a person types one", () => {
    expect(urlsFrom(" https://a.example/x \n\n  https://b.example/y\n")).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });
});

describe("a table somebody else derived", () => {
  const hosted = (over: Partial<HostedTable> = {}): HostedTable => ({
    standings: [standing()],
    counted: ["abc123", "def456"],
    unfinished: 0,
    refused: [],
    games: 2,
    derivedAt: "2026-09-19T00:00:00.000Z",
    scope: "Over the archives this service holds — not every game ever played.",
    ...over,
  });

  it("names the host in the scope line, so a reader sees whose claim it is", () => {
    const shown = view({ kind: "hosted", table: hosted(), host: "api.example", window: "held" });
    // The failure mode is silent: a hosted table and a local one look identical
    // if nothing says which is which, and only one of them is this browser's
    // own derivation.
    expect(shown.scope).toContain("api.example");
    expect(shown.scope).toContain("not every game ever played");
    expect(shown.from).toBe("hosted");
  });

  it("uses the service's own sentence rather than one of its own", () => {
    const all = hosted({
      counted: null,
      scope: "Over every game applied here since 2026-01-01. Archives for older games are no longer held.",
    });
    const shown = view({ kind: "hosted", table: all, host: "api.example", window: "all" });
    // The service knows what its table is over and this client does not. A
    // client supplying its own qualifier would be guessing for the reader.
    expect(shown.scope).toContain("no longer held");
    expect(shown.label).toContain("all-time");
  });

  it("renders a hosted table's refusals too", () => {
    const shown = view({
      kind: "hosted",
      table: hosted({ refused: [{ index: 0, game: "deadbeefcafe0001", problems: ["hash mismatch"] }] }),
      host: "api.example",
      window: "held",
    });
    // A hosted leaderboard has more to hide than a local one and exactly the
    // same obligation. `index` means nothing across a wire, so the game id is
    // what names it.
    expect(shown.refusals).toHaveLength(1);
    expect(shown.refusals[0]!.source).toContain("deadbeefcafe");
    expect(shown.refusals[0]!.problems).toEqual(["hash mismatch"]);
  });

  it("keeps the local sentence on a table this browser built", () => {
    const shown = view({ kind: "table", table: table(), names: ["a.json"], unreadable: [] });
    expect(shown.scope).toContain("this browser was given");
    expect(shown.from).toBe("local");
  });
});

describe("reading a table off a service", () => {
  const answer = (body: unknown, status = 200): typeof fetch =>
    async () => new Response(JSON.stringify(body), { status });

  it("asks for the window it was told to", async () => {
    const seen: string[] = [];
    const watching: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ standings: [], counted: [], refused: [], scope: "x" }));
    };
    await fetchTable("https://api.example/", "all", watching);
    // The trailing slash is stripped, as `Directory` strips it, so a URL a
    // person typed and one they pasted reach the same place.
    expect(seen[0]).toBe("https://api.example/rankings?window=all");
  });

  it("refuses something that is not a table rather than rendering it", async () => {
    await expect(fetchTable("https://api.example", "held", answer({ hello: "there" }))).rejects.toThrow(
      /not answer with a table/,
    );
  });

  it("turns an opaque failure into something a player can read", async () => {
    const blocked: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    // A CORS refusal and a service that is down are the same event from inside
    // a page, and `TypeError: Failed to fetch` is not a message.
    await expect(fetchTable("https://api.example", "held", blocked)).rejects.toThrow(
      /may not allow this page to read it/,
    );
  });

  it("says the status when a service answers with one", async () => {
    await expect(
      fetchTable("https://api.example", "held", answer({}, 503)),
    ).rejects.toThrow(/answered 503/);
  });

  it("names a host without its path or scheme", () => {
    expect(hostOf("https://api.example/some/where?x=1")).toBe("api.example");
    // A string that will not parse is shown as typed rather than dropped: the
    // player wrote it, and hiding it would make the table look like nobody's.
    expect(hostOf("not a url")).toBe("not a url");
  });
});
