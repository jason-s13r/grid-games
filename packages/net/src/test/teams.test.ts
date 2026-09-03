// Team picking, which is the only logic in the app that is neither DOM nor
// network — and the only place a mistake would be invisible until a game
// started with the wrong people on the wrong side.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, SEAT_CEILING } from "@tessera/sim";
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
