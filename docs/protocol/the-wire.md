# The wire

[`wire.ts`](../../packages/protocol/src/wire.ts) is the framing — what actually
travels along a data channel.

## JSON, deliberately

Frames are **not signed**, so nothing here needs a canonical encoding, and being
able to read a session in a console is worth more than the bytes it costs. The
signed payloads *inside* a frame are binary and canonical
([signed-records.md](signed-records.md)) and are always rebuilt from parsed
fields before verification — so a frame is untrusted transport and nothing more.

`encodeFrame(frame)` is `JSON.stringify`.
[`decodeFrame(text)`](../../packages/protocol/src/wire.ts#L174) is the only entry
point and **returns `null`** rather than throwing on anything it does not fully
recognise. A peer can send whatever it likes; none of it should raise an
exception on the receiving side. `decodeFrame` checks only *shape* — field-level
checking belongs to the verifier, which re-derives the payload anyway.

## The nineteen frame types

`FRAME` ([`wire.ts:25`](../../packages/protocol/src/wire.ts#L25)). Only `move`
carries a move; the rest are how peers agree about moves, and none can change
state on its own.

| Frame | Carries | Purpose |
|---|---|---|
| `hello` | `protocol`, `gameId`, `key?`, `name?`, `nonce` | opens a connection; `key` is a claim, not yet a fact, and `name` has exactly the same standing — there is no game id to sign either against. An observer sends no key |
| `welcome` | `key?`, `nonce`, `proof?` | the host's side of the handshake |
| `proof` | `proof` | the joiner's signature over both nonces |
| `genesis` | the **full** `Genesis` record | so a joiner computes the game id itself |
| `move` | `SignedMove` | one move, bound to a step |
| `ready` | `SignedReady` | cumulative — a later `ready` supersedes an earlier one |
| `drop` | `SignedDrop` | rebroadcast as it gains endorsements |
| `message` | `SignedMessage` | chat |
| `checkpoint` | `SignedCheckpoint` | a signed state hash |
| `amendment` | `SignedAmendment` | rebroadcast as it gains endorsements |
| `claim` | `SignedClaim` | somebody taking an empire nobody has claimed; one signature, no tally |
| `application` | `SignedApplication` | somebody asking an empire for a seat; **re-sent on a slow timer**, because it never grows and so cannot be gossiped by growth |
| `proposal` | `Proposal`, `rev`, `by` | a world somebody is suggesting. A later `rev` from the same `by` supersedes; a different `by` is a different proposal. `by` is **attribution, not authority** — nothing arbitrates, because a proposal nobody signs dies of that |
| `consent` | `SignedConsent` | one signature over one proposal id. Not a tally: the set of these *is* the roster |
| `name` | `SignedNaming` | what a seat would like to be called; **re-sent on a slow timer**, because a name is persistent UI state and a missed one never repairs itself |
| `equivocation` | `EquivocationProof` | a self-contained proof of cheating |
| `snapshot?` | `step` | a request — the step is advisory |
| `snapshot` | `step`, `hash`, `data` (base64url), `amendments?`, `claims?`, `drops?` | the world at a step |
| `bye` | `reason?` | a peer leaving |

### The one frame whose numbers are checked at the decoder

`decodeFrame` normally checks only that there is *something* to verify, because
field-level checking belongs to the verifier, which re-derives the payload
anyway. `proposal` is the exception: it is the only frame whose contents get
**hashed on arrival**, and `canonicalJson` throws on a non-finite number. Without
a check here that throw sits inside a receive path, reachable by anyone who can
send a frame. So a `proposal` whose `seed`, `startedAt` or `vacancies` is not a
finite non-negative integer decodes to `null` and never reaches the hash.

## Adding a frame is additive, and that is checked in three places

A new member of `FRAME` costs an older build nothing. `decodeFrame` returns
`null` for an unrecognised `t`, and both carriers drop a null frame without
complaint — the mesh ("a peer can send whatever it likes; anything unrecognised
is simply not heard, and never reaches the driver") and the local hub. An old
build never sees the frame, never counts it as a violation, and behaves exactly
as it does today: a mixed mesh degrades to the older feature set rather than
desyncing.

One caveat, because it is easy to over-claim. That graceful degradation only
matters while builds can meet at all, and the lobby's protocol check is a strict
equality — a peer whose `PROTOCOL_VERSION` differs is refused before any frame
is exchanged. So the degradation path exists for builds that share a protocol
number and differ in features, which is exactly the case an additive frame is
for, and not for the window after a version bump.

## The snapshot frame carries more than the snapshot

[`SnapshotFrame`](../../packages/protocol/src/wire.ts#L120) includes the
`amendments` and `drops` behind that state:

- The snapshot carries the **simulation**, which knows members by index and
  nothing about keys. A peer that adopted one across an
  [amendment](../continuity/roster-amendments.md) would hold a state with a seat
  in it and no idea whose key sits there, and would reject that player's every
  move. The `amendments` are the **records themselves**, so the receiver
  re-checks each quorum for itself — the snapshot stays safe to take from anyone.
- The `drops` are not part of the state hash (an
  [ejection](../continuity/ejection.md) changes *who a peer waits for*, not the
  world), but a peer adopting a snapshot without them would sit waiting on a seat
  everyone else stopped waiting for long ago.

`data` is base64url as a placeholder — a binary channel should carry the buffer
raw. See [continuity/resume.md](../continuity/resume.md).
