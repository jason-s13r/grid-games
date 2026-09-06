# Leaving and drops

A peer can leave cleanly (`BYE`) or just fall silent. A `BYE` is a courtesy; it
changes nothing on its own. What matters is what happens when a **seat stops
answering** and freezes the game.

## The fix cannot be a local timeout

Two peers whose stopwatches disagree would stop waiting on different steps and
diverge — a desync manufactured to fix a stall. So dropping a seat is a
**decision**, taken by a quorum, recorded once.

## stalling — the proposal timer

When [`blocked`](heartbeats-and-liveness.md) is non-empty, the pump loop calls
[`stalling(waiting)`](../../packages/net/src/lockstep.ts#L808). The wall clock
here decides only **when to propose** — never what to simulate.

`DEFAULT_STALL_TIMEOUT = 15000` ms. Proposals are **staggered by
`proposerRank`** ([`lockstep.ts:828`](../../packages/net/src/lockstep.ts#L828)):
rank 0 (the lowest-ordered eligible seat) proposes after one timeout, rank *n*
after *n+1* — so exactly one peer speaks first, and a proposer that is itself
unreachable delays the drop rather than preventing it. A race between two
proposals naming different steps could otherwise leave both short of a majority
and the game stuck for good. An observer proposes nothing (rank `MAX_SAFE_INTEGER`).

## The Drop record

[`Drop`](../protocol/signed-records.md) = `{ empire, member, atStep }` plus an
endorsement list. `atStep` is **inside the record** — everyone who accepts it
stops waiting for the seat on precisely that step, whether they learned of it a
second or a minute later.

[`consider`](../../packages/net/src/lockstep.ts#L854):

- **Endorse at most one record per seat, ever.** Two records naming different
  steps then cannot both reach a strict majority, so the mesh cannot split over
  when the drop took effect.
- Endorsements merge as a **set** ([`mergeDrop`](../protocol/signed-records.md)),
  so a partial tally gossips without a coordinator; a record that grew is
  rebroadcast.
- [`verifyDrop`](../../packages/protocol/src/records.ts#L356): a **strict
  majority of all keyed seats other than the target**, from any empire — a stall
  costs everyone, not just the stalled seat's team. The seat cannot vote on its
  own removal and cannot block it.

When `verifyDrop` passes, the record goes into `enforced` (sent with a
[snapshot](resume.md)) and [`eject`](ejection.md) runs with the local
`dropReason` (`"stalled"`, or `"desync"` if [checkpoint comparison](desync.md)
recorded one first).

[`stalls.test.ts`](../../packages/net/src/test/stalls.test.ts): "the table stops
rather than guessing", "every peer drops the seat for the same reason on exactly
the same step", "nobody rebuilds", "the game resumes".
