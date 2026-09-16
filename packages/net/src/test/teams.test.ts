// Team picking, which is the only logic in the app that is neither DOM nor
// network — and the only place a mistake would be invisible until a game
// started with the wrong people on the wrong side.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, MAX_EMPIRES, SEAT_CEILING } from "@tessera/sim";
import { MAX_SEATS, checkPlan, composeTeams } from "../teams.js";
import type { Seated } from "../teams.js";

const players = (...keys: string[]): Seated[] => keys.map((key) => ({ key }));
const wanted = (pairs: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(pairs));

describe("composing teams", () => {
  it("gives everyone an empire of their own by default", () => {
    const { empires, teamOf } = composeTeams(players("a", "b", "c"), new Map());
    expect(empires).toEqual([["a"], ["b"], ["c"]]);
    expect(teamOf).toEqual([0, 1, 2]);
  });

  it("puts players who asked for the same empire on it together", () => {
    const { empires } = composeTeams(players("a", "b", "c"), wanted({ b: 0 }));
    expect(empires).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps seat order stable within an empire", () => {
    const { empires } = composeTeams(players("a", "b", "c"), wanted({ a: 0, b: 0, c: 0 }));
    expect(empires).toEqual([["a", "b", "c"]]);
  });

  // A host who moves everyone to empire 3 has made one empire, not four. The
  // colour beside a name has to be the colour that player will hold.
  it("compacts empires that were left empty", () => {
    const { empires, teamOf } = composeTeams(players("a", "b"), wanted({ a: 3, b: 7 }));
    expect(empires).toEqual([["a"], ["b"]]);
    expect(teamOf).toEqual([0, 1]);
  });

  it("numbers empires by when they were first claimed", () => {
    const { teamOf } = composeTeams(players("a", "b", "c"), wanted({ a: 5, b: 2, c: 5 }));
    expect(teamOf).toEqual([0, 1, 0]);
  });

  it("is idempotent, so re-reading its own output changes nothing", () => {
    const first = composeTeams(players("a", "b", "c"), wanted({ a: 4, b: 9, c: 4 }));
    const back = new Map(players("a", "b", "c").map((p, i) => [p.key, first.teamOf[i]!]));
    expect(composeTeams(players("a", "b", "c"), back)).toEqual(first);
  });

  it("has nothing to say about nobody", () => {
    expect(composeTeams([], new Map())).toEqual({ teamOf: [], empires: [] });
  });
});

describe("checking a plan", () => {
  const here = ["a", "b"];

  it("accepts two people on two empires", () => {
    expect(checkPlan({ empires: [["a"], ["b"]], simbots: [] }, here)).toBe("");
  });

  it("accepts a team of two against a bot empire", () => {
    expect(checkPlan({ empires: [["a", "b"]], simbots: ["steady"] }, here)).toBe("");
  });

  // One empire wins on the first step, which is a game nobody gets to play.
  it("refuses a team of two with nobody to play against", () => {
    expect(checkPlan({ empires: [["a", "b"]], simbots: [] }, here)).toMatch(/two empires/);
  });

  it("refuses a player seated twice", () => {
    expect(checkPlan({ empires: [["a"], ["a", "b"]], simbots: [] }, here)).toMatch(/twice/);
  });

  it("refuses an empire with nobody on it", () => {
    expect(checkPlan({ empires: [["a"], [], ["b"]], simbots: [] }, here)).toMatch(/no members/);
  });

  it("refuses a key nobody here holds", () => {
    expect(checkPlan({ empires: [["a"], ["z"]], simbots: [] }, here)).toMatch(/stranger/);
  });

  it("refuses a plan that forgot somebody", () => {
    expect(checkPlan({ empires: [["a"]], simbots: ["steady"] }, here)).toMatch(/no seat/);
  });

  it("refuses an empty plan", () => {
    expect(checkPlan({ empires: [], simbots: ["steady", "steady"] }, here)).toMatch(/nobody is seated/);
  });

  // An empire held open for somebody who has not arrived yet. Asked for as a
  // count, deliberately: `empires` is `MemberKey[][]`, a shape in which a
  // vacancy is indistinguishable from a mistake, so an empty entry there stays
  // the error it always was and a vacancy stays a decision somebody made.
  describe("empires held open", () => {
    it("accepts them beside a game two empires are already playing", () => {
      expect(checkPlan({ empires: [["a"], ["b"]], simbots: [], vacancies: 2 }, here)).toBe("");
    });

    it("does not let one stand in for the second player", () => {
      // The trap this check exists for. An unclaimed empire is territory, so
      // `victory.ts` leaves it out of `alive` — one player plus one vacancy is
      // one empire standing, `WIN.LAST_EMPIRE` fires on the first pass, and the
      // game ends before anybody can arrive into the seat it was held open for.
      const said = checkPlan({ empires: [["a", "b"]], simbots: [], vacancies: 1 }, here);
      expect(said).toMatch(/somebody is playing/);
    });

    it("still refuses an empty entry in the seat lists", () => {
      // The two say different things and only one of them is on purpose.
      expect(
        checkPlan({ empires: [["a"], [], ["b"]], simbots: [], vacancies: 1 }, here),
      ).toMatch(/no members/);
    });

    it("refuses a count that is not a whole number of empires", () => {
      expect(
        checkPlan({ empires: [["a"], ["b"]], simbots: [], vacancies: -1 }, here),
      ).toMatch(/whole number/);
      expect(
        checkPlan({ empires: [["a"], ["b"]], simbots: [], vacancies: 1.5 }, here),
      ).toMatch(/whole number/);
    });
  });
});

