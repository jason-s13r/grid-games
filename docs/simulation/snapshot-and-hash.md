# Snapshot and hash

[`snapshot(state)`](../../packages/sim/src/state.ts#L114) is the **single**
canonical byte serialisation of the world. `hash(state) = fnv1a(snapshot(state))`
([`state.ts:266`](../../packages/sim/src/state.ts#L266)). Everything else — the
consensus check, checkpoint content-addressing, `cloneState`, resume — is built
on this one function. See [concepts/the-one-invariant.md](../concepts/the-one-invariant.md).

## The byte layout

`MAGIC = 0x54455353` ("TESS"), `LAYOUT_VERSION = 3`
([`state.ts:19`](../../packages/sim/src/state.ts#L19)). `snapshot()` writes, in
order ([`state.ts:126`](../../packages/sim/src/state.ts#L126)):

**Header** — `u32 MAGIC`, `u16 LAYOUT_VERSION`, `u16 width`, `u16 height`,
`u32 step`, `u32 rng.s`, `u32 events.seq`, `u8 phase`, `i8 winner`,
`u8 winReason`, `u8 empireCount`, `u32 itemCount`, `u32 eventCount`.

**Board** — for `i` in `0..n`: `i8 owner[i]`; then all `u8 terrain[i]`; then all
`u8 item[i]`; then all `i32 pop[i]`. Four separate passes, each in flat-index
order.

**Per empire** — `u32 capital`, `u16 bridges`, `u16 ladders`, `u16 marchUnlocked`,
`u16 diamonds`, `u16 growthUnlocked`, `u32 tilesOwned`, `u32 popTotal`, `u8 alive`,
`u8 control`, `u32 eliminatedAt`, `u8 memberCount`, `16 × u32` empire stats, then
per member: `u8 kind`, `u16 popMax`, `i32 popTimer`, `i32 popAcc`, `u32 lastBeat`,
`u32 joinedAt`, `16 × u32` member stats.

**Events** — `state.events.toSorted()` ([canonical order](events-not-ticks.md)),
each: `u32 step`, `u32 seq`, `u8 type`, `u32 payload`.

`byteLength()` ([`state.ts:102`](../../packages/sim/src/state.ts#L102)) computes
the exact size up front; the buffer is never resized.

## Why one encoding, only

- **The hash is meaningful.** Two peers agree on the hash ⟹ they agree on every
  byte listed above. There is no hidden state to diverge in.
- **Clones are exact.** [`cloneState`](../../packages/sim/src/state.ts#L271)
  does `restore(copy, snapshot(state))` — a deep copy *through* the canonical
  form, bit-identical by construction rather than by careful field copying.
- **Untrusted snapshots are safe.** `restore()` rejects bad magic or a layout
  mismatch; a peer adopting a snapshot from a stranger restores it, re-hashes,
  and reverts if the number is wrong. See continuity/resume.md.

## restore()

[`restore(state, buffer)`](../../packages/sim/src/state.ts#L180) rebuilds every
layer and record from the buffer. It throws on `MAGIC` or `LAYOUT_VERSION`
mismatch. The `genesis` reference is *not* in the snapshot — it is carried on the
`State` object and reattached, because every peer already has the genesis (it is
how the game id was derived).

## The hash function

[`fnv1a`](../../packages/sim/src/hash.ts#L8) — 32-bit FNV-1a over the snapshot
bytes. `hex(h)` renders it as 8 lowercase hex digits. Not a cryptographic hash
and it does not need to be: forging agreement would mean producing a real
snapshot that hashes to a target, and the only way to get a real snapshot is to
run the real simulation.

`LAYOUT_VERSION` is bumped whenever the byte layout changes — which moves every
hash, so it travels with a `PROTOCOL_VERSION` bump too — and a build that
plays more than one version must reproduce each one's hash exactly, which is
what the per-version recorded fixtures assert.
