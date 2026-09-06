# The RNG

[`Rng`](../../packages/sim/src/rng.ts#L9) is mulberry32 — the **only** source of
randomness in the simulation.

## The generator

State is a single uint32, `s`. `next()`
([`rng.ts:16`](../../packages/sim/src/rng.ts#L16)) advances it by
`0x6d2b79f5` and scrambles, returning a uint32. Because the whole state is one
number, it serialises in the [snapshot header](snapshot-and-hash.md) as `u32
rng.s` and a `restore` resumes the identical stream.

| Method | Returns |
|---|---|
| `next()` | raw uint32 |
| `int(n)` | `next() % n` in `[0, n)`; `0` if `n <= 0` |
| `range(lo, hi)` | integer in `[lo, hi]` inclusive |
| `pick(list)` | a random element, or `undefined` if empty |
| `weighted(pairs)` | a value chosen by weight; `pairs` **must be in a fixed order on every peer** |
| `clone()` | a new `Rng` at the same state |

`weighted` is used for [coin type selection](../gameplay/coins-and-cascades.md)
against `rules.coinWeights` — the weights are an ordered array in the genesis, so
every peer rolls the same table.

## Who draws from it, and in what order

Within [one step](the-step.md) the draw order is fixed:

1. player moves (no RNG — moves are data),
2. `runSimBots` — each SimBot seat, in empire then member order, may draw via
   [`policy`](../gameplay/bots.md),
3. `runEvents` — a `SPAWN` draws 4× in `spawnItem` plus 1× in `scheduleSpawn`;
   `UPKEEP` draws nothing.

Map generation ([`mapgen.ts`](../../packages/sim/src/mapgen.ts)) draws heavily
but **only once**, at genesis, before step 0.

## seedFrom

[`seedFrom(text)`](../../packages/sim/src/rng.ts#L54) is FNV-1a over a string to
a stable uint32. Used to turn a room code + timestamp into a genesis seed
([the lobby](../mesh/the-lobby.md)), and to seed a
[PeerBot](../gameplay/bots.md)'s *private* RNG from its seat string so two bots
never decide identically.

## The PeerBot exception

A [PeerBot](../gameplay/bots.md) holds its **own** `Rng`, seeded from its seat,
and must never touch the shared stream — its moves are
[validated, not derived](../moves/validation.md), so a private draw on one peer
and nowhere else would be a desync. Only SimBots draw from `state.rng`.
