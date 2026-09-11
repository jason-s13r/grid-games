# The protocol

[`packages/protocol`](../../packages/protocol) is **everything a peer can say
that another peer must believe.** It depends on `sim` (for the `Move` type and
the constants) and on nothing else.

| Page | Covers |
|---|---|
| [identity.md](identity.md) | The ECDSA P-256 keypair — the public key *is* the member |
| [genesis.md](genesis.md) | The root of trust; its hash is the game id; `inspectGenesis` |
| [roster.md](roster.md) | Which key sits in which seat; quorum math |
| [signed-records.md](signed-records.md) | The three properties every record carries; the record catalogue |
| [the-wire.md](the-wire.md) | JSON framing; the fourteen frame types; `decodeFrame` returns null |
| [team-chat.md](team-chat.md) | Per-message ECDH fanout; why archived team channels stay sealed |

## The one rule

A signature is **always verified over bytes rebuilt from parsed fields**, never
over the bytes that arrived. Every `encode*` function
([`records.ts`](../../packages/protocol/src/records.ts)) is used identically by
the signer and the verifier. This prevents smuggling data that the signature
covers but the parser ignores. [`bytes.ts`](../../packages/protocol/src/bytes.ts)'s
`Writer` declares its exact size up front and `finish()` throws on a short or
long write.

## Versioning

There is no separate "protocol version" number in this package. It re-exports
[`PROTOCOL_VERSION`](../concepts/the-one-invariant.md) from `sim` — the version
this build stamps, bumped whenever a change moves the
[state hash](../concepts/the-one-invariant.md) — alongside
`SUPPORTED_PROTOCOLS`, the set it will play. `Genesis.protocol` carries the
game's version, and `HelloFrame.protocol` carries the version *at stake* (the
game's once one exists) with `HelloFrame.supported` listing the sender's whole
set. An older build sends no set, and is read as playing exactly what it stamps.
Record domain tags are versioned inline (`tessera/move/1`, `tessera/message/1`,
…).
