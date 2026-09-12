# Desync

A desync is two peers reaching **different [hashes](../concepts/the-one-invariant.md)**
for the same step. It is detected by comparing signed checkpoints, and the
response is deliberately lopsided.

## Detection: checkpoints

Every `checkpointInterval` (**5 s**, 60 steps),
[`checkpoint`](../../packages/net/src/lockstep.ts#L584) records this peer's own
hash in `ourHashes` and broadcasts a signed
[`Checkpoint`](../protocol/signed-records.md) `{ step, hash, empire, member }`.
Incoming checkpoints land in `claims[step]` keyed by seat.

[`compare(step)`](../../packages/net/src/lockstep.ts#L735) runs whenever either
half arrives for a step this peer also has a hash for.

## Escalation: symmetric detection, asymmetric response

```
agreeing = 1 (ourselves)
for each peer's hash at this step: if it equals ours, agreeing++
weAreTheMajority = agreeing * 2 > claims.size + 1
```

- **Every** disagreement fires `onDesync(step, ours, theirs, seat)` and bumps
  `desyncs` — detection is symmetric.
- Only a **majority** peer acts on it. A peer that disagrees with everybody is
  far likelier to be the broken one than everybody is, and a minority peer that
  started accusing would be accusing the honest majority. **So the minority
  rebuilds and says nothing** — the [client](../clients/web-client.md) shows
  "State disagreement… rebuilding from a checkpoint" and calls
  [`requestSnapshot`](resume.md).

**Which peer rebuilds is the peer's own business.** `Lockstep` does not call
`requestSnapshot` on a desync of its own accord; whoever holds the driver wires
`onDesync` to it. Every peer now does — the web client always did, and
[headless peers](../clients/headless-peers.md) do since the socket transport
landed. Before that a headless seat never repaired and was dropped on schedule,
and a headless *observer* never repaired **and was never dropped**: it holds no
seat, so it broadcasts no checkpoints, so nothing could see that it disagreed. It
kept archiving a game that did not happen, and because the archive is
self-consistent, verifying it returned VERIFIED.

## The majority's clock

A majority peer records each disagreeing step in `disagreements[seat]`, cleared
the moment that seat agrees again (**a seat that rebuilt is not a cheat**). When
`disagreements.size >= desyncTolerance (3) + proposerRank(seat)` it
[`propose`](leaving-and-drops.md)s a `Drop` with `reason = "desync"`.

The `proposerRank` stagger is the same one [stalls](leaving-and-drops.md) use and
for the same reason: two proposals naming different steps could each fall short
of a majority and leave the seat neither dropped nor trusted. Whoever speaks
first is endorsed by the rest; a peer that has endorsed a drop never proposes its
own.

Three checkpoints ≈ 20 s of *persistent* disagreement — two chances to recover:
the first checkpoint tells the drifted peer something is wrong, and a rebuild
from a checkpoint lands well inside the second.

## A late amendment is also a desync

[`considerAmendment`](../../packages/net/src/lockstep.ts#L953): if a *carried*
amendment arrives dated at or before the current step, peers who applied it are
ahead in a way no further move reconciles — so `desyncs++` and
[`requestSnapshot`](resume.md).

[`desync.test.ts`](../../packages/net/src/test/desync.test.ts): "a divergent peer
is noticed by the honest majority *and* by itself"; "the drifted peer never
accuses anybody"; "a peer that won't come back is dropped by the majority".
