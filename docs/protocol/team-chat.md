# Team chat

Chat is two channels — `CHANNEL.PUBLIC` (0) and `CHANNEL.TEAM` (1). Both are
[`SignedMessage`](signed-records.md) records: ordered, signed, attributable, and
**never hashed into state**. That is the whole reason chat is safe — a message
that arrives late, out of order, or not at all can never
[desync](../continuity/desync.md) a game.
[`chat.test.ts`](../../packages/net/src/test/chat.test.ts) proves it by dropping
every message on one peer and checking the hash is unchanged.

Public messages are plaintext in `body` (≤ 2048 chars). Team messages are
base64url AES-GCM ciphertext, produced by
[`sealTeamBody`](../../packages/protocol/src/secrets.ts#L99).

## Per-message fanout, not a group key

The mesh broadcasts everything, so privacy has to be cryptographic rather than a
matter of addressing. An opponent, an observer and an
[archive peer](../trust-and-verification/archive-format.md) all receive every
team message and store it; what separates a teammate is only whether the bytes
open.

[`sealTeamBody`](../../packages/protocol/src/secrets.ts#L99):

1. a **random content key** (32 bytes) encrypts the text (AES-GCM);
2. that key is **wrapped once per teammate**, using a secret from ECDH between
   the sender's keypair and that teammate's —
   [the same keypairs](identity.md) the roster names everyone by;
3. the wrapped keys travel with the message, each tagged with its recipient's
   member index so a reader finds its own without trial-decrypting every one.

The ECDH output is never used raw: it goes through **HKDF** salted with the
`gameId` and `info`-tagged `tessera/team/1:${empire}`
([`secrets.ts:56`](../../packages/protocol/src/secrets.ts#L56)). Two members on
two empires in two games share four unrelated keys.

Cost: N teammates cost N−1 wraps of 60 bytes — nothing at the size a team is. The
honest trade is that **there is no single team key to publish at the end**, so an
[archived team channel stays sealed](../trust-and-verification/archive-format.md).

## What it does not hide

**Who is talking.** A team message is signed and attributable like every other
record, so an opponent sees that "empire 2's second seat said something at step
200". Only the words are private.

## Opening

[`openTeamBody`](../../packages/protocol/src/secrets.ts#L143) returns the text or
**`null`** — and null covers everything: another empire's traffic, a seat with no
wrap for you, a truncated body, a forged one. Receiving mail you cannot open is
the normal case, not an error. `sealTeamBody` with an empty recipient list is
legal and produces a message only the sender could read — the right answer for a
team of one.
