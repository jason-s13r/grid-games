# The state model

[`State`](../../packages/sim/src/state.ts#L22) is four flat typed-array layers
over the grid, plus per-empire records, plus a few scalars.

## The board layers

Every layer is length `width * height`, indexed `i = y * width + x`
([`geometry.ts:35`](../../packages/sim/src/geometry.ts#L35)).

| Layer | Type | Meaning |
|---|---|---|
| `owner` | `Int8Array` | `0` neutral, `1..N` empire |
| `pop` | `Int32Array` | population on the tile, always `>= 0` |
| `terrain` | `Uint8Array` | `TERRAIN` enum — plain, mountain, lake, river, bridged, wall, laddered |
| `item` | `Uint8Array` | `ITEM` enum — none, bronze, silver, gold, diamond |

Ownership living in **its own layer** — rather than in the sign of `pop`, as the
frozen prototype packed it — is what unlocks N empires and neutral-but-populated
tiles. The prototype's `cells[x][y]` packed owner and population into one signed
integer, which capped the game at two players and left nowhere for terrain or
coins on the same tile.

`tilesOwned` on each empire is only ever changed by
[`setOwner`](../../packages/sim/src/rules.ts#L19), so the counter can never drift
from the board.

## Scalars

`step`, `itemCount`, `phase` (`PLAYING` / `ENDED`), `winner`, `winReason`, and
two objects that carry their own serialised state: `rng`
([rng.md](rng.md)) and `events` ([events-not-ticks.md](events-not-ticks.md)).

## Empire records

[`Empire`](../../packages/sim/src/types.ts#L261), one per colour:

| Field | Meaning |
|---|---|
| `id`, `control` | `1..N`; `HUMAN` or `SIMBOT` |
| `capital` | tile index of the home square |
| `bridges`, `ladders` | unplaced stock, bought with diamonds |
| `marchUnlocked`, `growthUnlocked` | `0/1` permanent unlock flags |
| `diamonds` | spendable currency, collected in-sim |
| `tilesOwned`, `popTotal` | live totals |
| `alive`, `eliminatedAt` | `0/1` and the step it fell |
| `members[]` | the seats |
| `stats` | `Uint32Array(16)` — see [balance / stats](../gameplay/difficulty-and-balance.md) |

## Seat records

[`Member`](../../packages/sim/src/types.ts#L247), one per seat:

| Field | Meaning |
|---|---|
| `kind` | `HUMAN` or `BOT` |
| `popMax` | this seat's population ceiling — `rules.popMax` for a person, lower for a dialled-down bot. In state, not read from genesis, because a seat can arrive by amendment and a snapshot must carry what it grew |
| `popTimer` | banked population, spent in full by a claim/march |
| `popAcc` | sub-step accrual remainder (integer-only accrual) |
| `lastBeat` | step of this seat's last `HEARTBEAT` — the liveness input |
| `joinedAt` | step the seat was created |
| `stats` | `Uint32Array(16)` |

"An empire is not a player: it is a set of seats sharing territory, each with its
own population timer." See [gameplay/empires-and-seats.md](../gameplay/empires-and-seats.md).

## What is *not* in state

Member **keys** — the sim addresses seats by index; the roster
maps index to key, outside the sim. Also: signatures, chat, camera, sockets. See
continuity/what-is-hashed.md.

## The real empire ceiling is 127, not 255

`state.owner` is an `Int8Array`, one entry per tile, holding the empire id.
`inspectGenesis` used to refuse only above 255, on the grounds that empire ids
ride in single bytes of every signed move — true, and not the binding
constraint.

An id above 127 stores as a **negative number** the moment it is written, and
that is a simulation bug rather than a repaint. Follow it:

- every `owner > 0` test reads that tile as **neutral**, so the empire's
  territory is unowned to combat, upkeep, cascades and claiming, and any
  opponent may take it for free;
- the next `setOwner` on that tile finds a negative `prev`, skips the decrement,
  and `tilesOwned` **never comes back down**;
- `isProtected` and `checkVictory` both read `tilesOwned`, so the empire sits on
  a fictitious count that only grows and can satisfy a victory condition over
  tiles drawn as empty;
- `state.winner` is `i8` too, so such an empire cannot even be recorded as
  having won.

`inspectGenesis` now refuses above **127**, which is the free half of the fix:
the record is declined rather than allowed to reach a state where the rules and
the board disagree inside one peer. Widening `owner` to a `Uint8Array` is the
real half, it moves `LAYOUT_VERSION`, and it is the only change in the series
that would break a snapshot in flight — so it is its own plan.

In practice the [banner](../gameplay/empires-and-seats.md) cap bites first.
