# The roster

[`Roster`](../../packages/protocol/src/roster.ts#L25) maps a seat
`(empire, member)` to a public key. A [signed move](signed-records.md) carries
`(empire, member)` and **no key** — the roster says which key sits there.

If the key travelled inside the move, a verifier would have to decide whether to
trust it, and "signature valid for the key it names" proves nothing at all.
Looking the key up by seat means a valid signature is automatically a signature
*from the seat's holder*.

## Seat

```ts
interface Seat {
  empire: number;
  member: number;
  key: MemberKey;
  kind: MemberKind;   // HUMAN or BOT
  joinedAt: number;   // step the seat was added; 0 for a genesis seat
}
```

## From the genesis

[`Roster.fromGenesis(genesis)`](../../packages/protocol/src/roster.ts#L32) walks
the empire specs. A seat with **no key is a SimBot's** and gets no roster entry —
which is why nothing can be voted into a SimBot empire (a
[quorum](#quorum) of keyed seats endorses an amendment, and a SimBot empire has
none).

## The API

| Method | Returns |
|---|---|
| `keyOf(empire, member)` | the key at that seat, or `undefined` |
| `seatOf(key)` | the seat a key holds, or `undefined` |
| `size(empire)` | total seats (keyed + SimBot) |
| `membersOf(empire)` | keyed seats, **member-index order** — the signers a quorum is counted against |
| `quorum(empire)` | `floor(membersOf.length / 2) + 1` |
| `amend(empire, key, kind, step)` | append a seat, return its member index |
| `has(key)` | is this key seated anywhere |
| `all()` | every keyed seat in the game |

## Quorum

`floor(n / 2) + 1` of an empire's **keyed** seats. A single-member empire is its
own quorum — which is what lets a solo player recruit a first teammate by
[`ROSTER_AMEND`](../continuity/roster-amendments.md).

A [drop](../continuity/leaving-and-drops.md) needs a different electorate: a
strict majority of **all keyed seats other than the target**, from any empire — a
stall costs everyone, not just the stalled seat's team
([`verifyDrop`, records.ts:356](../../packages/protocol/src/records.ts#L356)).

## Mutable, in log order

The roster is mutable because [`ROSTER_AMEND`](../continuity/roster-amendments.md)
is: a substitute joining on day three is a normal part of a marathon game. Every
peer applies amendments in **log order**, so every peer's roster is identical at
the same step. [`amend`](../../packages/protocol/src/roster.ts#L90) mirrors what
[`applyMove`](../moves/the-eleven-types.md) does to the sim — the sim pushes a
`Member`, the roster pushes the key that authorises it, and the returned index is
the one the `ROSTER_AMEND` move must produce.
