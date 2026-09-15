// What a row on the games card says, and which of it is a fact.
//
// The card's whole job is markup and this package has no jsdom, so the view
// model is the thing under test: `rows()` turns listings into plain objects,
// `render()` turns those into strings, and every claim in the plan about a row
// is an assertion about the first half.
//
// The distinction the file exists to pin is the one a player cannot make for
// themselves: a board is allowed to lie, so a number derived from the sealed
// record — the length, the seats, when the door shuts — is a fact, and a number
// the board simply asserted — how many seats are in use — is a claim and has to
// read as one. A row that rendered them alike would be a hostile board's best
// tool.

import { describe, expect, it } from "vitest";
import { CONTROL, hours, makeGenesis, minutes } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import type { GameListing } from "@tessera/net";
import { lengthLabel, rows } from "../view/Games";

const NOW = 1_700_000_000_000;

/** A sealed record, near enough. `rows()` never re-derives anything from it —
 *  `Directory` has already done that — so what matters here is only the fields
 *  a row reads: the empires, the map and the rules. */
const genesis = (extra: Partial<Genesis> = {}): Genesis => ({
  ...makeGenesis({
    seed: 1,
    empires: extra.empires ?? [
      { members: [{ key: "one" }] },
      { members: [{ key: "two" }] },
      { control: CONTROL.SIMBOT, members: [{}] },
    ],
    map: { width: 160, height: 112 },
    rules: { endStep: hours(3), joinWindow: hours(1) },
  }),
  // Overlaid rather than passed in: `makeGenesis` stamps the protocol this
  // build composes and takes no say in it, which is correct of it and is why a
  // test wanting a v99 record has to say so afterwards.
  ...extra,
});

/** A listing as `Directory.list()` hands one over: everything derivable already
 *  derived, and everything claimed still marked. */
const listing = (extra: Partial<GameListing> = {}): GameListing => ({
  gameId: "abcdef0123456789abcdef",
  genesis: genesis(),
  refs: [{ kind: "rtc", code: "tsr-abc234" }],
  unreadable: [],
  resume: [],
  seats: { total: 2, keyed: 2 },
  endsAt: NOW + hours(3) * 0 + 3 * 3600 * 1000,
  joinableUntil: NOW + 3600 * 1000,
  playable: true,
  ...extra,
});

describe("a length is read back out of a step count", () => {
  it("names the durations the setup screen offers", () => {
    // The record carries twelfths of a second and nobody looking for a game
    // thinks in those.
    expect(lengthLabel(hours(72))).toBe("3 days");
    expect(lengthLabel(hours(3))).toBe("3 hours");
    expect(lengthLabel(hours(1))).toBe("1 hour");
    expect(lengthLabel(minutes(15))).toBe("15 minutes");
    expect(lengthLabel(hours(240))).toBe("10 days");
  });

  it("does not round a custom length into a different game", () => {
    // 90 minutes is 90 minutes. Calling it "2 hours" would name a game nobody
    // composed.
    expect(lengthLabel(minutes(90))).toBe("90 minutes");
    expect(lengthLabel(minutes(45))).toBe("45 minutes");
  });

  it("says so when a record sets no end at all", () => {
    // Legal forever, for every v3 record and anything composed by hand.
    expect(lengthLabel(0)).toBe("open-ended");
  });
});

describe("the clock on a row", () => {
  it("counts down while the game is running", () => {
    const [row] = rows([listing({ endsAt: NOW + 2 * 3600 * 1000 + 14 * 60 * 1000 })], NOW);
    expect(row!.timeLeft).toBe("2:14:00 left");
  });

  it("drops to days and hours for a long game, which does not need its seconds", () => {
    const [row] = rows([listing({ endsAt: NOW + (2 * 86_400 + 3 * 3600) * 1000 })], NOW);
    expect(row!.timeLeft).toBe("2d 3h left");
  });

  it("says ended rather than a negative countdown", () => {
    const [row] = rows([listing({ endsAt: NOW - 1000 })], NOW);
    expect(row!.timeLeft).toBe("ended");
  });

  it("says nothing at all when the record sets no end", () => {
    const [row] = rows([listing({ endsAt: undefined })], NOW);
    expect(row!.timeLeft).toBe("");
  });
});

describe("the join window", () => {
  it("counts down while it is open", () => {
    const [row] = rows([listing({ joinableUntil: NOW + 41 * 60 * 1000 + 2000 })], NOW);
    expect(row!.joining).toBe("seats open for 41:02");
  });

  it("stops being a countdown once it has shut", () => {
    // It stops being news about when to hurry and becomes a fact about the
    // game.
    const [row] = rows([listing({ joinableUntil: NOW - 1 })], NOW);
    expect(row!.joining).toBe("seats closed");
  });

  it("says nothing when the record sets no window", () => {
    const [row] = rows([listing({ joinableUntil: undefined })], NOW);
    expect(row!.joining).toBe("");
  });
});

