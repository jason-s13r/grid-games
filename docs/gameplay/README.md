# Gameplay

Empire Attack is a grid-territory conquest game. Empires expand across a 2-D grid
by spending accrued population, contest ground, cut each other's supply lines,
and win by taking capitals.

## A game from a player's chair

1. **You are one seat in one empire.** The map generates from the shared seed;
   your capital is placed on open mainland ground, `pop = 1`, one tile owned.
   [the-board.md](the-board.md), [map-generation.md](map-generation.md).
2. **Population banks on its own**, one per step (12/s), up to `popMax` (999).
   You do not spend it in amounts — a `CLAIM` spends the *whole* timer.
   [population.md](population.md).
3. **You expand by claiming** tiles adjacent to ones you own. Surrounding a tile
   before you take it multiplies the population that lands, up to ×4.
   [claiming.md](claiming.md).
4. **Coins spawn on neutral ground near the fighting.** Claiming a tile with a
   coin fires a **cascade** — the same population spread across the coin's whole
   shape, *created* not divided. The best thing in the game. Diamonds are
   currency. [coins-and-cascades.md](coins-and-cascades.md).
5. **Diamonds buy** bridges and ladders (to cross rivers and walls), and the
   permanent `MARCH` and `GROWTH` unlocks. [purchases.md](purchases.md).
6. **`MARCH`** (once unlocked) claims a tile two out, filling the gap from the
   same spend — a ranged attack that opens a new front.
   [marching.md](marching.md).
7. **Upkeep**, every 20 s, floods from each capital: tiles it can still reach are
   safe (and grow, if you bought `GROWTH`); tiles cut off **decay** and go
   neutral. A pincer is a real move. [upkeep.md](upkeep.md).
8. **You lose your empire when you lose your capital.** The victor annexes
   everything — tiles, population, unspent stock, learned unlocks.
   [capitals.md](capitals.md), [elimination-and-annex.md](elimination-and-annex.md).
9. **The game ends** when one empire is left, when only one is still present for
   hours, or at the timeout a host chose. [victory.md](victory.md),
   [durations.md](durations.md).

## Every page

| Page | Covers |
|---|---|
| [the-board.md](the-board.md) | Grid, terrain, passability, items, capitals |
| [empires-and-seats.md](empires-and-seats.md) | Empire ≠ player; teams; the seat cap; shift handover |
| [population.md](population.md) | The timer, `popMax`, accrual, what a claim spends |
| [claiming.md](claiming.md) | `CLAIM`, the surround multiplier, `place()`, `land()` |
| [marching.md](marching.md) | `MARCH`, the via tile, the split spend, the limits |
| [coins-and-cascades.md](coins-and-cascades.md) | Coin radii, cascade geometry, diamonds |
| [purchases.md](purchases.md) | Bridges, ladders, `BUY_MARCH`, `BUY_GROWTH` |
| [capitals.md](capitals.md) | The capital as home; shielding; noob protection |
| [elimination-and-annex.md](elimination-and-annex.md) | Emptied ≠ taken; `annex()` |
| [upkeep.md](upkeep.md) | The connectivity sweep: decay and growth |
| [victory.md](victory.md) | Win conditions, tie-breaks, liveness |
| [durations.md](durations.md) | How long a game runs, and the two windows that scale with it |
| [map-generation.md](map-generation.md) | Seeded terrain, rivers and fords, capital placement |
| [bots.md](bots.md) | SimBot vs PeerBot; profiles; the targeting policy |
| [difficulty-and-balance.md](difficulty-and-balance.md) | The full `DEFAULT_RULES` balance sheet, and the stat slots |
