# One step

[`Sim.advance(moves)`](../../packages/sim/src/sim.ts#L92) simulates exactly one
step. It is the **only** thing that mutates hashed state, and it does its work in
a fixed order so that two peers with the same inputs reach the same bytes.

## The fixed order

From [`sim.ts:97`](../../packages/sim/src/sim.ts#L97):

1. **Player inputs.** `moves` are sorted by `(empire, member, seq)` —
   [`sim.ts:100`](../../packages/sim/src/sim.ts#L100) — a canonical order
   independent of the order they arrived over the network. Each is re-`validate`d
   here (authoritatively — see [moves/validation.md](../moves/validation.md)) and
   an invalid one is dropped, identically, by every peer.
2. **SimBot empires.** [`runSimBots`](../../packages/sim/src/sim.ts#L119) walks
   every `SIMBOT`-controlled empire, marks its seats present, derives a move from
   the shared RNG + the genesis [`BotProfile`](../gameplay/bots.md), validates it,
   applies it. Zero bandwidth.
3. **Scheduled events.** [`runEvents`](../../packages/sim/src/sim.ts#L148) drains
   the [event heap](events-not-ticks.md) for this step: `SPAWN` spawns a coin and
   reschedules; `UPKEEP` runs the [connectivity sweep](../gameplay/upkeep.md) and
   reschedules.
4. **Accrual, victory, clock.** [`accrue`](../../packages/sim/src/rules.ts#L668)
   adds population to every live seat; [`checkVictory`](../../packages/sim/src/victory.ts#L35)
   marks eliminations and may end the game; `state.step++`.

If `state.phase !== PLAYING`, `advance` returns an empty dirty set and does
nothing else.

## The return value: DirtySet

`advance` returns a `Set<number>` of tile indices that changed
([`rules.ts:12`](../../packages/sim/src/rules.ts#L12)). This is the *only* thing
a renderer is ever handed — the [web client](../clients/web-client.md) repaints
exactly those tiles and updates one pixel per tile in its
[map image](../clients/web-client.md). Nothing computes a diff; the sim reports
what it touched.

## fastForward

[`Sim.fastForward(toStep, moves?)`](../../packages/sim/src/sim.ts#L217) buckets
`moves` by step and calls `advance` in a loop until `state.step === toStep` (or
the game ends). Because world updates are [scheduled events](events-not-ticks.md)
rather than per-tile scans, catching up 260,000 steps is a few hundred event
drains, not 260,000 map sweeps. This is the path a
[resuming peer](../continuity/resume.md) and the
[replay tool](../trust-and-verification/verifying-an-archive.md) both take.

## spawnItem — a note on determinism

[`spawnItem`](../../packages/sim/src/sim.ts#L177) takes **four RNG draws per
probe whatever branch it takes** (`seed`, `near`, `dx`, `dy`), and probes at most
24 times. The fixed draw count is deliberate: the RNG stream must be a function
of state alone, so a peer that skipped a draw because a probe landed on owned
ground would desync every peer after it. Coins spawn only on neutral passable
tiles; `coinNearBias` (72%) hops most probes off an owned tile so coins appear
near the fighting. See [gameplay/coins-and-cascades.md](../gameplay/coins-and-cascades.md).
