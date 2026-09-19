# The archive format

An archive is a game written down in the exact shape `pnpm replay --log` has read
since the beginning — so an archived game is checked by the tool that has been
guarding [determinism](../simulation/determinism-discipline.md) all along, not by
something written for the occasion.

## ArchivedGame

[`ArchivedGame`](../../packages/net/src/archive.ts#L35):

```ts
interface ArchivedGame {
  format: number;                       // ARCHIVE_FORMAT = 1
  genesis: Genesis;
  moveLog: Array<SignedMove | Move>;     // signed in envelopes; bare = synthesised ROSTER_AMEND
  amendments: SignedAmendment[];
  messages: SignedMessage[];             // team lines stay ciphertext, as they crossed the wire
  steps: number;                         // the world step reached — NOT the last move's step
  hash: string;
  from?: number;                         // where a partial log starts; 0/absent = watched from genesis
  gaps?: number[];                       // steps the log jumps at, because a state was adopted
}
```

- **Signatures are kept, not stripped.** A log without them is a claim; a log
  with them can be handed to a stranger who [rebuilds the roster](verifying-an-archive.md)
  and checks every move.
- **Bare `ROSTER_AMEND` moves are not an omission** — that move is synthesised
  locally from an endorsed [amendment](../continuity/roster-amendments.md), so
  its authority is in `amendments`, not a signature of its own. Replay does not
  care; verification does, which is why both are present.
- **`steps` ≠ the last move's step.** A game whose players stopped clicking an
  hour ago has gone on spawning coins and decaying territory since.
- **`from` marks a fragment.** A peer that joined an hour in holds a partial log,
  and saying so is the difference between an honest partial archive and a hash
  mismatch nobody can account for.

## The Archive class

[`Archive`](../../packages/net/src/archive.ts#L88) `attach`es to a
[`Lockstep`](../continuity/lockstep.md), **chaining** onto `onApplied`,
`onMessage` and `onAmended` rather than replacing them (the client sets
`onMessage` for its chat panel). `ArchiveOptions.retain` is `true` for a browser
tab (which offers the log as a **Save log** download) and `false` for a peer
writing a file — there the records go to `onRecord` and the file is the archive.
`ArchiveRecord` is `{ k: "move" | "amend" | "chat", ... }`.

## On disk — the directory is the archive

Written by [`FileArchive`](../../packages/headless/src/store.ts#L61), one
directory per game named by `genesis.gameId`:

```
<gameId>/
  genesis.json    one line: the full Genesis record every hash derives from
  log.jsonl       append-only, one JSON ArchiveRecord per line, flushed as it happens:
                    {"k":"move","entry":{"move":{...},"sig":"..."}}
                    {"k":"move","entry":{...bare move...}}      (synthesised ROSTER_AMEND)
                    {"k":"amend","amendment":{...SignedAmendment...}}
                    {"k":"chat","message":{...SignedMessage...}}
  head.json       rewritten atomically (tmp + rename) every ~10 s — the one "fact about now":
                    { format, gameId, from, steps, hash, updatedAt }
  snapshots/
    0000001440.b738a6c4.snap    zero-padded step "." hex(hash) ".snap"
```

- **Append-only**, because the alternative is rewriting a multi-day log every
  time somebody claims a tile. Appends are serialised through a promise queue so
  two flushes cannot splice their lines together.
- `from` is set on the **first record**, not at construction — a peer does not
  know it arrived late until it sees which step it is first asked to archive.
- [`readArchive(dir)`](../../packages/headless/src/store.ts#L179) drops a
  half-written final line (what a crash leaves) and skips unparseable ones, then
  hands the result to [`verifyArchive`](verifying-an-archive.md).
- `tessera-observe export <dir>` writes the same `ArchivedGame` as one JSON file.

## Sealed team channels

Team chat is [per-message ECDH fanout](../protocol/team-chat.md) with no group
key, so there is nothing to publish afterwards — an archived team channel stays
ciphertext forever. A deliberate trade, not an unbuilt feature.

## Every direct message ever sent is in here, unreadable

`messages` holds every `SignedMessage` exactly as it crossed the wire, which
now includes `channel: 2`. The archive therefore contains every private word
anybody exchanged during the game, sealed, permanently — and permanently is
the right word, because the construction is static-static ECDH with no
ephemeral component: anyone who later obtains either party's private key can
open their whole conversation out of any copy of this file.

Nothing about the format changed to allow it. `channel` is a `u8` in the signed
bytes and `messageInRange` accepts the whole range, so a direct message
verifies exactly like any other and `ARCHIVE_FORMAT` did not move.

## from, and gaps

`from` is **where this peer started watching**, not the step of its first record: a
game where nobody clicks for the first few steps has no records for them, and a
complete log of a quiet opening is still complete. (It used to be the first
record's step, which made almost every real archive claim to be a fragment and be
refused — and the [leaderboard](leaderboard.md) counted almost nothing.)

`gaps` are the steps where the log jumps because the peer **adopted a state** rather
than simulating into it, which leaves inputs it never saw. `from` moves to the last
such step, so every reader refuses the archive correctly — including one written
before `gaps` existed, which is why this needed no format bump. `gaps` only says
*where* the hole is.

This matters more than it used to: asking for a snapshot is now the ordinary
response to a [reconnected socket](../mesh/socket-transport.md), and a
[host peer](../clients/host-peer.md) runs for days across every blink there is. A
host that has adopted once holds a fragment and says so — which is why running two
is redundancy for replayability and not only for the door.

## Kept somewhere other than where it was written

An archive lives wherever the process that wrote it happens to be, which is not a
place anyone else can fetch it from a week later. The
[archive store](../clients/api-service.md#the-archive-store) is one place that
holds them, and it is worth reading as an application of this page rather than an
extension of it.

**The content address is the key.** `genesis.gameId` is a SHA-256 over the
canonical record, so a store cannot hold two different files under one id without
one of them failing verification, and a second upload of a game it already has is
a no-op rather than a duplicate. The store recomputes that id and never takes the
`gameId` field as posted.

**It stores what passes and publishes what does not.** Uploading is open to
anyone, because nothing about who sent a file changes what the file proves: the
store runs `verifyArchive` — the same check on this page, and the same one a
reader runs — and keeps only what survives it. A refusal keeps its `problems` and
throws the file away, and the refusal is listed, because a store that hid what it
could not check would be making the same mistake a leaderboard makes when it
drops a row silently.

**Bytes in, bytes out.** An archive served back is the file that was posted: not
re-serialised, not key-sorted, not stripped of fields the store does not
recognise. The `hash` here is over the replay rather than over the JSON, so
re-serialising would not break verification — which is exactly why the discipline
has to be stated rather than left to an implementation.

**It promises nothing about completeness.** Nothing makes a peer upload, and
nothing notices a game that ended and was never archived. A store's corpus is
over what was sent to it, and it holds only the most recent `--keep` files —
every game keeps its row, which is a few hundred bytes, and loses its megabytes.
