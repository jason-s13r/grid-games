# Victory

[`checkVictory(state)`](../../packages/sim/src/victory.ts#L35) runs at the end of
every [step](../simulation/the-step.md), after accrual. It first marks any newly
[eliminated](elimination-and-annex.md) empire (`alive = 0`, `eliminatedAt`), then
tests four end conditions.

`WIN` ([`types.ts:60`](../../packages/sim/src/types.ts#L60)):
`NONE`, `TIMEOUT`, `LAST_EMPIRE`, `LAST_ROSTER`.

## The conditions

| Condition | When | Winner | Reason |
|---|---|---|---|
| **Last empire** | exactly 1 empire `alive` | that empire | `LAST_EMPIRE` |
| **Everyone gone** | 0 empires `alive` | `0` (nobody) | `LAST_EMPIRE` |
| **Abandonment** | more than 1 alive, but only 1 is *present* | the present one | `LAST_ROSTER` |
| **Timeout** | `endStep > 0` and `step >= endStep` | the [leader](#the-leader) | `TIMEOUT` |

`endStep` defaults to **0** (no timeout).

## Presence, and why the abandon window is hours

[`silentFor(state, empire)`](../../packages/sim/src/victory.ts#L22) = steps since
the empire last had *any* seat send a [`HEARTBEAT`](../continuity/heartbeats-and-liveness.md).
An empire is "present" for the abandonment test if `silentFor < abandonWindow`
(**3 hours** of game time).

Deliberately long: **being asleep is not being defeated.** A short window would
reward waiting until an opponent's team is offline — exactly what shift rotation
(and a [night-cover bot](bots.md)) exist to avoid.

`isLive(state, empire)` ([`victory.ts:13`](../../packages/sim/src/victory.ts#L13))
uses the tighter `livenessWindow` (**2 min**) and is what
[lockstep](../continuity/lockstep.md) consults to decide whether to wait on a
seat's input — a different question from "has this empire abandoned the game".

Presence is derived from the **log**, never from sockets: peers genuinely
disagree about who is reachable, so evaluating "last player remaining" from
connection state would have two peers computing different winners — a guaranteed
desync.

## The leader

[`leader(state)`](../../packages/sim/src/victory.ts#L74), for a timeout: highest
`tilesOwned`, ties broken by `popTotal`, then by `id`. A **total** order, so
every peer names the same winner.

## Ending

[`end`](../../packages/sim/src/victory.ts#L89) sets `phase = ENDED`, `winner`,
`winReason`. After that, [`validate`](../moves/validation.md) rejects every move
and `advance` is a no-op. The [`summarise`](difficulty-and-balance.md) figures are
read from hashed state, so every peer computes the same end screen and the
[leaderboard](../trust-and-verification/leaderboard.md) recomputes them by replay.
