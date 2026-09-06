# Game continuity

How a game that runs for days survives people coming and going, networks
faltering, and the occasional cheat — without ever consulting a wall clock as a
consensus input or trusting a peer it does not have to.

The engine is [`Lockstep`](../../packages/net/src/lockstep.ts), the largest file
in the repository. Everything in this folder is that file or a path through it.

| Page | Covers |
|---|---|
| [lockstep.md](lockstep.md) | The three rules; readiness; `inputDelay`; the pump loop |
| [heartbeats-and-liveness.md](heartbeats-and-liveness.md) | Presence from the log, never from sockets |
| [joining.md](joining.md) | The handshake, getting the genesis, taking a seat |
| [leaving-and-drops.md](leaving-and-drops.md) | A silent seat, the stall timeout, the quorum `Drop` |
| [resume.md](resume.md) | Arriving late or rebuilding: the snapshot request and `adopt` |
| [desync.md](desync.md) | Checkpoint comparison; symmetric detection, asymmetric escalation |
| [equivocation.md](equivocation.md) | Two signatures, one slot; the self-contained proof |
| [roster-amendments.md](roster-amendments.md) | Seating a substitute or a bot mid-game |
| [ejection.md](ejection.md) | What `eject` does, and why it is not in the hash |
| [the-life-of-a-move.md](the-life-of-a-move.md) | One click, end to end across every layer |
| [what-is-hashed.md](what-is-hashed.md) | The full in / out table, and the reasoning |

## The recovery paths at a glance

Every one is decided by a **record**, not a stopwatch — so every peer acts on the
same step, whether it learned of the record a second or a minute later.

| Failure | Detected by | Resolved by | Page |
|---|---|---|---|
| Silent seat | wall clock (**proposal only**) | quorum-signed `Drop` naming an exact step | [leaving-and-drops.md](leaving-and-drops.md) |
| Desync | checkpoint hash comparison | minority rebuilds from a snapshot; persistent disagreement is proposed for a drop | [desync.md](desync.md) |
| Equivocation | two valid signatures on one `(empire, member, step, seq)` | ejection at `max(step) + EJECTION_DELAY`, derived from the proof | [equivocation.md](equivocation.md) |
| Arriving late | `targetStep() - sim.step` at `start()` | snapshot request, then replay | [resume.md](resume.md) |

**Detection is symmetric; escalation is not.** A peer that disagrees with
everybody is likelier to be the broken one than everybody is, so a minority
rebuilds and says nothing.
