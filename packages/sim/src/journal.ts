// What happened, derived from what is already hashed.
//
// The obvious way to build a reader's event stream is to have the simulation
// emit one, and that is the wrong way round here. `applyMove` returns nothing
// and tells nobody what it did; `checkVictory` sets `alive = 0` in silence;
// `EventQueue` is a **scheduler** rather than an event bus — `runEvents` polls
// one, calls `upkeep` or `spawnItem`, and drops it; and `Sim.advance` returns
// tile indices with no account of why any of them is dirty. Adding an emitter
// would be new machinery in the one part of the tree where new machinery is
// most expensive.
//
// **The outcomes are already in hashed state.** `bump` and `raise` write into
// `empire.stats` and `member.stats`, and `stats.ts` opens by saying why:
//
// > Stats live inside hashed state, so end-of-game figures are consensus by
// > construction rather than something a client reports and a server must
// > trust.
//
// So the stream is a **diff of hashed counters between two steps**, and its
// determinism is not a property anybody has to arrange — it falls out of the
// one invariant. Two peers at the same step hold the same counters, so they
// derive the same lines. `summarise` is the precedent and its doc comment is
// the argument in advance: "Derived entirely from hashed state, so any peer
// computes the same awards."

import { STAT } from "./constants.js";
import { EVENT } from "./events.js";
import { PHASE, WIN } from "./types.js";
import type { WinReason } from "./types.js";
import type { State } from "./state.js";

/** Everything the journal reads, copied flat.
 *
 *  Sixteen counters per empire plus a handful of scalars — nothing here is a
 *  tile array, so one of these per step is cheap enough to keep. */
export interface Tally {
  step: number;
  phase: number;
  winner: number;
  winReason: number;
  empires: Array<{
    id: number;
    alive: number;
    tilesOwned: number;
    popTotal: number;
    stats: number[];
  }>;
}

export function tally(state: State): Tally {
  return {
    step: state.step,
    phase: state.phase,
    winner: state.winner,
    winReason: state.winReason,
    empires: state.empires.map((empire) => ({
      id: empire.id,
      alive: empire.alive,
      tilesOwned: empire.tilesOwned,
      popTotal: empire.popTotal,
      stats: [...empire.stats],
    })),
  };
}

export type WorldEventKind =
  | "took"
  | "annexed"
  | "cascade"
  | "coin"
  | "diamond"
  | "bridge"
  | "ladder"
  | "march"
  | "eliminated"
  | "upkeep"
  | "ended";

export interface WorldEvent {
  step: number;
  kind: WorldEventKind;
  /** Who did it, or whom it happened to. 0 for something that happened to the
   *  whole board. */
  empire: number;
  /** How many, where a count is the point — tiles annexed, population swept. */
  count?: number;
  /** The other empire, where there is one. */
  other?: number;
  reason?: WinReason;
}

/** Whether the step about to run is an upkeep sweep.
 *
 *  No stat counts a sweep, and none should — but upkeep is a **metronome**:
 *  `scheduleUpkeep` pushes `from + rules.upkeepInterval` with no RNG draw in it,
 *  so the queue's head is readable before the step runs and "this is an upkeep
 *  step" is a fact of state rather than something to be emitted. The population
 *  the sweep cost is then the `popTotal` delta on exactly those steps. */
export function isUpkeepStep(state: State): boolean {
  const head = state.events.heap[0];
  return !!head && head.type === EVENT.UPKEEP && head.step <= state.step;
}

/** What changed between a tally and the state now.
 *
 *  Empty when nothing did, which is most steps and is the guard against a log
 *  that narrates every tick. */
export function journal(before: Tally, after: State, upkeep = false): WorldEvent[] {
  const events: WorldEvent[] = [];
  const step = after.step;
  // A tally taken against a different roster is a tally from before a snapshot
  // was adopted. Diffing across that adoption would greet a returning player
  // with one enormous fabricated line — *Vermilion annexed 1,412 tiles* — so
  // the answer is to emit nothing and let the caller reset.
  if (before.empires.length !== after.empires.length) return events;

  for (const [at, empire] of after.empires.entries()) {
    const was = before.empires[at];
    if (!was || was.id !== empire.id) continue;

    const grew = (slot: number): number => empire.stats[slot]! - was.stats[slot]!;

    // The commonest line in the log, and the one the plan's own list omitted:
    // `ANNEXED` is bumped only when an empire *inherits* an eliminated one's
    // ground (`rules.ts`), so a game full of ordinary captures would have
    // produced an empty log. `TILES_TAKEN` is what a player actually watches
    // happen. It is also why the panel needs a filter rather than a scrollback.
    const took = grew(STAT.TILES_TAKEN);
    if (took > 0) events.push({ step, kind: "took", empire: empire.id, count: took });

    // Inheritance, which is a different event and a rarer one: an empire fell
    // and somebody got everything it was holding.
    const annexed = grew(STAT.ANNEXED);
    if (annexed > 0) events.push({ step, kind: "annexed", empire: empire.id, count: annexed });

    const cascade = grew(STAT.CASCADE_TILES);
    if (cascade > 0) events.push({ step, kind: "cascade", empire: empire.id, count: cascade });

    // Three coin counters, one line. Which metal is worth saying; three
    // separate lines for one step is not.
    const coins =
      grew(STAT.COINS_BRONZE) + grew(STAT.COINS_SILVER) + grew(STAT.COINS_GOLD);
    if (coins > 0) events.push({ step, kind: "coin", empire: empire.id, count: coins });

    const diamonds = grew(STAT.DIAMONDS);
    if (diamonds > 0) events.push({ step, kind: "diamond", empire: empire.id, count: diamonds });

    if (grew(STAT.BRIDGES) > 0) events.push({ step, kind: "bridge", empire: empire.id });
    if (grew(STAT.LADDERS) > 0) events.push({ step, kind: "ladder", empire: empire.id });
    if (grew(STAT.MARCHES) > 0) events.push({ step, kind: "march", empire: empire.id });

    // An empire that was alive and is not. `eliminatedAt` is in hashed state
    // too, so this agrees on every peer without being announced.
    if (was.alive && !empire.alive) {
      events.push({ step, kind: "eliminated", empire: empire.id });
    }
  }

  // Upkeep costs population across the board, and the sweep is the one thing
  // worth logging that no counter records. The number is the total the board
  // lost on a step the metronome named.
  if (upkeep) {
    const lost =
      before.empires.reduce((sum, one) => sum + one.popTotal, 0) -
      after.empires.reduce((sum, one) => sum + one.popTotal, 0);
    if (lost > 0) events.push({ step, kind: "upkeep", empire: 0, count: lost });
  }

  if (before.phase !== PHASE.ENDED && after.phase === PHASE.ENDED) {
    events.push({
      step,
      kind: "ended",
      empire: after.winner,
      reason: (after.winReason || WIN.NONE) as WinReason,
    });
  }

  return events;
}
