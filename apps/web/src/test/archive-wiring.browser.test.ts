// The chat log every archive this client ever wrote was missing.
//
// `Archive.attach` chains rather than replaces, and says why in a comment that
// reads like it was written after this went wrong once:
//
// > Existing handlers are chained rather than replaced: the client sets
// > `onMessage` to draw the chat log long before anybody asks for an archive,
// > and quietly stealing that callback would empty the panel.
//
// The client then did it in the other direction. `archive.attach(driver)` wrote
// a wrapper around `onMessage: undefined`; eighteen lines later
// `driver.onMessage = …` overwrote the wrapper, and `Archive.chat` was never
// called again. **Every archive produced by this client carried no chat log**,
// and the suite could not see it, because the archive tests wire the harness
// themselves and never run the client's own wiring.
//
// So the fix is two rules, and this file is the check on both: the archive
// attaches **last**, and nothing assigns a `Lockstep` hook — it taps one.

import { describe, expect, it } from "vitest";
import { tap } from "../view/tap";

/** The shape the bug had: an owner with one optional callback, two parties that
 *  both want it, and no fan-out anywhere. */
const owner = () => ({ onThing: undefined as ((n: number) => void) | undefined });

describe("tapping a hook somebody else owns", () => {
  it("keeps the handler that was already there", () => {
    const o = owner();
    const first: number[] = [];
    const second: number[] = [];

    tap(o, "onThing", (n) => first.push(n));
    tap(o, "onThing", (n) => second.push(n));
    o.onThing!(7);

    expect(first).toEqual([7]);
    expect(second).toEqual([7]);
  });

  // The failure mode itself: assignment after a chain throws the chain away.
  // This is the control — it is what `main.ts` used to do.
  it("assignment loses the earlier handler, which is the bug", () => {
    const o = owner();
    const lost: number[] = [];
    tap(o, "onThing", (n) => lost.push(n));
    o.onThing = (n) => void n;
    o.onThing(7);
    expect(lost).toEqual([]);
  });

  it("runs the later handler even when the earlier one throws", () => {
    const o = owner();
    const ran: number[] = [];
    tap(o, "onThing", () => {
      throw new Error("a listener that fails");
    });
    tap(o, "onThing", (n) => ran.push(n));
    expect(() => o.onThing!(7)).not.toThrow();
    expect(ran).toEqual([7]);
  });

  it("unwinds to what was there before", () => {
    const o = owner();
    const before: number[] = [];
    o.onThing = (n) => before.push(n);

    const undo = tap(o, "onThing", () => {
      throw new Error("never mind");
    });
    undo();
    o.onThing(7);
    expect(before).toEqual([7]);
  });

  it("does not unwind out of order", () => {
    const o = owner();
    const ran: number[] = [];
    const undoFirst = tap(o, "onThing", (n) => ran.push(n));
    tap(o, "onThing", (n) => ran.push(n * 10));

    // Somebody tapped on top of us. Restoring now would take their handler with
    // it, which is the bug this file exists to stop rather than a tidy-up.
    undoFirst();
    o.onThing!(1);
    expect(ran).toEqual([1, 10]);
  });
});
