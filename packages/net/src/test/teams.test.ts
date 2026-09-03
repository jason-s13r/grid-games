// Team picking, which is the only logic in the app that is neither DOM nor
// network — and the only place a mistake would be invisible until a game
// started with the wrong people on the wrong side.

import { describe, expect, it } from "vitest";
import { MAX_BOTS_PER_EMPIRE, checkPlan, composeTeams } from "../teams.js";
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
    expect(checkPlan({ empires: [["a"], ["b"]], simbots: 0 }, here)).toBe("");
  });

  it("accepts a team of two against a bot empire", () => {
    expect(checkPlan({ empires: [["a", "b"]], simbots: 1 }, here)).toBe("");
  });

  // One empire wins on the first step, which is a game nobody gets to play.
  it("refuses a team of two with nobody to play against", () => {
    expect(checkPlan({ empires: [["a", "b"]], simbots: 0 }, here)).toMatch(/two empires/);
  });

  it("refuses a player seated twice", () => {
    expect(checkPlan({ empires: [["a"], ["a", "b"]], simbots: 0 }, here)).toMatch(/twice/);
  });

  it("refuses an empire with nobody on it", () => {
    expect(checkPlan({ empires: [["a"], [], ["b"]], simbots: 0 }, here)).toMatch(/no members/);
  });

  it("refuses a key nobody here holds", () => {
    expect(checkPlan({ empires: [["a"], ["z"]], simbots: 0 }, here)).toMatch(/stranger/);
  });

  it("refuses a plan that forgot somebody", () => {
    expect(checkPlan({ empires: [["a"]], simbots: 1 }, here)).toMatch(/no seat/);
  });

  it("refuses an empty plan", () => {
    expect(checkPlan({ empires: [], simbots: 2 }, here)).toMatch(/nobody is seated/);
  });
});

describe("bot seats in a plan", () => {
  const a = "ka";
  const b = "kb";

  it("accepts a bot seat alongside a person", () => {
    expect(checkPlan({ empires: [[a], [b]], simbots: 0, bots: [1, 0] }, [a, b])).toBe("");
  });

  it("accepts a solo empire covering itself overnight", () => {
    expect(checkPlan({ empires: [[a]], simbots: 1, bots: [MAX_BOTS_PER_EMPIRE] }, [a])).toBe("");
  });

  it("refuses more bot seats than an empire may hold", () => {
    const plan = { empires: [[a], [b]], simbots: 0, bots: [MAX_BOTS_PER_EMPIRE + 1, 0] };
    expect(checkPlan(plan, [a, b])).toContain("bot seats");
  });

  it("refuses a fractional or negative count", () => {
    expect(checkPlan({ empires: [[a], [b]], simbots: 0, bots: [-1, 0] }, [a, b])).not.toBe("");
    expect(checkPlan({ empires: [[a], [b]], simbots: 0, bots: [1.5, 0] }, [a, b])).not.toBe("");
  });

  it("refuses a count with no empire to sit in", () => {
    expect(checkPlan({ empires: [[a], [b]], simbots: 0, bots: [0, 0, 1] }, [a, b])).toBe(
      "a bot is seated in no empire",
    );
  });

  // Bot seats are seats, not empires: three of them do not make a game.
  it("does not let bot seats stand in for a second empire", () => {
    expect(checkPlan({ empires: [[a, b]], simbots: 0, bots: [3] }, [a, b])).toBe(
      "a game needs at least two empires",
    );
  });
});
