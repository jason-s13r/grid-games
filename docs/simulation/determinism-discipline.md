# Determinism discipline

Every hazard here is a [desync](../continuity/desync.md) that surfaces only
between two specific engines, twenty minutes in. These are the rules a
contributor to [`packages/sim`](../../packages/sim) has to keep. They are
enforced by convention and by the [cross-environment test](../trust-and-verification/verifying-an-archive.md),
not by the type system.

## One RNG

[`rng.ts`](../../packages/sim/src/rng.ts) (mulberry32) is the **only** source of
randomness in the simulation. Its state is one uint32 and it is
[snapshotted](snapshot-and-hash.md), so a restore resumes the exact stream. See
[rng.md](rng.md). Two rules for callers:

- **Never call `next()` inside a short-circuiting condition one peer might skip.**
  If peer A evaluates `a() && rng.next()` and peer B's `a()` is false, their
  streams diverge forever after.
- **Never let the number of draws depend on anything outside state.**
  [`spawnItem`](the-step.md) takes four draws per probe *whatever the branch*
  for exactly this reason.

## Integers only

No `Math.sqrt`, `Math.pow` or trig in game logic — none of them is guaranteed
bit-identical across JS engines at the last bit.

- Use [`dist2`](../../packages/sim/src/geometry.ts#L44) (squared distance), never
  a real distance.
- Put an explicit `Math.floor` on every division.
- Where an *angle* is needed — the bot's [expansion sweep](../gameplay/bots.md) —
  compare integer **cross-products** instead of calling `atan2`
  ([`policy.ts:274`](../../packages/sim/src/policy.ts#L274)).

## No iteration-order dependence

Iterate flat arrays by index. Where a `Set` or `Map` is used, it must not be
iterated for anything that reaches state. The `seen` set in the bot
[`scan`](../../packages/sim/src/policy.ts#L119) is only ever membership-tested,
never iterated into a move.

The [event heap](events-not-ticks.md) uses a total `(step, seq)` order so heap
tie-breaks cannot differ. `snapshot()` writes events via `toSorted()`.

## Derive, don't store

A bot's phase is `step % cycle` over its declared phase durations
([`turnOf`, policy.ts:78](../../packages/sim/src/policy.ts#L78)) — so bots hold
**no** snapshot fields and cannot desync through their own bookkeeping. Its tempo
within a phase is a pure integer hash of *which pass through the cycle* it is
([`mix`, policy.ts:51](../../packages/sim/src/policy.ts#L51)), not an RNG draw —
drawing from the shared stream would move the coin spawns whenever somebody
retuned a bot.

## Erasable syntax

`packages/sim` is written in erasable TypeScript only (no `enum`, no parameter
properties), so it runs under Node's native type stripping and any bundler with
no transform. `TERRAIN`, `MOVE` etc. are `as const` object literals, not `enum`s
([`types.ts:3`](../../packages/sim/src/types.ts#L3)).
