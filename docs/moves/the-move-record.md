# The move record

[`Move`](../../packages/sim/src/types.ts#L237):

```ts
interface Move {
  step: number;    // the step it lands on, chosen before it is signed
  empire: EmpireId;
  member: MemberIndex;
  seq: number;     // this seat's counter, for ordering within a step
  type: MoveType;
  x: number;
  y: number;
}
```

Seven fields. Sixteen bytes on the wire ([move-encoding.md](move-encoding.md)).
The interesting part is what is **missing**:

- **No key.** A move names a seat, `(empire, member)`; the
  roster says which public key sits there. If the key
  travelled inside the move, "the signature is valid for the key it names" would
  prove nothing.
- **No amount.** A claim does not say how much population it spends. The
  simulation reads `member.popTimer`, which it has been accruing itself since
  step zero.
- **No cost, no price.** A purchase does not carry what it costs. Costs are in
  the genesis `rules`, agreed before anyone played.
- **No result.** No tile count, no capture list, no "and therefore I own this
  now."

Every absence is the same rule: **a move asserts a decision, never a quantity.**
A field a peer could lie about is a field the rules would have to be prepared to
disbelieve, and the simplest way to be sure a number is right is never to have
received it. See [concepts/moves-not-state.md](../concepts/moves-not-state.md).

## The fields

| Field | Notes |
|---|---|
| `step` | Chosen before signing, normally `sim.step + inputDelay` (3 ahead). Bounds the move to a slot: it can never have to arrive "in the past", and a move for a step already simulated is rejected. |
| `empire` | `1..N`. Range-checked at `>= 1` — `0` is neutral ground and nobody signs as neutral (`records.ts:60`). |
| `member` | Index into the empire's seat list. |
| `seq` | This seat's own counter. Moves within a step are ordered by `(empire, member, seq)`. Resets to 0 when a peer reloads — which is why equivocation detection keys on `step` too. |
| `type` | One of the [eleven types](the-eleven-types.md). |
| `x`, `y` | Tile coordinates for `CLAIM`, `MARCH`, `PLACE_BRIDGE`, `PLACE_LADDER`. Zero for the rest — **except `ROSTER_AMEND`, which repurposes `x` as the new seat's `MemberKind`** (`records.ts:505`). |

## What every peer knows

All of it. There is no hidden state anywhere in the design. Because
[`snapshot()`](../simulation/snapshot-and-hash.md) serialises **every** empire's
diamonds, bridge/ladder stock, both unlock flags, every seat's population timer
and all sixteen stat slots, each peer holds every rival's full accounting — it
*derived* it, move by move, from the same log everyone has.

Two consequences:

- **The information is available, not hidden by protocol.** What the
  client chooses to display is a separate question.
  Nothing stops a peer from rendering every rival's diamond balance; the data is
  already in the tab. A game of genuinely hidden information would need a
  different design — lockstep replication is incompatible with one.
- **Divergence is a desync, not an advantage.** Stock, unlocks and stat counters
  are all inside the hashed bytes, so a peer whose numbers differ by one fails
  the next checkpoint comparison within seconds. There
  is nowhere to keep a lie.
