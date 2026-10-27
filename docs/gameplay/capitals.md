# Capitals

Each empire has one `capital` tile. It is **home**: under the default
`ELIMINATION.CAPITAL` rule, an empire is eliminated the moment it no longer owns
its capital ([victory.md](victory.md)). So the capital is protected — but only
just enough.

## isShielded — what a capital will not absorb

[`isShielded(state, i, attacker, direct)`](../../packages/sim/src/rules.ts).
Three rules now, and the middle one is the only one that never lifts:

### 1. Grace (lifts)

While the empire is still *protected*, its capital takes **nothing at all**, from
anybody, by any route. [`isProtected`](../../packages/sim/src/rules.ts):

```
since = step - arrivedAt(empire)

if since >= graceSteps        ->  not protected      (a hard ceiling in time)
else protected while    pop[capital] < graceCapitalPop  (60)
                    and popTotal     < gracePopTotal    (400)
                    and tilesOwned   < graceTiles       (40)
```

Read it as **a ceiling in time, lifted early by any one measure of strength**.
Crossing any bar ends protection immediately; otherwise it runs to `graceSteps`.
It is a grace period for finding your feet, not a shell to hide in.

The order matters. Four conditions OR'd together could only ever *shorten*
protection — every one added is another way to lose it early — and somebody who
arrives holding ground would trip the tile bar on the step they arrive. So the
time bound sits outside the disjunction.

**The clock is the empire's own, not the game's.** `arrivedAt` is the earliest
`joinedAt` across an empire's members, so an empire seated at genesis is 0
forever and one that arrived by [claiming a vacancy](empires-and-seats.md) on day
three gets its grace on day three. Three minutes from step zero is not a shorter
grace to a late arrival; it is none at all.

Grace belongs to the **empire**, not to the person. A team does not get its
capital immunity back by voting in a substitute on day six: the minimum across
its members is still zero.

`graceSteps` and `graceTiles` were `noobSteps` and `noobTiles`, which are still
read when a record carries only those — every game composed before vacancies
keeps exactly the protection it was composed with.

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

### 3. An unclaimed empire's pocket (lifts on arrival)

An empire the map generator placed and nobody has claimed is **territory, not a
player** — see [empires-and-seats.md](empires-and-seats.md). Nothing may be
taken, marched into, marched *through*, cascaded into, bridged or laddered within
`vacancyRadius` (default 6, a von Neumann ball of 85 tiles) of its capital, until
somebody arrives.

That is one check rather than four, because every ownership change in the game
goes through `place` and `place` asks on its second line. The layer it asks is a
count of how many unclaimed capitals cover each tile, which is also what makes
overlapping pockets behave: a tile inside two is protected until both are
claimed.

On arrival the pocket becomes the **starting grant**: every passable tile inside
it that is still neutral becomes the new empire's, at `vacancyGrant` population
each. That is the real answer to the camper. A shield alone tells an attacker
exactly where to build and hands the arrival a single tile inside a sealed wall;
a grant means they appear holding the pocket with a border to push from, and the
wall buys a siege rather than a kill.

Ground the camper actually holds is never granted. The arrival gets somewhere to
stand, not a free conquest.

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