describe("facts and claims are not rendered alike", () => {
  it("counts seats off the record", () => {
    const [row] = rows([listing({ seats: { total: 4, keyed: 4 } })], NOW);
    expect(row!.seats).toBe("4 seats");
  });

  it("names the seats that came empty, which is what a vacancy is", () => {
    const [row] = rows([listing({ seats: { total: 4, keyed: 3 } })], NOW);
    expect(row!.seats).toBe("4 seats, 1 empty");
  });

  it("puts occupancy in the board's voice, because the board cannot know it", () => {
    // It moves by amendment and by drop and the board sees neither.
    const [row] = rows([listing({ seatsUsed: 3 })], NOW);
    expect(row!.claim).toBe("the board says 3 are in use");
  });

  it("says nothing about occupancy when the board claimed nothing", () => {
    const [row] = rows([listing({ seatsUsed: undefined })], NOW);
    expect(row!.claim).toBe("");
  });
});

describe("witnesses are the one thing a stranger cannot manufacture", () => {
  it("says a game is witnessed, and by how many of the seats it needed", () => {
    const [row] = rows(
      [listing({ proof: { ok: true, endorsed: 3, needed: 3, problems: [], step: 41_200 } })],
      NOW,
    );
    expect(row!.proof).toContain("Witnessed at step 41,200");
    expect(row!.proof).toContain("3 of the 3 seats");
  });

  it("says a short tally is short, rather than dropping it", () => {
    // "This has 1 of the 2 signatures it needs" is something a player should
    // read before concluding anything.
    const [row] = rows(
      [listing({ proof: { ok: false, endorsed: 1, needed: 2, problems: [], step: 900 } })],
      NOW,
    );
    expect(row!.proof).toContain("only 1 of the 2 signatures");
  });

  it("calls a row with no witnesses a rumour, and still shows it", () => {
    // Hiding unproven rows would hide every game composed in the last five
    // minutes, which are the games a board is most needed for.
    const [row] = rows([listing({ proof: undefined })], NOW);
    expect(row!.proof).toContain("No witnesses yet");
    expect(row!.action).toBe("join");
  });
});

describe("what a row offers", () => {
  it("offers a join while it has doors", () => {
    const [row] = rows([listing()], NOW);
    expect(row!.action).toBe("join");
    expect(row!.doors).toBe("one way in");
  });

  it("counts the doors it was given", () => {
    const [row] = rows(
      [
        listing({
          refs: [
            { kind: "rtc", code: "tsr-abc234" },
            { kind: "socket", url: "wss://relay.example", room: "abc234" },
          ],
        }),
      ],
      NOW,
    );
    expect(row!.doors).toBe("2 ways in");
  });

  it("offers a rejoin when there are no doors but somebody kept the state", () => {
    // The row the address book exists for: a game everybody left on Tuesday is
    // not a gone game.
    const [row] = rows(
      [listing({ refs: [], resume: ["https://host.example/room/abc234/resume"] })],
      NOW,
    );
    expect(row!.action).toBe("rejoin");
    expect(row!.doors).toBe("no doors listed");
  });

  it("offers nothing when there is neither a door nor a kept state", () => {
    const [row] = rows([listing({ refs: [], resume: [] })], NOW);
    expect(row!.action).toBe("none");
  });
});

describe("a game this build cannot play", () => {
  it("is shown as unplayable rather than hidden", () => {
    // A lobby that silently omits the game a player is in is the worst possible
    // answer.
    const result = rows(
      [listing({ playable: false, genesis: genesis({ protocol: 99 }) })],
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.action).toBe("none");
    expect(result[0]!.notes.join(" ")).toContain("does not play v99");
  });

  it("carries the shelf-life notice for a superseded rule set", () => {
    const [row] = rows([listing({ sunset: { version: 3, until: "2026-12-01" } })], NOW);
    expect(row!.notes.join(" ")).toContain("rule set 3");
    expect(row!.notes.join(" ")).toContain("2026-12-01");
  });

  it("reports doors it could not read without dropping the row", () => {
    // A client that dropped them would report fewer ways in than the game has.
    const [row] = rows([listing({ unreadable: ["quic://somewhere/else"] })], NOW);
    expect(row!.notes.join(" ")).toContain("cannot open");
    // The door it *can* read is still there, so the row is still joinable.
    expect(row!.action).toBe("join");
  });
});

describe("what a row calls the game", () => {
  it("counts the empires and names the map, because a game has no name yet", () => {
    const [row] = rows([listing()], NOW);
    expect(row!.title).toBe("3 empires · 160×112");
    expect(row!.opponents).toBe("1 of them a bot");
    expect(row!.short).toBe("abcdef012345");
  });

  it("says nothing about bots when there are none", () => {
    const [row] = rows(
      [
        listing({
          genesis: genesis({ empires: [{ members: [{ key: "one" }] }, { members: [{ key: "two" }] }] }),
        }),
      ],
      NOW,
    );
    expect(row!.opponents).toBe("");
  });
});
