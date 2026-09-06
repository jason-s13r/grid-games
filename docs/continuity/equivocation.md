# Equivocation

**Equivocation** is one seat signing two *different* moves for the same
`(empire, member, step, seq)` — telling different peers different things about one
slot. Two valid signatures on one slot are **cryptographic proof of cheating**,
and because the mesh gossips every move it sees, it is *detected* rather than
merely suspected.

## Detection

[`EquivocationWatch`](../../packages/protocol/src/records.ts#L578) keys `seen` on
`empire:member:step:seq`. Every verified move is
[`record`](../../packages/protocol/src/records.ts#L588)ed:

- first sighting of a slot → stored, no conflict;
- same move again (a snapshot answer re-sends moves) → not a crime;
- a **different** move in a slot already seen → returns the earlier move as
  proof.

The `step` **must** be in the key. A `seq` counter lives in one
[`Lockstep`](lockstep.md) instance and restarts at 0 when a player
[reloads](joining.md), so a returning seat reuses numbers it spent before. Keyed
on `seq` alone, an honest rejoin reads as the member contradicting itself.
Reusing a seq at a *different* step decides nothing — both moves are gossiped,
both applied at their own steps, every peer lands on the same state — so it is
not a crime either.

## The proof

[`onMove`](../../packages/net/src/lockstep.ts#L645), on a conflict: build
`EquivocationProof { a, b }` (both halves carry their own signatures), broadcast
an `EQUIVOCATION` frame, and call `onEquivocation` locally.

[`verifyEquivocation`](../../packages/protocol/src/records.ts#L624) re-checks the
accusation **from scratch** — same `(empire, member, step, seq)`, not the same
move, and both signatures valid against the roster. A recipient trusts the proof,
not whoever forwarded it.

## Ejection at a derived step

[`onEquivocation`](../../packages/net/src/lockstep.ts#L785) calls
[`eject`](ejection.md) at:

```
max(a.move.step, b.move.step) + EJECTION_DELAY      // EJECTION_DELAY = 4 s (48 steps)
```

**Derived from the proof, never from when a peer saw it** — so two peers that
learn of the same cheat at different moments still stop listening on the same
step, and ejection costs no agreement.

[`equivocation.test.ts`](../../packages/net/src/test/equivocation.test.ts): "the
cheat is detected by ≥2 witnesses"; "every witness ejects on the same step"; "the
step comes from the proof, not from when it was seen".
[`equivocation.test.ts` in protocol](../../packages/protocol/src/test/equivocation.test.ts):
"a re-hearing is not a crime"; "a reused seq at a later step is not a crime".
