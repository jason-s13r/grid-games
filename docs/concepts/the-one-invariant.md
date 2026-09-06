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
compare by eye or in a CI log. It is not a security hash; it does not need to be,
because a peer that wanted to fake agreement would still have to produce a real
snapshot that hashes to the claimed value, and the only way to do that is to run
the real simulation.

## Three things that run through the whole repository

### Anything that moves the hash is a breaking change

Even when no exported signature changed. Rule tweaks, spawn weights, RNG draw
order and snapshot layout all qualify. A peer on an old build and a peer on a new
one would diverge at the first affected step and each accuse the other. The
semver on `@tessera/sim` obeys the hash, not the API.

### PROTOCOL_VERSION guards the major

[`PROTOCOL_VERSION = 3`](../../packages/sim/src/constants.ts#L8) is stamped into
every [genesis](../protocol/genesis.md) record and checked in the `Sim`
constructor ([`sim.ts:52`](../../packages/sim/src/sim.ts#L52)) and in
`inspectGenesis`. A mismatched major is refused **at the lobby**, because the
alternative is a silent desync three hours in.

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
