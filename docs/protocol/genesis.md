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
  empires: EmpireSpec[]; // composition: control, seats, keys, bot profiles, banner
  consent?: SignedConsent[]; // who agreed to this world, before it was a game
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
| `rules` | `abandonWindow` below `MIN_ABANDON_WINDOW` (3 h), or a negative `joinWindow`/`endStep`. The abandonment window is the one rule a host could set to win outright — short enough and every opponent is "absent" before anyone moves |
| `duplicate-key` | one key in two seats (unkeyed SimBot seats are skipped) |
| `duplicate-banner` | two empires flying one house, a banner that is not in the table, or one written as `null` rather than omitted |
| `consent` | the record carries a consent list and it does not check out. **Absent is not a problem** — a record that claims nothing fails nothing, which is what keeps every archive written before consent existed green |

The seat cap is checked **here as well as** on every
[amendment](../continuity/roster-amendments.md), because a genesis is the one
place an empire could be *born* oversized — and a peer that only checked
amendments would join the unfair game and then faithfully enforce fairness for
the rest of it.

## banner, and why the id is stored and never the name

`EmpireSpec.banner` is an id the simulation never reads — the same standing as
`MemberSpec.key`. It rides here because every peer must present the same board,
not because anything computes with it.

**The name would fork history.** Anything in the genesis is hashed into the game
id forever, so the string "Vermilion" in a record means old archives say
Vermilion after the house is renamed and new games say something else, and the
two stop being comparable. The id makes a rename a one-line table edit that every
archive picks up on its next replay.

**It must be omitted, never `null`.** `canonicalJson` drops `undefined` and keeps
`null`, so the two spellings of "no banner" would hash to different game ids
while meaning exactly the same thing. `inspectGenesis` refuses the second.

**An additive genesis field costs an old build nothing**, and the mechanical
reason is worth stating: `canonicalJson` walks whatever object it is handed and
sorts the keys it finds. It has no schema. So an older build handed a record
carrying `banner` serialises the field it has never heard of, hashes it, and
computes the *same game id* — it does not skip it and it does not choke. That
would cost everything in a format encoding a fixed field list.

## consent, and why hashing it in is not circular

A [co-signed genesis](../mesh/the-lobby.md) carries the signatures that composed
it. `gameIdOf` strips only `gameId`, so the consent list is hashed into the game
id like everything else — which is what stops a sealer adding, removing or
reordering one after the fact.

Verification is a **recomposition**, and it has to be. The obvious sketch —
strip `gameId` and `consent`, rehash the residue, check each signature against
it — cannot work, for the design's own reason: what remains still contains
`empires`, which is *derived from* the consent set and is exactly the field a
proposal is built not to contain. Hashing the residue hashes the roster, and the
deadlock the world/roster split exists to avoid comes back in the verifier.

So `checkConsent`:

1. `proposalOf(genesis)` reconstructs the world — seed, start instant, map,
   rules, bot profiles, vacancy count — by reading the roster's fixed layout
   backwards: **signers in key order, then vacancies, then SimBots**. That order
   is part of the format, not a convenience. A record it cannot have produced
   returns `undefined`.
2. Every consent is verified against `proposalId(proposal)`.
3. `composeGenesis(proposal, consents)` rebuilds the whole record, and the two
   are compared as canonical JSON.

One comparison subsumes the entire list of things a sealer must not be able to
do, and none of them needs its own branch. It is the discipline `SnapshotFrame`
already uses: restore it, hash it, discard it if the number disagrees.

The verdict is three-valued — `checked`, `absent`, `failed` — and never a
boolean. An unverified consent list is worse than none because it looks like
proof, and a reader told *these four keys signed this world* / *this record never
said* / *it says so and it does not check out* cannot mistake one for another.

**No protocol bump.** An old build hashes an unknown `consent` field into the
same game id and computes identical state; it simply does not check it, which is
what it does today. That is a security property degrading, not a divergence.

## Building one

[`makeGenesis(init)`](../../packages/sim/src/sim.ts#L36) fills `DEFAULT_MAP` /
`DEFAULT_RULES` and stamps `PROTOCOL_VERSION`. [`humans(n)`](../gameplay/difficulty-and-balance.md)
and [`simbot(level)`](../gameplay/bots.md) are the `EmpireSpec` shorthands. The
[lobby](../mesh/the-lobby.md) is what assembles and seals one in a real game.
