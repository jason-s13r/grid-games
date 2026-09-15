// The strip that says how long this is going to take.
//
// A three-day game is three million steps and checking one is not quick. Almost
// everything worth pinning here is about what a player is told during a wait
// they did not expect: which of the two phases is running, that a bar which
// cannot move does not pretend to, that a refusal is the whole list, and that
// the track is drawn against the game that happened rather than the length its
// record asked for.

import { describe, expect, it } from "vitest";
import { view } from "../view/Scrubber";

describe("while the log is being checked", () => {
  const shown = view({ kind: "checking" });

  it("says what it is doing rather than showing a bar that cannot move", () => {
    // This phase is one call into `verifyArchive`, which owns its own loop and
    // reports nothing on the way through. A bar sitting at zero for a minute is
    // a worse lie than no bar at all.
    expect(shown.label).toContain("Checking every signature");
    expect(shown.percent).toBe(0);
  });

  it("offers no track, because there is nothing to scrub to yet", () => {
    expect(shown.scrubbable).toBe(false);
  });

  it("counts as work in flight, so the way out says Stop", () => {
    expect(shown.working).toBe(true);
  });
});

describe("while the timeline is being built", () => {
  it("shows both clocks, because a share alone means nothing on a long game", () => {
    // "62%" of a game the player has never seen is not a length of time. "1:20:00
    // of 2:10:00" is.
    const shown = view({ kind: "building", step: 12 * 3600, total: 12 * 7800 });
    expect(shown.label).toContain("1:00:00");
    expect(shown.label).toContain("2:10:00");
    expect(shown.percent).toBe(46);
  });

  it("is still not scrubbable — a half-built ladder cannot answer a seek", () => {
    expect(view({ kind: "building", step: 10, total: 100 }).scrubbable).toBe(false);
  });
});

describe("once it is ready", () => {
  it("gives the track the length of the game that actually happened", () => {
    const shown = view({ kind: "ready", step: 0, total: 43_200 });
    expect(shown.max).toBe(43_200);
    expect(shown.scrubbable).toBe(true);
    expect(shown.working).toBe(false);
  });

  it("says the step as well as the time, which is the number two peers compare", () => {
    expect(view({ kind: "ready", step: 41_200, total: 43_200 }).label).toContain("41,200");
  });

  it("stays draggable during a seek, and keeps the track where it was put", () => {
    // The worker answers the last step asked for and drops nothing, so snapping
    // the handle back and then forward again would be the only jump in the
    // whole gesture.
    const shown = view({ kind: "seeking", step: 30_000, total: 43_200 });
    expect(shown.scrubbable).toBe(true);
    expect(shown.step).toBe(30_000);
    expect(shown.working).toBe(true);
  });
});

describe("when the file does not check out", () => {
  it("carries every reason, never the first one", () => {
    // The same rule the observer's `rank` follows: a verifier that shows one
    // line of what was wrong with a file is one nobody can act on.
    const problems = [
      "archive begins at step 41200, so it cannot be replayed from the start",
      "bad signature at step 900 from 2:0",
      "hash mismatch: the log reaches 0a1b2c3d, the archive claims deadbeef",
    ];
    const shown = view({ kind: "refused", problems });
    expect(shown.problems).toEqual(problems);
    expect(shown.label).toContain("3 problems");
  });

  it("does not say \"problems\" about one problem", () => {
    expect(view({ kind: "refused", problems: ["not an archive"] }).label).toBe(
      "That log did not check out.",
    );
  });

  it("never becomes scrubbable", () => {
    // The whole point of checking first. A log that failed is not a timeline
    // with a caveat on it.
    const shown = view({ kind: "refused", problems: ["not an archive"] });
    expect(shown.scrubbable).toBe(false);
    expect(shown.max).toBe(0);
  });
});
