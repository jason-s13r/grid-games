# The board

A rectangular grid. Default 96 × 64 ([`DEFAULT_MAP`](../../packages/sim/src/constants.ts#L107));
the client offers small 96×72, medium 160×112, large 256×176. Map size is a
genesis parameter, bounded by memory (at 1024×1024 the four layers are ~7 MB).

Every tile is one index `i = y * width + x`
([`geometry.ts:35`](../../packages/sim/src/geometry.ts#L35)). Neighbours are the
**four orthogonal** offsets, `ORTHO`
([`geometry.ts:8`](../../packages/sim/src/geometry.ts#L8)) — not diagonals, and
not including the tile itself. (The frozen prototype's `getNeighbours` returned a
plus-shape of 5 *including self*, which is why a fully surrounded tile there
scored a multiplier of 5 instead of 4.)

## Terrain

`TERRAIN` ([`types.ts:11`](../../packages/sim/src/types.ts#L11)), one `Uint8Array`
layer:

| # | Terrain | Passable? | Notes |
|---|---|---|---|
| 0 | `PLAIN` | yes | ordinary ground |
| 1 | `MOUNTAIN` | **no** | permanent |
| 2 | `LAKE` | **no** | permanent |
| 3 | `RIVER` | **no** | until bridged |
| 4 | `RIVER_BRIDGED` | yes | a `PLACE_BRIDGE` converted it |
| 5 | `WALL` | **no** | until laddered |
| 6 | `WALL_LADDERED` | yes | a `PLACE_LADDER` converted it |

`PASSABLE = [true, false, false, false, true, false, true]`
([`constants.ts:12`](../../packages/sim/src/constants.ts#L12)). Mountains and
lakes are permanent obstacles; rivers and walls open **once**, for everyone, when
somebody spends a [bridge or ladder](purchases.md) on that tile. A claim, a
march, a march's via tile and a cascade all refuse an impassable tile.

## Items

`ITEM` ([`types.ts:22`](../../packages/sim/src/types.ts#L22)), one `Uint8Array`
layer, at most one item per tile:

| # | Item | Role |
|---|---|---|
| 0 | `NONE` | — |
| 1 | `BRONZE` | cascade radius 0 |
| 2 | `SILVER` | cascade radius 1 (5 tiles) |
| 3 | `GOLD` | cascade radius 2 (13 tiles) |
| 4 | `DIAMOND` | +1 to the empire's `diamonds`, no cascade |

`COIN_RADIUS = [0, 1, 2, 3, 0]` ([`constants.ts:17`](../../packages/sim/src/constants.ts#L17)).
Items spawn only on **neutral passable** tiles, on a schedule, near owned
territory — see [coins-and-cascades.md](coins-and-cascades.md). `itemCount` caps
at `maxItemsOnMap` (360).

## Capitals

Each empire has one `capital` tile ([`Empire.capital`](../../packages/sim/src/types.ts#L263)).
It is the home square: an empire is eliminated by not owning its capital, and a
capital is [shielded](capitals.md) against everything but a claim made from beside
it. Placed once at genesis by [`placeCapitals`](map-generation.md).

## Ownership and population

`owner` (`Int8Array`, `0` neutral / `1..N`) and `pop` (`Int32Array`, `>= 0`) are
the other two layers. A tile can be neutral *and* populated — leftover
population on a tile nobody currently owns. See
[simulation/state-model.md](../simulation/state-model.md).
