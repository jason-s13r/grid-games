# Upkeep

Every `upkeepInterval` (**20 s**, an `EVENT.UPKEEP` on the
[event heap](../simulation/events-not-ticks.md)), one flood-fill per empire from
its capital produces two mechanics at once. [`upkeep(state, dirty)`](../../packages/sim/src/upkeep.ts#L65).

## reachable()

[`reachable(state, empire)`](../../packages/sim/src/upkeep.ts#L34): a BFS over the
empire's **own** tiles, starting from the capital, returning a `Uint8Array` mask
— 1 where the capital still connects. If the empire does not own its capital tile
the mask is all zero.

Then, one pass over the ownership layer:

## Decay — tiles the capital cannot reach

```
loss = max(decayMin, floor(pop × decayNum / decayDen))   // max(1, pop / 8)
```

A cut-off tile loses **at least 1, or an eighth**, per pass. When `pop` hits 0
the tile goes neutral (`setOwner(state, i, 0)`).

Territory carved out behind enemy lines used to sit on the board forever, so
encircling an opponent achieved nothing until every one of their tiles was
individually overwhelmed. Now cutting a supply line is worth something on its own:
a pocket withers over a couple of minutes (slow enough that a **relief column is
a real answer**), and a dead empire's islands clear themselves off the map.

## Growth — tiles the capital can reach

Only if `empire.growthUnlocked` (bought with [`BUY_GROWTH`](purchases.md)): every
reachable owned tile gains `growthAmount` (1) population, every pass, for the rest
of the game.

A defensive boost, and the one thing that rewards a **consolidated, connected**
empire over a sprawl of disconnected raids. Deliberately a standing property, not
a timed buff — what it pays for is staying joined up.

## Both feed popTotal

`empire.popTotal` is adjusted by the net `delta` of the whole sweep
([`upkeep.ts:103`](../../packages/sim/src/upkeep.ts#L103)), floored at 0.

## Cost

One pass over ~6k tiles (default map) per 20 s of game time — so a six-hour
[fast-forward](../simulation/the-step.md) is about a thousand sweeps, not a
quarter of a million. [`upkeep.test.ts`](../../packages/sim/src/test/upkeep.test.ts)
holds the decay fraction, "severing a line orphans what's behind", and the growth
unlock.
