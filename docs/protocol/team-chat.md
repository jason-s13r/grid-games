# Team chat and direct messages

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

## The leading byte is a scheme, not a generation

Two constructions coexist forever, and the byte says which sealed the envelope:

| Byte | Scheme | Derivation | Wrap | Wraps |
|---|---|---|---|---|
| 1 | team | game id + `tessera/team/1:${empire}` | member, nonce, wrapped key | one per teammate |
| 2 | direct | game id + `tessera/direct/1:` + **both keys, sorted** | nonce, wrapped key | **always two** |

**Why not simply bump the version to 2.** A single `VERSION` constant moved to 2
would make every *team* message start sealing under the pair derivation too —
which silently deletes the empire binding above, makes a team message between
two people identical in key material to a DM between the same two, and would
have been caught by nothing in the suite. So the layout constants are functions
of the byte rather than constants, and both values stay valid forever.

That is also why **no version number in the tree moved for direct messages**.
`PROTOCOL_VERSION`, `LAYOUT_VERSION` and `ARCHIVE_FORMAT` are all untouched:
`channel` is a `u8` in the signed bytes, `messageInRange` already accepts the
whole range, and a `channel: 2` message verifies exactly like any other — which
is the artefact that would otherwise have forced a format move, since
`verifyArchive` runs `verifyMessage` over archived chat.

## A direct message

`sealDirectBody(identity, gameId, recipient, text)`. The recipient is **not a
field** — not in the `Message` record and not in the wrap — because the envelope
already carries it, wrapped. The derivation sorts the two member keys so both
ends compute the same label over the same ECDH bits without agreeing on anything
first.

**Always exactly two wraps**, the recipient's and the sender's. Two things fall
out, and the second is why it is worth 60 bytes:

- **The sender can read its own half.** Everywhere else in this file the
  recipient list excludes the sender, and live the UI papers over it by showing
  what was typed — but on reload, on resume and in every archive, a two-person
  conversation with every other line blank reads as broken rather than as
  private.
- **The envelope shape is constant.** Every v2 envelope is the same length for
  the same plaintext whoever it is for, which is a stronger indistinguishability
  property than one wrap gives.

The sender's own wrap derives under the same pair rule with both keys being
theirs, so it needs no special case anywhere.

**Trial decryption is one derivation, not a search.** ECDH is symmetric, so
against a given sender a reader can derive exactly one wrapping key; both wraps
are tried against it and whichever verifies is ours. What the cost analysis has
to say is *who pays*: a team message costs ECDH only to the empire it addresses,
while **a DM has no empire to filter on, so every peer attempts every DM in the
game** — including ones between two opponents. That lands on the serial
verification lane, so derived keys are memoised by pair, game and scheme, and a
DM costs one AES-GCM attempt after the first.

## What it does not hide

**Who is talking.** A team message is signed and attributable like every other
record, so an opponent sees that "empire 2's second seat said something at step
200". Only the words are private. For a direct message the honest sentence is:
**it hides the words and the recipient; it does not hide that you spoke.**

Two clauses that belong with it, because a DM is the message people will assume
is safer than it is:

**It does not survive a key compromise, retroactively.** The construction is
static-static ECDH with no ephemeral component and no ratchet, so the wrapping
key between two members is a deterministic function of two long-term keypairs.
Anyone who later obtains either private key can open every message either party
ever sent or received to the other, from any archive, forever. Team chat has the
same property and it matters less there, because nobody believes a message to
four teammates is a secret.

**A DM reaches seats only.** There is no key directory outside the roster, so an
observer — somebody asking for a seat, somebody just watching — cannot be
written to. That falls on exactly the people most likely to want a private word,
and it is a known cost rather than an oversight: a directory is its own design.

**Refusing them is local, and only local.** The chat panel already holds a mute
set and argues the case — a decision about what this reader wants to see needs no
agreement, no log entry and no record type. Rejecting DMs is the same decision
with a channel filter on it. There is no blocked record, no notification to the
sender, and no way for two peers to disagree about state as a result. A sender
whose messages are being discarded learns that the way people always have.

## Opening

[`openTeamBody`](../../packages/protocol/src/secrets.ts#L143) returns the text or
**`null`** — and null covers everything: another empire's traffic, a seat with no
wrap for you, a truncated body, a forged one. Receiving mail you cannot open is
the normal case, not an error. `sealTeamBody` with an empty recipient list is
legal and produces a message only the sender could read — the right answer for a
team of one.
