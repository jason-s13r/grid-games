// The clock in a game that ends counts down, not up.
//
// `clock(step)` is elapsed time, and for an open-ended game that is the only
// honest reading. For a game whose record sets an `endStep` it is the wrong
// number on screen, and wrong in the direction that matters: a player three
// hours into a three-hour game wants to know they have minutes left, and what
// they were shown was "3:00:00" climbing.
//
// Both readings, and the join window beside them, come off the genesis rules and
// this peer's own step — never off a listing, which is something somebody
// posted to a board. That is the property this file exists to keep, and it is
// why every case below builds its state from a record rather than from a clock.

import { describe, expect, it } from "vitest";
import { hours, makeGenesis, minutes, Sim } from "@tessera/sim";
import type { Genesis, State } from "@tessera/sim";
import { clockLine } from "../view/Controls";

/** A state at a given step. The sim is built once per case and its step moved
 *  by hand: nothing in `clockLine` reads anything else, and running a
 *  three-hour game to its last minute would take three hours. */
const at = (step: number, rules: Partial<Genesis["rules"]> = {}): State => {
  const sim = new Sim(
    makeGenesis({
      seed: 7,
      empires: [{ members: [{ key: "one" }] }, { members: [{ key: "two" }] }],
      map: { width: 32, height: 32 },
      rules: { endStep: hours(3), joinWindow: hours(1), ...rules },
    }),
  );
  sim.state.step = step;
  return sim.state;
};

describe("a game with an end counts down", () => {
  it("shows the whole length at step zero", () => {
    expect(clockLine(at(0))).toContain("3:00:00 left");
  });

  it("shows what is left an hour in, not what has passed", () => {
    // The bug in one line: this used to read "1:00:00".
    expect(clockLine(at(hours(1)))).toContain("2:00:00 left");
  });

  it("shows minutes left at the end of a three-hour game", () => {
    expect(clockLine(at(hours(3) - minutes(4)))).toContain("4:00 left");
  });

  it("does not go negative when a game has run past its end", () => {
    // The sim ends the game, but a peer can be a step or two beyond before it
    // notices, and "-0:02 left" is not a thing to put on a screen.
    expect(clockLine(at(hours(3) + 100))).toContain("0:00 left");
  });
});

describe("a game with no end counts up", () => {
  it("shows elapsed time, which is the only honest reading", () => {
    const line = clockLine(at(minutes(20), { endStep: 0, joinWindow: 0 }));
    expect(line).toContain("20:00");
    expect(line).not.toContain("left");
  });
});

describe("the join window is on the same line, while it is open", () => {
  it("counts down while seats are open", () => {
    expect(clockLine(at(minutes(20)))).toContain("seats open for 40:00");
  });

  it("stops saying anything the moment the window closes", () => {
    // It stops being news. The lobby panel is what says the seats are shut, and
    // a second countdown to a thing that already happened is noise.
    expect(clockLine(at(hours(1)))).not.toContain("seats open");
    expect(clockLine(at(hours(1) + 1))).not.toContain("seats open");
  });

  it("says nothing when the record sets no window at all", () => {
    expect(clockLine(at(minutes(20), { joinWindow: 0 }))).not.toContain("seats open");
  });

  it("says nothing in a solo game, where nobody could walk through the door", () => {
    // A solo game is composed by the same form as a hosted one and carries the
    // same rules — which is right — so its record has a join window like any
    // other. Counting down to it is a countdown to nothing.
    expect(clockLine(at(minutes(20)), false)).not.toContain("seats open");
    // The rest of the line is unaffected: a solo game still ends.
    expect(clockLine(at(minutes(20)), false)).toContain("left");
  });
});

describe("the step number stays on the line", () => {
  it("is the number two peers compare when they disagree", () => {
    expect(clockLine(at(4321))).toContain("step 4321");
  });
});
