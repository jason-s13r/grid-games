// Game time, in the units a ten-day game needs.
//
// There were two formatters and neither could render one: `Chat`'s `mm:ss` has
// an unbounded minute field, so day ten read `14400:00`, and `Controls`' clock
// has no days at all. Durations made ten-day games ordinary, so this is one
// formatter with days in it — and the short cases must read exactly as they
// always did, or every existing screenshot stops matching.

import { describe, expect, it } from "vitest";
import { STEPS_PER_SECOND } from "@tessera/sim";
import { span, stamp } from "../view/clock";

const at = (seconds: number): number => seconds * STEPS_PER_SECOND;

describe("stamp", () => {
  it("reads as it always did under an hour", () => {
    expect(stamp(0)).toBe("0:00");
    expect(stamp(at(9))).toBe("0:09");
    expect(stamp(at(75))).toBe("1:15");
    expect(stamp(at(59 * 60 + 59))).toBe("59:59");
  });

  it("grows an hour field only once there is one", () => {
    expect(stamp(at(3600))).toBe("1:00:00");
    expect(stamp(at(3600 * 5 + 61))).toBe("5:01:01");
  });

  // The case the old formatter got wrong, and the reason this file exists.
  it("grows a day field rather than an unbounded minute field", () => {
    expect(stamp(at(86_400))).toBe("1d 00:00:00");
    expect(stamp(at(86_400 * 10))).toBe("10d 00:00:00");
    expect(stamp(at(86_400 * 3 + 3600 * 4 + 5 * 60 + 6))).toBe("3d 04:05:06");
    // What it used to say.
    expect(stamp(at(86_400 * 10))).not.toBe("14400:00");
  });

  it("does not go backwards past zero", () => {
    expect(stamp(-5)).toBe("0:00");
  });
});

describe("span", () => {
  // "You were away for 8h 12m" is the honest thing a reloaded tab can say about
  // the gap, because the events that filled it cannot be derived.
  it("says how long in the units a person would", () => {
    expect(span(at(45))).toBe("45s");
    expect(span(at(90))).toBe("1m");
    expect(span(at(3600 * 8 + 60 * 12))).toBe("8h 12m");
    expect(span(at(86_400 * 2 + 3600 * 3))).toBe("2d 3h");
  });
});
