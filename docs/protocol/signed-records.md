# Signed records

Every signed payload lives in
[`records.ts`](../../packages/protocol/src/records.ts) and has exactly one byte
encoding. Each carries three properties, and each is load-bearing:

1. **A domain tag** (`"tessera/move/1"`, `"tessera/message/1"`, …) — a signature
   over one record type can never be replayed as another.
2. **The game id** — a record signed in one game cannot be replayed into another,
   including an attacker-generated one.
3. **Fixed-width, little-endian, range-checked fields** — two different records
   cannot encode to the same bytes and share a signature. `*InRange` predicates
   reject out-of-range values *before* the encoder, on both sides.

`preamble(tag, gameId)` ([`records.ts:37`](../../packages/protocol/src/records.ts#L37))
= `utf8(tag) ‖ u16 length ‖ gameId`, prepended to every record body.

Every record has an `encode*` (bytes to sign), a `sign*` / `endorse*` (produce
the signed form), and a `verify*` (check against a [`Roster`](roster.md)). The
verifier **re-derives** the bytes from parsed fields — it never trusts the bytes
that arrived.

## The catalogue

| Record | Tag | Fields | Signed by | Says |
|---|---|---|---|---|
| [`SignedMove`](../moves/move-encoding.md) | `move/1` | `step, empire, member, seq, type, x, y` | the seat | one [move](../moves/the-move-record.md), bound to a step |
| `SignedMessage` | `message/1` | `step, seq, empire, member, channel, body` (`body` ≤ 2048) | the seat | [chat](team-chat.md) — ordered, attributable, **never hashed** |
| `SignedCheckpoint` | `checkpoint/1` | `step, hash, empire, member` | the seat | "at step S my state hashed to H" — [desync detection](../continuity/desync.md) |
| `SignedReady` | `ready/1` | `upTo, empire, member` | the seat | "nothing more from me at or before `upTo`" — cumulative, replaces a `PASS` |
| `SignedDrop` | `drop/1` | `empire, member, atStep` + endorsement list | a majority of all *other* seats | "stop waiting for this seat at exactly `atStep`" — [leaving](../continuity/leaving-and-drops.md) |
| `SignedAmendment` | `amendment/1` | `empire, step, key, kind` + endorsement list | a [quorum](roster.md) of the empire's *existing* seats | "seat this key" — becomes a `ROSTER_AMEND` [move](../continuity/roster-amendments.md) locally |
| `SignedClaim` | `claim/1` | `empire, key, step` | **the key it seats** | "I am taking this empire nobody has claimed" — becomes a `ROSTER_AMEND` [move](../gameplay/empires-and-seats.md) |
| `SignedApplication` | `application/1` | `empire, key, step` | **the key that is asking** | "I would like a seat on this empire" — becomes nothing on its own; a member's agreement turns it into an amendment |
| `EquivocationProof` | — (each half is a `move/1`) | `{ a: SignedMove, b: SignedMove }` | carries two seat signatures | proof one seat signed two moves for one `(empire, member, step, seq)` — [equivocation](../continuity/equivocation.md) |
| handshake | `hello/1` | both nonces (`NONCE_BYTES` = 16) | each side | mutual challenge-response — [joining](../continuity/joining.md) |

## Records that name their own key

Most of the catalogue is signed by *a seat*: attribution runs through
`roster.keyOf(empire, member)`, and the roster is what says which key that is. Two
records cannot work that way, because the whole point of them is that the signer
does not hold a seat yet — so they name their own key and are signed by it.

That makes them verifiable by a peer that has never heard of the signer, which is
exactly the property needed: `verify(record.key, sig, bytes)`, with no roster
lookup in it. It also means the signature establishes *who is asking* and nothing
whatever about whether they may have it. Both records carry the whole of their
authorisation story in one sentence:

- a **claim** needs nobody's agreement, because an empire with no seats has
  nobody to ask — so it seats immediately, and "once only" is enforced against
  the roster by whoever applies it;
- an **application** needs the agreement of the seats already there, so it seats
  nothing by itself and only ever becomes an ordinary amendment.

A claim and an application are the same bytes with a different tag, and that is
what the [domain tag](#the-three-properties) is for: a signature over one can
never be replayed as the other.

## Readiness

[`Ready`](../../packages/protocol/src/records.ts#L257) is what lets the
[lockstep](../continuity/lockstep.md) pipeline advance without a `PASS` per seat
per step — one cumulative signed assertion replaces twelve a second. It is signed
for the same reason a checkpoint is: an unsigned readiness claim would let any
peer assert on another's behalf that it has nothing more to say, and every peer
would then advance past a step whose real input had not arrived — a desync
manufactured by a third party. Asserting readiness through `upTo` and then
submitting a move at or before it is provable equivocation against the signer.

## Endorsement records merge

[`mergeDrop`](../../packages/protocol/src/records.ts#L346) and
[`mergeAmendment`](../../packages/protocol/src/records.ts#L437): endorsements are
a **set** (keyed by seat), so two peers gossiping partial tallies converge
without a coordinator. [`tallyAmendment`](../../packages/protocol/src/records.ts#L460)
reports `{ endorsed, needed }` — a peer acts on a proposal that is not finished
yet (one valid signature tells it the proposal is real and worth holding a step
open for).

## Equivocation, keyed on the step too

[`EquivocationWatch`](../../packages/protocol/src/records.ts#L578) keys on
`empire:member:step:seq`. The `step` **must** be in the key: a `seq` counter
lives in one [lockstep](../continuity/lockstep.md) instance and restarts at 0
when a player reloads, so a returning seat reuses numbers it spent before the
reload. Keyed on `seq` alone that reads as the member contradicting itself, and
an honest rejoin would be answered with an ejection. See
[continuity/equivocation.md](../continuity/equivocation.md).
