# Marching

`MARCH` (type 8) claims a tile **two** out from the border, filling the tile in
between from the same population spend. It is a ranged attack — arrows, not a
column — and it is how a front opens where the defender was not watching.

Available only once the empire has bought [`BUY_MARCH`](purchases.md) (6
diamonds, permanent, inherited on [annexation](elimination-and-annex.md)).

## Validation

[`validate`](../moves/validation.md), `MARCH` branch
([`rules.ts:307`](../../packages/sim/src/rules.ts#L307)):

- `empire.marchUnlocked`;
- `member.popTimer > 0`;
- target is `passable`;
- target is **not** a [shielded capital](capitals.md) (`isShielded`, direct
  false — a march can never take a capital);
- target is **not** already `adjacentToOwned` — a bordering tile is an ordinary
  [claim](claiming.md), and a march on one would be a silent waste;
- a legal **via tile** exists.

## The via tile

[`marchVia(state, x, y, empire)`](../../packages/sim/src/rules.ts#L195): the tile
orthogonally beside the target that is passable, not a shielded capital, and
itself on the empire's border. **Lowest flat index wins** — so two peers never
pick different halves of the same move.

The chain is `owned tile → via → target`, every link orthogonal, every tile
crossable. A march reaches two tiles by *walking*, not hopping: a mountain, lake,
unbridged river or unladdered wall in the gap leaves no via at all and the move
is refused. Bridges and ladders are how that gap gets crossed, and they have to
be paid for.

## The split spend

[`march`](../../packages/sim/src/rules.ts#L431):

```
mult  = multiplier(via)          // border is at the via tile, not the target
spent = popTimer                 // then popTimer = popAcc = 0
base  = spent × mult
half  = floor(base / 2)
```

- `half` goes to the **via** tile through the full [`land`](claiming.md) path
  (backed by `floor(spent / 2)` raw), so a coin or diamond *in the gap* fires and
  is collected — marching over ground must not be worth less than claiming it.
- `base - half` goes to the **target** via plain `place()`. An item on the tile
  it *lands on* is left where it lies — so a march onto a coin ends with the coin
  on a tile you now own, claimable next for a full-strength cascade.

Both halves land on rival ground as readily as empty ground. The one square
neither half can take is a capital.

## What it costs

No stock. It spends population like a claim (the whole timer) and buys **reach**,
permanently — which is why `BUY_MARCH` costs twice what a bridge does.
[`march.test.ts`](../../packages/sim/src/test/march.test.ts) covers the reach,
the split, the terrain refusals, and "a capital still falls to a claim from
beside it".

Stats: `POP_SPENT`, `MARCHES`, `MOVES`, and captures as for a claim.
