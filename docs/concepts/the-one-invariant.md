# The one invariant

```
hash(state) = fnv1a(snapshot(state))
```

[`state.ts:266`](../../packages/sim/src/state.ts#L266),
[`hash.ts:8`](../../packages/sim/src/hash.ts#L8).

There is a **single** canonical serialisation of simulation state
([`snapshot()`, state.ts:114](../../packages/sim/src/state.ts#L114)), and both
the consensus check and the content address of a stored checkpoint are built on
it. Consequences:

- Two peers agreeing on the hash agree on **every byte** of state.
- A snapshot fetched from a stranger can be **verified before it is trusted** —
  restore it, hash it, and put the old state back if the number disagrees. This
  is what lets an [untrusted archive peer](../continuity/resume.md) be useful.
- There is no second encoding anywhere, and `cloneState` copies *through* the
  snapshot ([`state.ts:271`](../../packages/sim/src/state.ts#L271)) — a clone is
  bit-identical by construction rather than by careful hand-copying.

The hash is FNV-1a over the snapshot bytes — a 32-bit value, small enough to
compare by eye or in a CI log. It is **not** a security hash, and it is worth being
exact about what that costs. A peer that wants to fake agreement must produce bytes
that hash to the claimed value, and that is arithmetic rather than simulation:
FNV-1a is a multiply-and-xor chain over 32 bits, multiplication by the prime is
invertible mod 2^32, and `restore()` reads every field after the magic number and
layout version raw. Meet in the middle over five free bytes in any stat slot and
any target hash falls out in milliseconds.

So the hash is a content **address** and not a proof. What defeats a forged
snapshot is that every seat broadcasts a *signed* checkpoint every five seconds: a
peer that adopted one disagrees with everybody within one interval and
[rebuilds](../continuity/desync.md). For a game with nobody left to disagree — the
cold start — the signatures have to travel with the bytes, which is what
[resume points](../continuity/resume-points.md) are.

## Three things that run through the whole repository

### Anything that moves the hash is a breaking change

Even when no exported signature changed. Rule tweaks, spawn weights, RNG draw
order and snapshot layout all qualify. A peer on an old build and a peer on a new
one would diverge at the first affected step and each accuse the other. The
semver on `@tessera/sim` obeys the hash, not the API.

### PROTOCOL_VERSION guards the major, and the supported set keeps games alive

Two constants, because they answer different questions.
[`PROTOCOL_VERSION`](../../packages/sim/src/constants.ts) is stamped into every
[genesis](../protocol/genesis.md) record this build composes.
[`SUPPORTED_PROTOCOLS`](../../packages/sim/src/constants.ts) is every version it
can play, verify and replay — newest first, `PROTOCOL_VERSION` always its head.

The `Sim` constructor and `inspectGenesis` both ask `playsProtocol`, so an
unsupported version is refused **at the lobby**, because the alternative is a
silent desync three hours in. What the set buys is the games in flight on the
day a release ships: a ten-day game started on Monday survives Thursday's
deploy, and — since `verifyArchive` reaches the same check — every archive ever
written stays verifiable after the number moves.

A game is stamped at one version and plays at that version for its whole life.
This is version *selection*, not negotiation: `state.genesis.protocol` decides
behaviour once a record is adopted, never the build's constant. A running game
cannot be upgraded, because `gameIdOf` hashes the protocol field and every
signature in the game binds the game id — an upgraded game is a different game
by the only definition this codebase has.

### Nothing outside the simulation may enter it

Camera position, chat, signatures, socket state and wall-clock stopwatches are
all deliberately outside the hash. The full accounting is in
[continuity/what-is-hashed.md](../continuity/what-is-hashed.md).

## What the snapshot contains

Everything the game *is*: the four board layers, every empire and seat record
(including diamonds, stock, unlock flags, population timers and all 16 stat
counters), scheduled events, RNG state, phase and winner. The exact byte layout
is [simulation/snapshot-and-hash.md](../simulation/snapshot-and-hash.md).

Stats being *in* the hash is what makes end-of-game figures consensus by
construction: no client reports them, so no server has to be trusted not to
believe a lying one.
