# Genesis

The genesis record is the **root of trust**, and its SHA-256 hash is the
**game id**. [`Genesis`](../../packages/sim/src/types.ts#L225):

```ts
interface Genesis {
  protocol: number;      // PROTOCOL_VERSION at seal time; fixed for the game's life
  gameId?: string;       // the hash, stamped on by sealGenesis
  seed: number;          // drives map generation and the RNG
  startedAt: number;     // epoch ms — the origin for targetStep
  map: MapConfig;        // size and terrain counts
  rules: Rules;          // the whole balance sheet
  empires: EmpireSpec[]; // composition: control, seats, keys, bot profiles
}
```

Everything a peer needs to build a bit-identical `Sim` and roster.

## canonicalJson

[`canonicalJson(value)`](../../packages/protocol/src/genesis.ts#L16): deterministic
JSON — object keys in code-unit order, arrays in place, `undefined` dropped,
numbers via `JSON.stringify` (JS's spec-exact shortest round-trip form), non-finite
refused. Two peers must derive **byte-identical** bytes from the same record or
they derive different game ids and never meet, so `JSON.stringify`'s
insertion-order output is not good enough.

## gameIdOf and sealGenesis

[`gameIdOf(genesis)`](../../packages/protocol/src/genesis.ts#L41) hashes the
record **with its own `gameId` field removed** — a hash cannot contain itself,
and a peer must be able to recompute the id from what it received.
[`sealGenesis`](../../packages/protocol/src/genesis.ts#L48) stamps the id onto a
copy; that sealed record is what peers exchange and what every signature is
[bound to](signed-records.md).

The [`GenesisFrame`](the-wire.md) carries the full record, so a joiner computes
the id itself rather than taking the host's word for it.

## inspectGenesis — everything a peer checks before playing

[`inspectGenesis(genesis)`](../../packages/protocol/src/genesis.ts#L65) returns a
list of `GenesisProblem`s; empty means "this build can join this game".

| Problem | Cause |
|---|---|
| `protocol` | `genesis.protocol` is not in `SUPPORTED_PROTOCOLS` — **the important one.** A peer that joins a game whose rules it does not have does not fail, it desyncs quietly three hours in. The check is membership, not equality, so a game survives the release that supersedes it |
| `gameId` | present but does not match the recomputed hash — tampered |
| `empires` | fewer than 1, or more than 255 (empire ids are single bytes) |
| `members` | an empire with fewer than 1 seat |
| `seats` | an empire with more than `min(maxSeats, SEAT_CEILING)` seats |
| `duplicate-key` | one key in two seats (unkeyed SimBot seats are skipped) |

The seat cap is checked **here as well as** on every
[amendment](../continuity/roster-amendments.md), because a genesis is the one
place an empire could be *born* oversized — and a peer that only checked
amendments would join the unfair game and then faithfully enforce fairness for
the rest of it.

## Building one

[`makeGenesis(init)`](../../packages/sim/src/sim.ts#L36) fills `DEFAULT_MAP` /
`DEFAULT_RULES` and stamps `PROTOCOL_VERSION`. [`humans(n)`](../gameplay/difficulty-and-balance.md)
and [`simbot(level)`](../gameplay/bots.md) are the `EmpireSpec` shorthands. The
[lobby](../mesh/the-lobby.md) is what assembles and seals one in a real game.
