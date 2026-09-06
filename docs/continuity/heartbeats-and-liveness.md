# Heartbeats and liveness

[Lockstep](lockstep.md) will not simulate a step until every seat that *could*
contribute to it has said it will not. "Could contribute" means **live** — and
liveness comes from the log, never from a socket.

## Why not sockets

Peers genuinely disagree about who is reachable over the network. If "is this
seat still playing" were answered from connection state, two peers would compute
different answers, wait for different seats, and diverge — a desync manufactured
by the thing that was supposed to keep the game moving. So a seat announces its
own presence, signed, and every peer reads the same log.

## HEARTBEAT

`HEARTBEAT` (move type 7). Its only effect: `member.lastBeat = state.step`
([`rules.ts:333`](../../packages/sim/src/rules.ts#L333)). It carries no
coordinates and is legal for any live seat.

[`Lockstep.beat()`](../../packages/net/src/lockstep.ts#L536) auto-submits one
every `heartbeatInterval` (**30 s**) after a step it simulated. A
[SimBot](../gameplay/bots.md) seat has its `lastBeat` set to the current step
every step inside `runSimBots` — it is always present.

## Two windows

| Function | Window | Answers |
|---|---|---|
| [`Lockstep.live(seat)`](../../packages/net/src/lockstep.ts#L1298) | `livenessWindow` (**2 min**) | should lockstep wait on this seat's input? |
| [`isLive(state, empire)`](../../packages/sim/src/victory.ts#L13) | `livenessWindow` | (same, used by nothing hashed — a helper) |
| [`silentFor` / abandonment](../gameplay/victory.md) | `abandonWindow` (**3 h**) | has this empire abandoned the game? |

The 2-minute window is deliberately several times the 30-second heartbeat
interval, so one dropped packet or a brief reconnect does not stop the game. The
3-hour window is deliberately long: **being asleep is not being defeated**, and a
short window would reward waiting until an opponent's team is offline.

## blocked()

[`Lockstep.blocked(step)`](../../packages/net/src/lockstep.ts#L1305) is the list
of seats this peer is waiting on for `step`: every roster seat that is not ours,
not [ejected](ejection.md) by this step, **is `live`**, and has not sent a
[`Ready`](lockstep.md) covering this step. When that list is non-empty the pump
loop breaks, re-announces readiness, and enters [`stalling`](leaving-and-drops.md).
`blockedOn()` drives the "Waiting for E2·1" line in the
[client's](../clients/web-client.md) status bar.
