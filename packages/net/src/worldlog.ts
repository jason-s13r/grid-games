// The stream two players can compare, and the line where it stops being one.
//
// `journal()` derives world events from hashed counters, so its determinism is
// free. What it cannot see is the roster: a seat arriving by amendment and a
// seat dropped by quorum are facts about the game that live in `net`, not in
// the simulation.
//
// **But only half of an ejection is shared**, and the split runs straight
// through one callback:
//
// | Fact | Same on every peer? |
// |---|---|
// | a seat was ejected, and at which step | **yes** — a signed record at a fixed step |
// | *why* it was ejected | **no** — `dropReason` is local by design |
// | `late` on the same callback | **no** — how far this peer had got when it found out |
// | an equivocation proof | **no** — two peers receive different frames |
// | a desync | **no** — this peer's hash against a majority it can see |
//
// So `onEjection` delivers one shared fact and two local ones together, and a
// log line reading "Dave was dropped for desyncing" is not identical on any two
// screens. This composer takes the shared half and drops `reason`, `late`,
// `onViolation` and `onDesync` — those belong in a session stream, in the other
// register, where a reader can tell which kind of line they are looking at.
//
// That split is also why this lives here rather than in `apps/web`: **a test
// that proves two peers agree cannot be written in a package that cannot hold
// two peers.**

import { isUpkeepStep, journal, tally } from "@tessera/sim";
import type { Tally, WorldEvent } from "@tessera/sim";
import type { Lockstep, Seat } from "./lockstep.js";

/** A world event plus the two the roster contributes. */
export type LogEvent =
  | WorldEvent
  | { step: number; kind: "seated"; empire: number; member: number }
  | { step: number; kind: "dropped"; empire: number; member: number };

export interface WorldLogOptions {
  /** How many lines to keep. A multi-day game produces more than any reader
   *  wants and more than any panel should hold. */
  cap?: number;
  onEvent?: (events: readonly LogEvent[]) => void;
}

const DEFAULT_CAP = 500;

/** Derives the shared stream from a driver, and keeps the last `cap` of it. */
export class WorldLog {
  private readonly events: LogEvent[] = [];
  private last?: Tally;
  private upkeepDue = false;
  private readonly undo: Array<() => void> = [];
  private readonly cap: number;

  constructor(
    private readonly driver: Lockstep,
    private readonly options: WorldLogOptions = {},
  ) {
    this.cap = options.cap ?? DEFAULT_CAP;
    this.last = tally(driver.sim.state);
  }

  /** Chain onto the driver's hooks. Returns the undo, and never *assigns* —
   *  every hook here is already spoken for by somebody. */
  attach(): () => void {
    // **One hook, and it is the one that fires on the wrong side.**
    //
    // `onApplied` carries the step's *inputs*, announced before anything
    // happens — useless as an event source, and perfect as a shutter: it is the
    // last moment before a step runs, which is exactly where a diff wants its
    // `before`. So each call first journals the step that just finished, then
    // takes the tally for the step about to start.
    //
    // `onDirty` cannot do this job at all: it fires once per `pump`, after as
    // many as 240 steps, so it can attribute nothing to a step. It is chained
    // only as a flush, so the last step of a game is not left unjournaled
    // waiting for a step that never comes.
    this.chain("onApplied", () => this.mark());
    this.chain("onDirty", () => this.mark());
    this.chain("onSeated", (seat: Seat) =>
      this.add({
        step: this.driver.sim.step,
        kind: "seated",
        empire: seat.empire,
        member: seat.member,
      }),
    );
    // The shared half only. `reason` and `late` are this peer's and go to the
    // session stream, which is the register that exists for exactly this.
    this.chain("onEjection", (seat: Seat, atStep: number) =>
      this.add({ step: atStep, kind: "dropped", empire: seat.empire, member: seat.member }),
    );
    return () => {
      for (const undo of this.undo.splice(0)) undo();
    };
  }

  /** Everything derived so far, oldest first. */
  all(): readonly LogEvent[] {
    return this.events;
  }

  /** Journal the step that just finished, then arm for the next one.
   *
   *  Idempotent: called twice at one step, the second diff is against a tally
   *  taken from the same state and produces nothing. That is what lets the
   *  pump's flush and the per-step shutter share a method. */
  private mark(): void {
    const state = this.driver.sim.state;
    const before = this.last;

    if (before) {
      // **A tally must not be diffed across an adopted snapshot.** A resumed
      // peer never simulates the intervening steps — the moves that built that
      // state were broadcast before it was listening — so `adopt` restores
      // every stat at once, and a naive differ would greet the returning player
      // with one enormous fabricated line: *Vermilion annexed 1,412 tiles.* A
      // step that went backwards or jumped is that adoption, and the answer is
      // to reset rather than to narrate.
      const jumped = state.step < before.step || state.step - before.step > 1;
      if (!jumped) {
        const found = journal(before, state, this.upkeepDue);
        if (found.length > 0) this.add(...found);
      }
    }

    this.last = tally(state);
    // Read for the step about to run, because once it has run the queue's head
    // has moved on and the sweep is unrecoverable.
    this.upkeepDue = isUpkeepStep(state);
  }

  private add(...events: LogEvent[]): void {
    this.events.push(...events);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
    this.options.onEvent?.(events);
  }

  private chain<K extends keyof Lockstep>(hook: K, next: (...args: never[]) => void): void {
    const owner = this.driver as unknown as Record<string, unknown>;
    const before = owner[hook as string] as ((...args: unknown[]) => void) | undefined;
    const chained = (...args: unknown[]): void => {
      before?.(...args);
      (next as unknown as (...a: unknown[]) => void)(...args);
    };
    owner[hook as string] = chained;
    this.undo.push(() => {
      if (owner[hook as string] === chained) owner[hook as string] = before;
    });
  }
}