describe("the seat cap", () => {
  const team = ["ka", "kb", "kc", "kd", "ke"];

  // The cap is the whole of team-size fairness, and it is uniform: every empire
  // in a game gets the same number, so no side can field more people than
  // another simply by inviting them.
  it("accepts an empire filled to the cap", () => {
    const full = team.slice(0, MAX_SEATS);
    const plan = { empires: [full, ["kz"]], simbots: [] };
    expect(checkPlan(plan, [...full, "kz"])).toBe("");
  });

  it("refuses one seat past it", () => {
    const over = team.slice(0, MAX_SEATS + 1);
    const plan = { empires: [over, ["kz"]], simbots: [] };
    expect(checkPlan(plan, [...over, "kz"])).toContain("seats");
  });

  // Not merely a manner of the picker. The same rule is in the genesis record,
  // so a hand-rolled host that skipped this check is refused by every peer it
  // sends the record to.
  it("is the rule the simulation will be enforcing", () => {
    expect(MAX_SEATS).toBe(Math.min(DEFAULT_RULES.maxSeats, SEAT_CEILING));
  });
});

describe("banners, refused while the composer can still fix it", () => {
  const here = ["a", "b"];
  const plan = (over: Partial<Parameters<typeof checkPlan>[0]> = {}) => ({
    empires: [["a"], ["b"]],
    simbots: [],
    ...over,
  });

  it("accepts a plan whose empires fly different houses", () => {
    expect(checkPlan(plan({ banners: ["cobalt", "amber"] }), here)).toBe("");
  });

  it("accepts a plan with no banners, which is every plan so far", () => {
    expect(checkPlan(plan(), here)).toBe("");
  });

  it("accepts an empty slot, which means fall back to the index", () => {
    expect(checkPlan(plan({ banners: [undefined, "amber"] }), here)).toBe("");
  });

  it("refuses two empires flying one banner", () => {
    expect(checkPlan(plan({ banners: ["cobalt", "cobalt"] }), here)).toContain("same banner");
  });

  it("refuses a banner that is not in the table", () => {
    expect(checkPlan(plan({ banners: ["sping"] }), here)).toContain("no banner called");
  });

  // Until this check existed the main board drew a seventh empire's territory
  // as nothing at all — the same colour as neutral ground — while the map image
  // drew it as empire 1 and the minimap disagreed with both.
  it("refuses a game with more empires than there are banners", () => {
    const keys = Array.from({ length: MAX_EMPIRES + 1 }, (_, i) => `p${i}`);
    const crowded = { empires: keys.map((key) => [key]), simbots: [] };
    expect(checkPlan(crowded, keys)).toContain("empires");
  });

  it("counts bots and vacancies toward that cap, because they are empires too", () => {
    const bots = Array.from({ length: MAX_EMPIRES - 1 }, () => "steady" as const);
    expect(checkPlan({ empires: [["a"], ["b"]], simbots: bots }, here)).toContain("empires");
    expect(
      checkPlan({ empires: [["a"], ["b"]], simbots: [], vacancies: MAX_EMPIRES - 1 }, here),
    ).toContain("empires");
  });
});
