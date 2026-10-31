// The end of a game says it is over, from where the viewer sits.
//
// A game used to end with a thin strip along the board and a clock frozen on
// "7d left", which read as a game that had stopped working. These pin down what
// replaced it: a headline from your point of view, the reason in words, your
// place, and a clock that says the game is over.

import { describe, expect, it } from "vitest";
import { PHASE, STEPS_PER_SECOND, WIN } from "@tessera/sim";
import type { WinReason } from "@tessera/sim";
import { LocalGame } from "../game/Local";
import { clockLine } from "../view/Controls";
import { endBar, endCard, ordinal } from "../view/EndCard";
import { empireTheme } from "../view/palette";

const ended = (winner: number, reason: WinReason) => {
  const game = new LocalGame({ seed: 7, bots: ["steady", "steady"], width: 32, height: 32 });
  const state = game.sim.state;
  state.step = 3 * 3600 * STEPS_PER_SECOND;
  state.phase = PHASE.ENDED;
  state.winner = winner;
  state.winReason = reason;
  return state;
};

const none = () => "";

describe("the end card", () => {
  it("says you won when you did", () => {
    const html = endCard(ended(1, WIN.TIMEOUT), 1, none);
    expect(html).toContain("You won!");
    expect(html).toContain("Time ran out");
    expect(html).toContain("end-confetti");
    expect(html).not.toContain("You came");
  });

  it("names the winner and your place when you did not", () => {
    const html = endCard(ended(2, WIN.LAST_EMPIRE), 1, none);
    expect(html).toContain(`${empireTheme(2).name} wins`);
    expect(html).toContain("last empire standing");
    expect(html).toMatch(/You came \d+(st|nd|rd|th)\./);
    expect(html).not.toContain("end-confetti");
  });

  it("names the winner to somebody watching", () => {
    const html = endCard(ended(2, WIN.TIMEOUT), 0, none);
    expect(html).toContain(`${empireTheme(2).name} wins`);
    expect(html).not.toContain("You came");
  });

  it("tucks into a bar with a way back", () => {
    expect(endBar(ended(1, WIN.TIMEOUT), 1)).toContain("data-end-show");
  });

  it("stops the clock on game over rather than the time that was left", () => {
    expect(clockLine(ended(1, WIN.TIMEOUT))).toBe("Game over · lasted 3h 0m");
  });

  it("counts places the way people say them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "103rd",
    ]);
  });
});
