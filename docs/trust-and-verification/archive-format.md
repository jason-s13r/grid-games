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
