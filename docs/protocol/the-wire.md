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

## The fourteen frame types

`FRAME` ([`wire.ts:25`](../../packages/protocol/src/wire.ts#L25)). Only `move`
carries a move; the rest are how peers agree about moves, and none can change
state on its own.

| Frame | Carries | Purpose |
|---|---|---|
| `hello` | `protocol`, `gameId`, `key?`, `nonce` | opens a connection; `key` is a claim, not yet a fact. An observer sends none |
| `welcome` | `key?`, `nonce`, `proof?` | the host's side of the handshake |
| `proof` | `proof` | the joiner's signature over both nonces |
| `genesis` | the **full** `Genesis` record | so a joiner computes the game id itself |
| `move` | `SignedMove` | one move, bound to a step |
| `ready` | `SignedReady` | cumulative — a later `ready` supersedes an earlier one |
| `drop` | `SignedDrop` | rebroadcast as it gains endorsements |
| `message` | `SignedMessage` | chat |
| `checkpoint` | `SignedCheckpoint` | a signed state hash |
| `amendment` | `SignedAmendment` | rebroadcast as it gains endorsements |
| `equivocation` | `EquivocationProof` | a self-contained proof of cheating |
| `snapshot?` | `step` | a request — the step is advisory |
| `snapshot` | `step`, `hash`, `data` (base64url), `amendments?`, `drops?` | the world at a step |
| `bye` | `reason?` | a peer leaving |

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
