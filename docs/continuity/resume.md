# Resume

Two situations put a peer behind: it **arrived late** (the game began without
it), or it **rebuilt from a desync / ejection**. Both are answered the same way —
ask for the world, verify it, adopt it.

## Arriving late

[`start()`](../../packages/net/src/lockstep.ts#L336) checks
`targetStep() - sim.step`. If that is more than `RESUME_BEHIND` (**2 s**), the
game began without this peer and the moves that built the real state were
broadcast before it was listening — **nobody will send them again**, so replaying
from step 0 would derive a state that agrees with nobody.

So it sets `holdingForResume`, and [`pump`](lockstep.md) does nothing but wait:

- `RESUME_PATIENCE_MS` (**45 s**) total — long enough to outlast a mesh forming
  slowly (the first request routinely goes out to nobody, because a joiner is
  playing before its channels finish opening), short enough that a peer alone in
  a room eventually starts from the top rather than staring.
- `SNAPSHOT_WAIT_MS` (**10 s**) per request — [`resuming()`](../../packages/net/src/lockstep.ts#L381)
  re-asks when that lapses and there is a peer to ask.
- A host opening a room is behind its own genesis by however long the lobby took;
  it finds nobody to ask, sits out the patience, and starts from the top — which
  is right.

## Rebuilding

Three reasons to rebuild, and they do not all belong to the same party:

- [`eject`](ejection.md) with `late = true` — **the driver's own call**;
- persistent minority [desync](desync.md) — **the client's call**. `Lockstep`
  fires `onDesync`; whoever holds the driver answers it with
  `requestSnapshot()`. Every peer wires this now, but it is wiring rather than
  machinery, and the distinction stayed invisible for as long as browsers were
  the only peers that ever desynced;
- **a cold start from a [resume point](resume-points.md)** — served from a *file*
  by a [host peer](../clients/host-peer.md) rather than from a live driver, because
  a live answer stops existing four minutes after the last player leaves: a point
  needs both the snapshot bytes and the witnesses, snapshots roll forward on every
  peer whether or not anybody is playing, and witnesses only arrive with a
  checkpoint from a seat — a dormant game picked
  — a dormant game picked up from whatever somebody kept. `adopt`'s hash check is a
  content address and not a proof, so a point carries signed checkpoints from a
  majority of the seats that could still sign, and `resume()` runs both halves: the
  tally, then the bytes;
- **a reconnected socket**, also the client's call. The
  [socket transport](../mesh/socket-transport.md) holds our own writes across an
  outage, so nothing of ours is lost — but nothing replays what everybody else
  said while we were away, so `onReconnect` asks for a snapshot. A data channel
  never fires it: it does not reconnect, the peer is simply gone.

## requestSnapshot / onSnapshotRequest

[`requestSnapshot(step)`](../../packages/net/src/lockstep.ts#L1255) broadcasts a
`SNAPSHOT_REQUEST`. The step is **advisory** — a peer rebuilding wants a
*correct* state, not an old one.

[`onSnapshotRequest`](../../packages/net/src/lockstep.ts#L1136) answers the asker
**alone** (a snapshot is the largest message the mesh carries) with:

- `sim.step`, `sim.hash()`, `encodeSnapshot(sim.snapshot())`;
- `applied` — the [amendments](roster-amendments.md) behind that state;
- `enforced` — the [drops](leaving-and-drops.md) behind it;
- then **every pending move** it still holds, one `MOVE` frame each.

The state plus the pending moves are the whole game from that point.

## onSnapshot → catchUpRoster → catchUpDrops → adopt

[`onSnapshot`](../../packages/net/src/lockstep.ts#L1150) ignores a snapshot that
is not ahead of us (unless we asked and are still inside `snapshotWantedUntil`),
then:

1. [`catchUpRoster`](../../packages/net/src/lockstep.ts#L1179) — re-apply each
   amendment **in order**, checking its quorum against the roster *as it stood
   then* (an empire's quorum grows as it does). Anything that does not check out
   stops the walk.
2. [`catchUpDrops`](../../packages/net/src/lockstep.ts#L1204) — adopt each drop,
   re-checking its quorum. Quietly: an ejection changes who a peer waits for, not
   what it computes.
3. [`adopt(buffer, expected)`](../../packages/net/src/lockstep.ts#L1219) —
   **restore it, hash it, and put the old state back if the number disagrees.**

That last line is the whole point: **a snapshot from an untrusted peer is safe to
accept**, because the [hash](../concepts/the-one-invariant.md) is the proof. It
is what lets an [archive peer](../trust-and-verification/archive-format.md) be
useful without being an authority, and what lets a player who closed the tab
three hours ago rejoin from whoever happens to be online.

After a successful adopt, pending moves and seatings for spent steps are cleared,
checkpoint history is dropped, and a fresh checkpoint + readiness go out.

## The same tally answers a second question

A [resume point](resume-points.md)'s witnesses are checked by
`verifyResumePoint(genesis, claim)`, and the claim is a point **with the bytes
taken off** — the function never reads `data`. It rebuilds the roster, subtracts
the verified drops, and counts agreeing signatures.

That is what lets an [address-book row](../mesh/address-book.md) carry a proof of
life in a couple of hundred bytes instead of a snapshot: a majority of a game's
own seats signing *(step, hash)* is a statement only that game's players could
have produced. The bytes answer a different question, and `Lockstep.resume` is
the only thing that asks both, in the only order that is safe.

[`resume.test.ts`](../../packages/net/src/test/resume.test.ts): "wrong hash
refused, state left alone; real one accepted, lands on its step"; "a late peer
resumes without being told"; "an unanswered resume request eventually plays from
the top".
