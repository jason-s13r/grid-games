# Coins and cascades

Coins are the one way in the game to gain ground faster than
[population](population.md) accrues. Claiming a tile with a coin on it fires a
**cascade**.

## Spawning

An `EVENT.SPAWN` fires every `rng.range(coinIntervalMin, coinIntervalMax)` steps
(**1.5–4 s**), self-rescheduling — see
[simulation/events-not-ticks.md](../simulation/events-not-ticks.md).
[`spawnItem`](../simulation/the-step.md) then:

- does nothing if `itemCount >= maxItemsOnMap` (360);
- probes up to 24 times, **4 RNG draws per probe** (`seed`, `near`, `dx`, `dy`) —
  a fixed count so the stream stays a function of state;
- with `coinNearBias` (**72%**) chance, hops the probe `±coinNearRadius` (4)
  tiles off an owned seed tile — landing it just outside somebody's border;
- accepts only a **neutral, item-free, passable** tile;
- picks the type by `rng.weighted(coinWeights)`: bronze **52**, silver **24**,
  gold **9**, diamond **15**.

Uniform placement put most coins in empty country nobody was fighting over, so
the shop stayed out of reach and the cascade — the best thing in the game — never
fired. The near-bias fixes that; a minority stay uniform so the far map is not
dead ground.

## Coins vs diamonds

A **diamond** is just currency: [`collectDiamond`](../../packages/sim/src/rules.ts#L648)
adds 1 to `empire.diamonds`, clears the tile, no cascade. Diamonds are collected
when a claim or a cascade passes over one — never sent, always derived. See
[purchases.md](purchases.md).

A **coin** (bronze/silver/gold) triggers `cascade`.

## The cascade

[`cascade(state, origin, item, base, ...)`](../../packages/sim/src/rules.ts#L544).
`base` is the raw `spent` population behind the claim (before the surround
multiplier — that was already charged once in [`claim`](claiming.md)).

```
shape   = vonNeumannBall(COIN_RADIUS[item])   // radius 0 / 1 / 2 for bronze/silver/gold
perTile = max(1, floor(base / shape.length))
```

Then, breadth-first from the origin over the shape, for every passable tile in
it:

- population placed = `perTile × surroundedBy(offset, radius)` —
  [`surroundedBy`](../../packages/sim/src/rules.ts#L616) counts how many of the
  tile's orthogonal neighbours are *also inside the ball*, clamped `1..4`. Pure
  geometry, read off the offset, so it is identical on every peer regardless of
  paint order;
- any **coin** found inside the radius is taken and **queued** — chained
  cascades, capped at `cascadeTileCap` (4096) tiles touched;
- any **diamond** found is collected.

**Population is created, not divided.** The same `perTile` is spread across the
whole shape — that is what makes farming an enclosed neutral pocket explosive,
and what turns a chain into a sudden jump in tile count.

The rarest coin is the one whose middle is worth having: bronze has no interior
beyond its own tile (single strength); a gold coin is 13 interior tiles at ×4 and
12 rim tiles at less.

A coin is cleared the moment it is **queued**, so it can fire at most once.

## Farming

Coins spawn only on neutral passable tiles. Enclose an area, leave neutral
pockets inside it, and they keep producing — then a single claim on a fresh coin
cascades across the whole enclosed field.
[`rules.test.ts`](../../packages/sim/src/test/rules.test.ts) holds "a cascade
creates, not divides".
