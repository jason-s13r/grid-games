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

[`eject`](ejection.md) with `late = true`, and persistent majority
[desync](desync.md), both call `requestSnapshot()`.

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

[`resume.test.ts`](../../packages/net/src/test/resume.test.ts): "wrong hash
refused, state left alone; real one accepted, lands on its step"; "a late peer
resumes without being told"; "an unanswered resume request eventually plays from
the top".
