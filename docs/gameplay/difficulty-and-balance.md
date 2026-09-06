# Difficulty and balance

## Bot difficulty presets

[`DIFFICULTY`](../../packages/sim/src/specs.ts#L84) —
`Record<"easy" | "steady" | "hard", BotProfile>`:

| | easy | steady | hard |
|---|---|---|---|
| `popMax` | 333 | 666 | 999 |
| `coins` | 20 | 60 | 95 |
| sleep phase | 90 s | 30 s | **none** |
| attack phase | 30 s | 75 s | 105 s |

`popMax` is the only real strength lever. The **tempo bands** are shared across
all three difficulties ([`TEMPO`](../../packages/sim/src/specs.ts#L41)):
`expand` FAST `[2 s, 30 s]`, `attack`/`defend`/`fortify` SLOW `[60 s, 90 s]`,
`heal` MEDIUM. Speed is a property of the *work*, not the opponent — you grab
empty ground quickly and bank properly before hitting held ground. Sharing the
table is what makes `popMax` mean anything: a cap only bites when the bot waits
longer than the cap, so if easy clicked fastest it would dodge its own ceiling.

**Duration is appetite.** Time in a phase is its share of the cycle, so there is
no separate weight. Easy spends a quarter of its life asleep and barely attacks;
hard never sleeps and spends a third of its time walking at somebody. `sleep` is
a real phase — population accrues through it — so an easy bot opens a fresh phase
with a full bank, which is why it is occasionally dangerous rather than uniformly
harmless.

`simbot(level)` ([`specs.ts:129`](../../packages/sim/src/specs.ts#L129)) builds a
`CONTROL.SIMBOT` empire with one BOT seat carrying that profile. `humans(n)`
builds an n-seat human empire.

## The rules balance sheet

[`DEFAULT_RULES`](../../packages/sim/src/constants.ts#L45). Every one is a
genesis parameter.

| Rule | Default | Notes |
|---|---|---|
| `popMax` | 999 | seat population ceiling |
| `popRateNum / popRateDen` | 1 / 1 | 1 population per step (12/s) |
| `maxMultiplier` | 4 | surround multiplier cap |
| `cascadeTileCap` | 4096 | tiles a single cascade chain may touch |
| `coinIntervalMin / Max` | 1.5 s / 4 s | span a spawn reschedules within |
| `coinWeights` | 52 / 24 / 9 / 15 | bronze / silver / gold / diamond |
| `maxItemsOnMap` | 360 | spawn stops above this |
| `coinNearBias` | 72 | % of spawn probes that hop off an owned tile |
| `coinNearRadius` | 4 | how far they hop |
| `bridgeCost` / `ladderCost` | 3 / 3 | diamonds |
| `marchCost` / `growthCost` | 6 / 6 | twice a bridge — permanent unlocks |
| `growthAmount` | 1 | population per reachable tile per upkeep pass |
| `upkeepInterval` | 20 s | connectivity sweep period |
| `decayNum / decayDen / decayMin` | 1 / 8 / 1 | cut-off loss: max(1, pop/8) per pass |
| `noobTiles` / `noobSteps` | 40 / 3 min | capital protection lifts on **either** |
| `heartbeatInterval` | 30 s | auto-heartbeat cadence |
| `livenessWindow` | 2 min | "live" for lockstep's wait decision |
| `abandonWindow` | 3 h | "present" for the abandonment win |
| `elimination` | `CAPITAL` | vs `ANNIHILATION` |
| `endStep` | 0 | 0 = no timeout |
| `botActionInterval` | 2 s | floor on bot action rate — profiles may be slower, never faster |
| `maxSeats` | 4 | per empire, uniform, hard-ceiled at `SEAT_CEILING` = 32 |

## The 16 stat slots

`STAT` ([`constants.ts:19`](../../packages/sim/src/constants.ts#L19)), tracked
`Uint32Array(16)` **per empire and per seat**, inside the
[hashed snapshot](../simulation/snapshot-and-hash.md):

`PEAK_POP`, `PEAK_TILES`, `CASCADE_TILES`, `CASCADE_POP`, `COINS_BRONZE`,
`COINS_SILVER`, `COINS_GOLD`, `DIAMONDS`, `TILES_ONE_MOVE`, `BRIDGES`, `LADDERS`,
`MOVES`, `POP_SPENT`, `TILES_TAKEN`, `MARCHES`, `ANNEXED`.

They change nothing — they only record what happened. Being *in* the hash is what
makes end-of-game figures consensus by construction:
[`summarise`](../../packages/sim/src/stats.ts#L58) reads them into an
`EmpireSummary`, and the [leaderboard](../trust-and-verification/leaderboard.md)
recomputes them by replay rather than accepting a reported number.
