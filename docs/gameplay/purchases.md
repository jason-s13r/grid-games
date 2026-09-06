# Purchases

A purchase is a state change like any other: signed by the seat, bound to a step
three ahead, gossiped to every peer, [validated](../moves/validation.md)
independently, applied in `(empire, member, seq)` order. No message reports a
diamond balance — every peer *derived* it.

Diamonds are the currency, collected in-sim from
[diamond coins](coins-and-cascades.md). `empire.diamonds` is a `u16` in the
[snapshot](../simulation/snapshot-and-hash.md).

## Two shapes

### Consumables: buy and place separately

| Move | Validated on | Effect |
|---|---|---|
| `BUY_BRIDGE` (2) | `diamonds >= bridgeCost` (3) | `diamonds -= 3`, `bridges += 1` |
| `PLACE_BRIDGE` (4) | `bridges > 0`; terrain is unbridged `RIVER`; tile adjacent to own | terrain → `RIVER_BRIDGED`, `bridges -= 1` |
| `BUY_LADDER` (3) | `diamonds >= ladderCost` (3) | `diamonds -= 3`, `ladders += 1` |
| `PLACE_LADDER` (5) | `ladders > 0`; terrain is unladdered `WALL`; tile adjacent to own | terrain → `WALL_LADDERED`, `ladders -= 1` |

Splitting buy from place lets an empire **bank** a bridge before it knows where
it will need one, and it is why the two have entirely different validation — the
buy checks a balance, the place checks terrain and adjacency and touches the
board. A bridged river / laddered wall is passable **for everyone**, permanently.

### Modifiers: buy once, never place

| Move | Validated on | Effect |
|---|---|---|
| `BUY_MARCH` (9) | `!marchUnlocked` **and** `diamonds >= marchCost` (6) | `diamonds -= 6`, `marchUnlocked = 1` — permanent |
| `BUY_GROWTH` (10) | `!growthUnlocked` **and** `diamonds >= growthCost` (6) | `diamonds -= 6`, `growthUnlocked = 1` — permanent |

Priced at **twice** a bridge because they change how the empire *works* rather
than giving it a thing to carry:

- [`MARCH`](marching.md) — unlocks the ranged move.
- [`GROWTH`](upkeep.md) — every [upkeep](upkeep.md) pass, every tile the capital
  can still reach gains `growthAmount` (1) population, for the rest of the game.
  Not consumed by use; it is a standing property of staying connected.

Both are **refused once already owned** — spending six diamonds on nothing is a
trap, not a decision. The [client](../clients/web-client.md) removes them from the
shop and shows them as HUD badges.

## Inheritance

Stock and unlocks are ordinary hashed state, so
[annexing](elimination-and-annex.md) a capital takes the victim's unspent
diamonds, bridges and ladders as spoils, and OR-s in its `marchUnlocked` /
`growthUnlocked`. A hoard nobody got to spend does not evaporate with the empire
that saved it.

## Coin-replacement economics

Diamonds buy every item at three apiece and drop at weight 15 of ~100
([coin weights](coins-and-cascades.md)), so the replacement rate keeps up with
spending — otherwise the shop would be decoration.
