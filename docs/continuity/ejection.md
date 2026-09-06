# Ejection

[`eject(seat, atStep, reason)`](../../packages/net/src/lockstep.ts#L1099) is the
common endpoint of every "stop dealing with this seat" path:
[a drop](leaving-and-drops.md) (`"stalled"` or `"desync"`) and
[equivocation](equivocation.md) (`"equivocation"`).

`EjectionReason = "equivocation" | "stalled" | "desync"`.

## What it does

From `atStep` onward, permanently:

- `ejected[seat] = atStep` — [`blocked`](heartbeats-and-liveness.md) stops
  waiting on the seat for any step `>= atStep`;
- [`onMove`](../../packages/net/src/lockstep.ts#L659) drops any further move from
  the seat for a step `>= atStep`;
- pending moves from the seat for steps `>= atStep` are removed;
- `onEjection(seat, atStep, reason, late)` fires.

The seat is **out for the rest of the game**. A returning player is seated again
by [`ROSTER_AMEND`](roster-amendments.md) at a **fresh index** — "resume waiting
for them once they are back" would depend on when each peer noticed, which is
exactly the local judgement this design keeps out of the log.

## `late` and the rebuild

`late = sim.step > atStep` — this peer has already applied moves its peers are
about to drop. That is a divergence, and the honest response is to
[rebuild from a snapshot](resume.md) rather than carry on and hope, so
`eject` calls `requestSnapshot()`. `sim.step === atStep` is not yet a problem —
only a step already applied can have been applied wrongly.

## Why it is not hashed

An ejection changes **who a peer waits for**, not what the world looks like. The
simulation runs the seat's already-valid moves regardless. That is why:

- an ejection / drop is **not** in the [snapshot](../simulation/snapshot-and-hash.md)
  — but the [`SnapshotFrame`](../protocol/the-wire.md) carries the `drops`
  records anyway, so an adopting peer does not sit waiting on a seat everyone
  else stopped waiting for;
- a [`ROSTER_AMEND`](roster-amendments.md) *is* hashed — it appends a member,
  which changes the state bytes.

See [what-is-hashed.md](what-is-hashed.md).
