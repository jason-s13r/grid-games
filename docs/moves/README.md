# Moves

There is exactly **one kind of state change**. A `Move` is the only thing that
ever mutates hashed state, and [`Sim.advance`](../simulation/the-step.md) is the
only thing that applies one. Everything else that crosses the wire either carries
a move, agrees about a move, or is not hashed at all.

| Page | Covers |
|---|---|
| [the-move-record.md](the-move-record.md) | The seven fields, sixteen bytes, and what is deliberately missing |
| [move-encoding.md](move-encoding.md) | `encodeMove` — the bytes that get signed, and the three properties they carry |
| [the-eleven-types.md](the-eleven-types.md) | Every type: what it uses `x,y` for, what it is validated on, what it does |
| [validation.md](validation.md) | `validate()` — the whole anti-cheat story, a pure function of state |

> **A note on the name.** Of the eleven "moves", only `CLAIM` and `MARCH` are
> spatial. The rest are purchases, placements, roster management and liveness —
> actions, not moves. The type is called `MoveType` throughout the code; the
> rename is a known, deliberately-deferred piece of tidying.
