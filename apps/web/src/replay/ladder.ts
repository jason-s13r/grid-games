// How far apart to keep the snapshots a scrubber seeks against.
//
// `Sim` has no undo, by design — a step is a hash, not a diff — so scrubbing to
// step 900,000 and then back to 899,000 replays 899,000 steps unless something
// was kept. Keeping everything is not an option either: a snapshot is roughly
// seven bytes a tile plus the empires, so a large map (256×176, 45,056 tiles) is
// about 320KB a rung, and a fixed ladder of 512 rungs would be 160MB of a
// browser tab's memory for one saved game.
//
// So the budget is a count and the spacing is derived from it. 256 rungs at
// 320KB is ~80MB worst case and ~12MB on a small map, and a seek costs at most
// one restore plus `ladder` advances. The honest consequence is that a long game
// has coarse rungs — a ten-day game lands at about 40,000 steps apiece, roughly
// three seconds to seek — which is why the scrubber shows progress rather than
// pretending a seek is instant.

/** Never finer than this, however short the game. Below about five minutes of
 *  game per rung the ladder costs more memory than the seek it saves is worth:
 *  4,096 steps is ~340ms of replay, which is already under a frame budget's
 *  worth of waiting. */
export const MIN_LADDER = 4096;

/** The budget, in rungs. Memory is the constraint and a count is the only thing
 *  that bounds it — spacing bounds seek time instead, and a ladder cannot
 *  optimise for both. */
export const RUNGS = 256;

/** Steps between snapshots, for a game of `steps` steps. */
export function ladderFor(steps: number): number {
  return Math.max(MIN_LADDER, Math.ceil(Math.max(0, steps) / RUNGS));
}

/** How many rungs a game of `steps` will actually produce, including the one at
 *  step zero. Handed to `SnapshotStore`, whose eviction is a count: a store
 *  short by one drops the rung at zero and makes seeking to the beginning the
 *  most expensive seek there is. */
export function rungsFor(steps: number, ladder: number = ladderFor(steps)): number {
  return Math.floor(Math.max(0, steps) / ladder) + 1;
}

/** The rung a seek to `step` will land on. Exported for the tests, which assert
 *  the property the whole file exists for — that no seek is worse than `ladder`
 *  advances — rather than the arithmetic that happens to produce it. */
export function rungBelow(step: number, ladder: number): number {
  return Math.floor(Math.max(0, step) / ladder) * ladder;
}
