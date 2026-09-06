# The life of a move

One click, followed end to end, because it crosses every layer.

## 1. The click → what it means

A tap on a tile reaches [`boardClick`](../../apps/web/src/game/input.ts).
**There are no modes.** The click says *where*
and the board says *what*:

- terrain is uncrossed `RIVER` → `PLACE_BRIDGE`;
- terrain is uncrossed `WALL` → `PLACE_LADDER`;
- tile is not adjacent to owned **and** `empire.marchUnlocked` → `MARCH`;
- otherwise → `CLAIM`.

It deliberately re-checks **neither stock nor adjacency** — that is
[validation](../moves/validation.md)'s business, and stating it twice is how the
two drift apart.

## 2. Driver → submit

[`OnlineGame.act`](../clients/web-client.md) asks the local sim to
[`validate`](../moves/validation.md) — **UI feedback only** — then calls
`Lockstep.submit(type, x, y)`.

## 3. submit → sign → broadcast

[`submit`](../../packages/net/src/lockstep.ts#L461):

- `slot = max(sim.step + inputDelay, ourReady + 1)` — `inputDelay` is 3;
- `move = { step: slot, empire, member, seq, type, x, y }`, `seq` from this
  seat's counter;
- drop `readyCeiling` to `slot - 1` so a [`READY`](lockstep.md) cannot overtake
  the move;
- [`signMove`](../moves/move-encoding.md) → `stash` locally → broadcast a `MOVE`
  frame;
- re-`announceReady` in a `finally` (signing is async; the world moved on).

## 4. Every peer receives it

[`onMove`](../../packages/net/src/lockstep.ts#L645), in order:

1. [`verifyMove`](../moves/move-encoding.md) against **the roster seat**, never a
   key in the move. Failure → silent discard.
2. [`EquivocationWatch.record`](equivocation.md) → on a conflict, broadcast the
   proof and eject.
3. drop it if the seat is already [ejected](ejection.md) at/before this step;
4. reject a move for a step **already simulated** (`< sim.step`) →
   `lateMoves++`, `onViolation`;
5. reject a move beyond `moveHorizon` (60 s);
6. reject a move at a step the sender's [`Ready`](lockstep.md) already covered;
7. `stash` it under its step (a slot is claimed once — a re-sent move is not
   applied twice).

## 5. The step comes round

When the wall clock reaches `slot` and [`blocked`](heartbeats-and-liveness.md) is
empty, [`pump`](lockstep.md) calls `sim.advance(moves)`. The step's moves are
sorted `(empire, member, seq)` — **independent of arrival order** — and
[`validate`](../moves/validation.md) runs on each, **authoritatively** this time.
An illegal move dies identically everywhere.

## 6. Consequences

- `sim.advance` returns dirty tile indices → the [renderer](../clients/web-client.md)
  repaints exactly those, and `MapImage` updates one pixel per tile.
- Every `checkpointInterval` each peer broadcasts a signed
  [hash](desync.md); every `snapshotInterval` it keeps a local snapshot.
- `onApplied(step, moves, signed)` fires → an
  [archive](../trust-and-verification/archive-format.md) appends the signed move.

## The two validations are not redundancy

The first (step 2, in the client) is so a rejected click feels rejected. The
second (step 5, in the sim) is the one that decides, and it is the entire
anti-cheat story — `validate()` is a pure function of state, so every peer
reaches the same verdict without asking anyone.

Every move takes this path, **a purchase included**: `BUY_BRIDGE` and `BUY_MARCH`
are signed, gossiped and validated exactly as a claim is, and no message anywhere
reports a diamond balance.
