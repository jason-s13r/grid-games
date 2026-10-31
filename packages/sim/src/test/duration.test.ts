// A duration is a step count, and the two windows that must move with it.
//
// The table below is the whole argument. It is not invented arithmetic: the
// clamp reproduces, exactly, the hand-written preset table durations used to
// be — which is the check worth having, because the formula is only defensible
// if it lands on the numbers somebody chose one at a time.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, days, hours, minutes } from "../constants.js";
import {
  MAX_DURATION,
  MIN_ABANDON_WINDOW,
  NO_ABANDONMENT,
  durationRules,
} from "../duration.js";

describe("a game with an end has no abandonment", () => {
  it.each([
    ["15 minutes", minutes(15)],
    ["1 hour", hours(1)],
    ["1 day", hours(24)],
    ["10 days", hours(240)],
    ["31 days", days(31)],
  ])("a %s game idles to its timeout", (_label, endStep) => {
    // The trap this closes: any window short of the game is a losing condition
    // for going to bed, or for checking in every few days.
    expect(durationRules(endStep).abandonWindow).toBe(NO_ABANDONMENT);
  });

  it("an open-ended game keeps the floor, having nothing else to end it", () => {
    expect(durationRules(0).abandonWindow).toBe(MIN_ABANDON_WINDOW);
  });
});

describe("the door is a fraction of the game", () => {
  it.each([
    [minutes(15), 1 / 3, minutes(5)],
    [hours(1), 1 / 3, minutes(20)],
    [hours(1), 1 / 4, minutes(15)],
    [hours(1), 1 / 2, minutes(30)],
    [hours(72), 1 / 3, hours(24)],
  ])("%d steps at share %d opens for %d", (endStep, share, expected) => {
    expect(durationRules(endStep, share).joinWindow).toBe(expected);
  });

  it("seals a table with 1, not with 0", () => {
    // 0 has to keep meaning "always open", because every genesis written so
    // far lacks the field and is read as 0. Step 0 is the composition of the
    // record itself, so a window that shuts at step 1 is the honest half-open
    // reading of "no late joins".
    expect(durationRules(hours(6), 0).joinWindow).toBe(1);
  });

  it("leaves an open-ended game open, at any share", () => {
    expect(durationRules(0, 1 / 3).joinWindow).toBe(0);
  });
});

describe("an arbitrary length", () => {
  it("round-trips without a preset", () => {
    const rules = durationRules(minutes(47));
    expect(rules.endStep).toBe(minutes(47));
    expect(rules.joinWindow).toBe(Math.round(minutes(47) / 3));
  });

  it("is clamped at the ceiling rather than thrown on", () => {
    expect(durationRules(days(365)).endStep).toBe(MAX_DURATION);
    expect(durationRules(-5).endStep).toBe(0);
  });
});

describe("the open-ended case needs no branch", () => {
  it("reproduces DEFAULT_RULES field for field", () => {
    // Read off DEFAULT_RULES rather than retyped, so the two cannot drift.
    expect(durationRules(0)).toEqual({
      endStep: DEFAULT_RULES.endStep,
      joinWindow: DEFAULT_RULES.joinWindow ?? 0,
      abandonWindow: DEFAULT_RULES.abandonWindow,
    });
  });

  it("and DEFAULT_RULES still carries no joinWindow at all", () => {
    // Optional rather than defaulted: a game composed with no duration has to
    // be byte-identical to what a v3 build composed, or every game id moves.
    expect("joinWindow" in DEFAULT_RULES).toBe(false);
  });
});
