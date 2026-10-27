# Map generation

[`generate(state)`](../../packages/sim/src/mapgen.ts#L12) runs **once**, at
genesis, from the shared seed — so every peer produces a byte-identical map
without anyone transmitting it. It draws heavily from the RNG, but only here,
before step 0.

## Order

1. `terrain.fill(PLAIN)`.
2. `mountains` (14) then `lakes` (8) random-walk [blobs](#blobs).
3. `rivers` (2) — [edge-to-edge with fords](#rivers-and-fords).
4. `walls` (6) — short straight segments.
5. [`placeCapitals`](#capitals) over the [mainland](#mainland).
6. Seed the first `SPAWN` and `UPKEEP` [events](../simulation/events-not-ticks.md).

All counts are `MapConfig` fields in the genesis
([`DEFAULT_MAP`](../../packages/sim/src/constants.ts#L107)).

## Blobs

[`blob`](../../packages/sim/src/mapgen.ts#L28): pick a random start, take
`rng.range(blobMin, blobMax)` (6–40) orthogonal random-walk steps, painting the
terrain kind; re-roll the position if it walks off the map. O(blob size), never
O(map).

## Rivers and fords

[`river`](../../packages/sim/src/mapgen.ts#L55): a wobbling line from one edge to
the opposite edge (skips mountain tiles). Then [`ford`](../../packages/sim/src/mapgen.ts#L87)
punches `riverGaps` (**3**) passable gaps through it:

- **two tiles wide**, so a ford is walkable rather than a single-file gate a
  neighbour plugs with one claim;
- cut at even spacing with a jittered offset — spacing keeps fords apart, jitter
  keeps them off a predictable line;
- the sideways neighbour is cleared too, because a diagonal step in the walk can
  leave a blocking tile beside the gap.

An unbroken river reads well and plays badly: it seals each side off, so an
empire behind one is isolated until it can afford three diamonds. Fords keep the
river a real obstacle (a long way around, a chokepoint worth holding) while a
[bridge](purchases.md) stays the shortcut, not the only door.

## Mainland

[`mainland`](../../packages/sim/src/mapgen.ts#L139): flood-fill every connected
region of passable ground in **flat-index order** (identical labelling on every
peer), and return a mask of the largest one. Every capital is placed on it, so
every empire can reach every other — this answers the case a ford cannot: a
corner the generator pinched off entirely.

## Capitals

[`placeCapitals`](../../packages/sim/src/mapgen.ts#L177): greedy max-min
separation. For each empire, sample 256 candidate tiles; keep the one whose
nearest already-chosen capital ([`dist2`](../../packages/sim/src/geometry.ts#L44),
integer) is greatest. A candidate must be [`isOpenGround`](../../packages/sim/src/mapgen.ts#L214):
on the mainland mask, neutral, and with `>= 3` passable neutral orthogonal
neighbours. The capital gets `owner = id`, `pop = 1`, `tilesOwned = 1`,
`popTotal = 1`.

[`mapgen.test.ts`](../../packages/sim/src/test/mapgen.test.ts) holds "rivers are
fordable" and "capitals start on open mainland ground".
