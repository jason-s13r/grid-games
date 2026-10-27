// A solo game is a hosted game with nobody else in it.
//
// The setup screen asks one set of questions and both kinds of game read the
// answers, so the properties worth pinning are where the two used to differ:
// a solo game's length, which the picker offered but only a hosted game took,
// and a bot tuned by hand, which the lobby could not offer at all.
//
// The DOM those answers are collected through is not what is under test here —
// what is, is that whatever the screen collected reaches the genesis record,
// because that record is the game and everything downstream reads it.

import { describe, expect, it } from "vitest";
import { DIFFICULTY, TUNING, durationRules, minutes, tuneBot, PHASE, WIN } from "@tessera/sim";
import { LocalGame } from "../game/Local";

const solo = (extra: Partial<ConstructorParameters<typeof LocalGame>[0]> = {}) =>
  new LocalGame({ seed: 11, bots: ["steady"], width: 32, height: 32, ...extra });

describe("a solo game takes the setup screen's answers", () => {
  it("runs for the length that was chosen", () => {
    const rules = solo({ duration: durationRules(minutes(30)) }).sim.state.genesis.rules;
    expect(rules.endStep).toBe(minutes(30));
    // The two windows that have to move with it, so a long game does not hand
    // the win to whoever went to bed last.
    expect(rules.joinWindow).toBe(Math.round(minutes(30) / 3));
    expect(rules.abandonWindow).toBe(durationRules(minutes(30)).abandonWindow);
  });

  // The shape every game had before the length picker was shared, and what a
  // record composed by hand still gets. Absent is open-ended, not zero-length.
  it("and is open-ended when no length is given", () => {
    expect(solo().sim.state.genesis.rules.endStep).toBe(0);
  });

  it("is played on the map that was chosen", () => {
    const state = solo({ width: 48, height: 40 }).sim.state;
    expect([state.width, state.height]).toEqual([48, 40]);
  });

  // The one a chosen length actually decides. Nothing in a solo game can reach
  // the other two endings on its own: the bots never go silent, and neither
  // side is about to lose a capital inside a minute.
  it("and ends on time with whoever holds the most ground", () => {
    const game = solo({ duration: durationRules(minutes(1)) });
    // The driver derives its step from the wall clock; the sim is what the end
    // is a property of, so drive that directly rather than the stopwatch.
    while (game.sim.state.phase === PHASE.PLAYING) game.sim.advance([]);
    // Victory is checked before the clock ticks, so the step that ended it is
    // `endStep` and the state comes to rest one past it.
    expect(game.sim.state.step).toBe(minutes(1) + 1);
    expect(game.sim.state.winReason).toBe(WIN.TIMEOUT);
  });
});

describe("a bot tuned by hand", () => {
  it("reaches the genesis record as a profile of its own", () => {
    const brutal = tuneBot({
      ...TUNING.hard,
      coins: 100,
      phases: { expand: 30, attack: 150, defend: 0, fortify: 0, heal: 0, sleep: 0 },
    });
    const genesis = solo({ bots: ["easy", brutal] }).sim.state.genesis;

    // A preset seats as its preset and a tuning as itself, side by side in the
    // one game — which is the whole point of `BotChoice` being a union.
    expect(genesis.empires[1]!.members[0]!.bot).toEqual(DIFFICULTY.easy);
    expect(genesis.empires[2]!.members[0]!.bot).toEqual(brutal);
    expect(Object.keys(brutal.phases!)).toEqual(["expand", "attack"]);
  });

  // Asking for more than the game allows holds the seat back rather than
  // lifting it, which is why an arbitrary profile is safe to accept from a
  // host. The clamp is the simulation's, and this is the path it is on.
  it("cannot ask for a ceiling above the game's own", () => {
    const greedy = tuneBot({ ...TUNING.hard, popMax: 5000 });
    const state = solo({ bots: [greedy] }).sim.state;
    expect(greedy.popMax).toBe(5000);
    expect(state.empires[1]!.members[0]!.popMax).toBe(state.genesis.rules.popMax);
  });
});
