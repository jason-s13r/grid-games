# Validation

[`validate(state, move)`](../../packages/sim/src/rules.ts#L251) is the **whole**
of the anti-cheat story. It is a pure function of `(state, move)` — no clock, no
sockets, no negotiation — run by every peer, so an illegal move dies identically
everywhere.

## It runs twice, and the two are not redundancy

1. **In the client, for feedback.** `OnlineGame.act`
   asks the local sim to validate before submitting, purely so a rejected click
   feels rejected. If it fails here the move is never signed.
2. **Inside `Sim.advance`, authoritatively.** Every stashed move for a step is
   re-`validate`d ([`sim.ts:102`](../../packages/sim/src/sim.ts#L102)) at the
   moment it is applied, against the state *as it is then* — which may differ
   from when it was submitted three steps earlier. This is the one that decides.

Keeping "signature valid" and "rule valid" as two separate questions is what lets
a peer hold a signed move it will refuse to apply.

## The checks, in order

From [`rules.ts:251`](../../packages/sim/src/rules.ts#L251):

1. `state.phase === PLAYING` — nothing is legal after the game ends.
2. The empire exists and is `alive`.
3. The seat exists.
4. `PASS` and `HEARTBEAT` — accepted for any live seat, no further checks.
5. `ROSTER_AMEND` — `members.length < min(maxSeats, SEAT_CEILING)`. The seat cap,
   enforced where it cannot be argued with: an empire votes a substitute in, but
   no quorum can vote itself a bigger team than every other empire is allowed.
6. `BUY_*` — the relevant `diamonds >=` check; `BUY_MARCH`/`BUY_GROWTH` also
   require the flag is not already set.
7. Coordinate moves — `inBounds(x, y)` first, then:
   - `PLACE_BRIDGE` / `PLACE_LADDER` — stock `> 0`, exact terrain
     (`RIVER` / `WALL`, not the already-crossed variants), adjacent to own.
   - `CLAIM` — passable; `popTimer > 0`;
     **not** [`isShielded`](../gameplay/capitals.md)`(direct = true)`; own tile or
     `adjacentToOwned`.
   - `MARCH` — `marchUnlocked`; `popTimer > 0`; passable;
     **not** `isShielded(direct = false)`; **not** `adjacentToOwned` (a bordering
     tile is an ordinary claim, and spending a march on one is a silent waste);
     [`marchVia`](../gameplay/marching.md)` >= 0`.

Anything not matched returns `false`.

## An illegal move is not an error

It is dropped — identically, by everyone — and the game continues
(`MOVES.md` / arrival). A peer does not
tell the sender; a third party framing a seat with a forged move achieves
nothing, because the forgery fails signature verification long before this, and
even a validly-signed illegal move just… does not happen.
`forgery.test.ts` holds it.
