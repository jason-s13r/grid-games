# Capitals

Each empire has one `capital` tile. It is **home**: under the default
`ELIMINATION.CAPITAL` rule, an empire is eliminated the moment it no longer owns
its capital ([victory.md](victory.md)). So the capital is protected — but only
just enough.

## isShielded — what a capital will not absorb

[`isShielded(state, i, attacker, direct)`](../../packages/sim/src/rules.ts#L50).
Two rules, and only the first ever lifts:

### 1. Noob protection (lifts)

While the empire is still *protected*, its capital takes **nothing at all**, from
anybody, by any route. [`isProtected`](../../packages/sim/src/rules.ts#L28):

```
empire.tilesOwned < noobTiles  (40)   AND   state.step < noobSteps  (3 min)
```

Protection lifts as soon as **either** condition fails — you grew past 40 tiles,
or three minutes passed. It is a grace period for finding your feet, not a shell
to hide in.

### 2. Direct-only (never lifts)

After protection, the capital takes nothing that did not come from **beside it**.
`direct` is `true` only for a [`CLAIM`](claiming.md), and a claim's adjacency
requirement means it was made from a tile touching the capital. Specifically the
capital does **not** fall to:

- a [`MARCH`](marching.md) — it lands two tiles out, so by construction the
  attacker holds no border on it;
- a [cascade](coins-and-cascades.md) sweeping over it — that is a coin's geometry,
  not anybody's decision.

This is what keeps a ranged move from ending a game on its own. A march can take
every tile *around* a capital — that is a siege, and a good one — but the last
square has to be walked onto in the open, where the defender has a neighbour to
push back at and a turn in which to do it.

## isShielded also protects the via tile

[`marchVia`](marching.md) skips a shielded capital, so a march cannot even *pass
through* one.

## Losing it

When a claim reduces a capital's population below zero (or captures it outright),
[`annex`](elimination-and-annex.md) fires: the whole empire transfers to the
attacker. When a claim reduces it to *exactly* zero, it stays the empire's — at
nothing — until a second click takes it. Emptying and taking are not the same
event; see [elimination-and-annex.md](elimination-and-annex.md).

The capital starts at `pop = 1` and `tilesOwned = 1` at
[genesis](map-generation.md).
