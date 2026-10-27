# Claiming

`CLAIM` (type 1) is the core move: spend a seat's whole
[population timer](population.md) onto one tile.

## Validation

[`validate`](../moves/validation.md), `CLAIM` branch
([`rules.ts:297`](../../packages/sim/src/rules.ts#L297)):

- the tile is `passable`;
- `member.popTimer > 0`;
- the tile is not a [shielded capital](capitals.md) (`isShielded(direct = true)`);
- you **already own the tile**, or it is orthogonally `adjacentToOwned` by your
  empire.

Claiming a tile you own is legal and useful — it thickens it.

## The surround multiplier

[`multiplier(state, x, y, empire)`](../../packages/sim/src/rules.ts#L218): count
of the target's orthogonal neighbours **your empire owns**, clamped to
`1 .. maxMultiplier` (**4**). Surround a tile on all four sides and a 999 bank
lands `999 × 4 = 3996` on it.

```
spent = popTimer
base  = spent × multiplier(target)
```

`spent` (the raw bank) and `base` (after the multiplier) are both used: `base` is
what lands, `spent` is what a [coin cascade](coins-and-cascades.md) under the tile
spreads from. The multiplier is a fact about *the tile you clicked* and is
charged once; the coin's own geometry multiplier is charged separately, per tile,
inside the cascade. (Charging both put an enclosed gold at sixteen times the
population that set it off — a bug that is now explicitly avoided,
[`rules.ts:490`](../../packages/sim/src/rules.ts#L490).)

## place() — the ownership primitive

[`place(state, i, empire, amount, dirty, direct)`](../../packages/sim/src/rules.ts#L67)
generalises the prototype's `cells[x][y] += power`:

- **Own tile, or empty neutral:** `pop[i] += amount`. If it was not yours, you
  now own it (`captured`).
- **Someone else's tile (or populated neutral):** `pop[i] -= amount`.
  - Goes **negative** → the tile flips to you with the remainder as its
    population (`captured`).
  - Lands **exactly at 0** → the tile goes neutral… **unless it is a capital**,
    which stays its empire's at nothing until a second click walks onto it. See
    [elimination-and-annex.md](elimination-and-annex.md).
- On capturing a live empire's **capital** → [`annex`](elimination-and-annex.md)
  fires.

`amount <= 0` and a shield check both short-circuit `place` to a no-op.

## land() — claim then fire the tile

[`land`](../../packages/sim/src/rules.ts#L505) is what `claim` actually calls:

1. If the tile holds a **coin** (bronze/silver/gold): `place()` the claim
   *first*, then [`cascade`](coins-and-cascades.md) spreads on top.
2. If it holds a **diamond**: `collectDiamond` (+1 to `empire.diamonds`), then
   `place()`.
3. Otherwise just `place()`.

The claim landing *before* the cascade is deliberate: a coin used to consume the
claim and redistribute it, so clicking a coin put *less* on the clicked tile than
clicking bare ground would — a downgrade on contested ground. Now a claim on a
coin places more than bare ground, not less.

## Stats touched

`POP_SPENT` (+`spent`), `MOVES` (+1), and on a capture `TILES_TAKEN` /
`TILES_ONE_MOVE`; `PEAK_TILES` / `PEAK_POP` are raised.
[`rules.test.ts`](../../packages/sim/src/test/rules.test.ts) pins the multiplier
and the terrain checks.
