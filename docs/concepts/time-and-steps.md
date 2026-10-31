# Time and steps

The unit of simulated time is the **step**. `STEPS_PER_SECOND = 12`
([`constants.ts:39`](../../packages/sim/src/constants.ts#L39)). Every duration in
the rules is a step count; [`constants.ts`](../../packages/sim/src/constants.ts#L41)
has `seconds()` / `minutes()` / `hours()` helpers that convert at build time so
the balance sheet reads in human units.

## There are no turns

The world advances continuously. A seat accrues one population per step
([gameplay/population.md](../gameplay/population.md)); coins spawn on a schedule;
territory decays on a schedule. Nobody waits for anybody to "take their turn" —
lockstep only ever waits to know that a seat has
*nothing more to say* about a step that is about to be simulated.

## The current step comes from the wall clock

A peer's target step is a pure function of real elapsed time since the game
started:

```
targetStep = floor((now - genesis.startedAt) * STEPS_PER_SECOND / 1000)
```

(`Lockstep.targetStep`). The world turns
whether or not anyone is watching. Clock skew between peers costs responsiveness
(a peer whose clock is ahead wants to simulate a step before the inputs for it
have arrived, and waits), never agreement — the step a move lands on is written
into the move before it is signed.

## The consequence: fast-forward, not replay-every-tick

A peer returning after six hours has roughly **260,000 steps** to cover. Scanning
the map once per step would take a minute. So the world does not sweep per step —
world updates are [scheduled events](../simulation/events-not-ticks.md) on a
heap, and [`Sim.fastForward`](../../packages/sim/src/sim.ts#L217) skips straight
from one event to the next. Empty steps cost nothing.
[`determinism.test.ts`](../../packages/sim/src/test/determinism.test.ts) asserts
six offline hours are crossed in under ten seconds.

## Key intervals (all genesis parameters)

| Rule | Default | Meaning |
|---|---|---|
| `botActionInterval` | 2 s (24 steps) | floor on how often any bot acts |
| `heartbeatInterval` | 30 s | a live seat re-signs a `HEARTBEAT` this often |
| `livenessWindow` | 2 min | a seat is "live" if its last beat is within this |
| `upkeepInterval` | 20 s | the connectivity sweep runs this often |
| `noobSteps` | 3 min | new-empire capital protection expires by this (or `noobTiles`) |
| `abandonWindow` | 3 h | an empire silent this long is treated as gone, in an open-ended game; `0` (none) in a game with a [duration](../gameplay/durations.md) |
| `coinIntervalMin/Max` | 1.5 s / 4 s | span a coin spawn reschedules within |

From [`DEFAULT_RULES`](../../packages/sim/src/constants.ts#L45).
