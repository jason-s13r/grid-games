# Events, not ticks

The world runs on [wall-clock time](../concepts/time-and-steps.md), so a peer
returning after six hours has ~260,000 steps to cover. If every step swept the
map — checking every tile for a coin spawn or a decay — that catch-up would take
a minute. So the map is **not** swept per step. World updates are scheduled
events on a heap, and empty steps cost nothing.

## The heap

[`EventQueue`](../../packages/sim/src/events.ts#L24) is a binary min-heap of
`ScheduledEvent { step, seq, type, payload }`, ordered by `(step, seq)` with a
**monotonic** `seq` ([`events.ts:21`](../../packages/sim/src/events.ts#L21)).

That `seq` matters: `(step, seq)` is a *total* order, so two events due on the
same step can never be tie-broken differently on two peers. A heap alone does not
give a stable order among equal keys; the monotonic sequence number does.

| Method | Does |
|---|---|
| `push(step, type, payload)` | insert, assigning the next `seq` |
| `poll(step)` | pop the next event due at or before `step`, else `null` |
| `nextStep` | step of the next pending event, or `Infinity` — lets `fastForward` skip ahead |
| `toSorted()` | canonical order for [serialisation](snapshot-and-hash.md) |
| `load(events)` | rebuild from an already-sorted list, **preserving each event's `seq`** |

`load` preserves `seq` deliberately ([`events.ts:81`](../../packages/sim/src/events.ts#L81)):
reassigning sequence numbers on restore would change the state hash without
changing behaviour.

## The two event types

`EVENT = { SPAWN: 0, UPKEEP: 1 }` ([`events.ts:11`](../../packages/sim/src/events.ts#L11)).

### SPAWN — coin spawns, self-rescheduling

[`scheduleSpawn`](../../packages/sim/src/mapgen.ts#L240) pushes the next spawn
`rng.range(coinIntervalMin, coinIntervalMax)` steps out — an RNG-drawn delay
(1.5–4 s by default). When it fires, [`spawnItem`](the-step.md) places one coin
and `scheduleSpawn` runs again. One spawn is always pending.

### UPKEEP — the connectivity metronome

[`scheduleUpkeep`](../../packages/sim/src/mapgen.ts#L248) pushes the next sweep a
fixed `upkeepInterval` (20 s) out — **no RNG draw**. Upkeep is a metronome, and
drawing for it would put a third consumer on the shared stream for no gain. When
it fires, [`upkeep`](../gameplay/upkeep.md) runs and reschedules.

Both are seeded once at genesis by [`generate`](../../packages/sim/src/mapgen.ts#L12).

## Why this is the only periodic work

The single map-wide sweep in the whole simulation is `upkeep`, once per 20 s of
game time. Everything else — accrual, victory checks — is O(empires), not
O(tiles). That is what makes a multi-day game's catch-up cheap.
