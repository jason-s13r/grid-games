# Roster amendments

A `ROSTER_AMEND` [move](../moves/the-eleven-types.md) adds a seat to an empire
mid-game. It is how a solo player recruits a first teammate, how a substitute
joins on day three, and how a [PeerBot](../gameplay/bots.md) or
[observer](../clients/observer.md) gets a seat.

**There is no bot-shaped mechanism in the protocol.** From the mesh's side, every
one of these is a substitute joining a team.

## Not one member's decision

A [quorum](../protocol/roster.md) of the empire's **existing** seats must sign
the same [`Amendment`](../protocol/signed-records.md) record, or one compromised
key could walk an accomplice into a team that shares territory — which is the
whole game. A single-seat empire is its own quorum.

## Who may start one

Two things can, and the quorum rule is the same for both — which is the point
worth making rather than a footnote.

- **A member of the empire**, with `amend(key)`. The original path: somebody
  inside thinks of you.
- **The empire's own decision on an [application](joining.md)**, with
  `admit(empire, key)`. A seatless peer asked, and a member agreed. `admit` is a
  dispatcher, not a second mechanism: the first member to agree calls `amend`,
  everybody after them calls `endorse` on the record that exists.

Nothing about the quorum, the merge, the gossip or the seating changes between
them. The difference is entirely in who is allowed to put the first signature on
a record.

`amend` reads the empire off the caller's own seat and has no parameter for it,
which is why `admit` checks `seat.empire === empire` before forwarding: a member
of empire 2 clicking a row in a list of every empire's applicants would otherwise
seat that person onto empire 2 — silently, signed, and correct as far as every
other peer is concerned.

## The flow

[`Lockstep.amend(key, kind)`](../../packages/net/src/lockstep.ts) proposes
`{ empire, step: sim.step + AMENDMENT_DELAY, key, kind }`.
`AMENDMENT_DELAY = 3 s` (36 steps) — it must outlast the gossip that collects
signatures, because a roster append is hashed state and **every peer must know
the outcome before it simulates that step**.

[`considerAmendment`](../../packages/net/src/lockstep.ts#L953) merges, gossips
what grew ([`mergeAmendment`](../protocol/signed-records.md) — endorsements are a
set), and:

- [`endorse(empire, key)`](../../packages/net/src/lockstep.ts#L923) is **not
  automatic**. Endorsing a [drop](leaving-and-drops.md) is an observation;
  endorsing an amendment is a *decision about who joins the team*. The client
  surfaces `onInvitation(amendment, endorsed, needed)` and the player clicks.
- At most one endorsement per empire-and-key, ever — two records naming different
  steps cannot both reach a quorum, so the mesh cannot split over which step the
  seat appeared on.
- A stranger's forgery with nothing valid in it is **not stored, gossiped, or
  allowed to hold the game open** at its named step.
- [`hold()`](../../packages/net/src/lockstep.ts#L1027) drops `amendCeiling` below
  the earliest undecided proposal — this peer promises readiness only up to the
  step before, removing the race.
- [`expireAmendments`](../../packages/net/src/lockstep.ts#L1043), at the top of
  every step, gives up on a proposal once the game **reaches the step it named**
  — a step number, not a stopwatch, so every peer gives up together. Otherwise
  one invitation nobody answers freezes the game.

## Seating

[`seatArrivals(step)`](../../packages/net/src/lockstep.ts#L1065): booked
amendments for this step are sorted by **key order** (so two landing on one step
are applied identically everywhere), each validated by the sim first, then
`roster.amend` and the sim's member append run **in lockstep** — the same index
on every peer. The injected move carries `seq = AMENDMENT_SEQ` (`0xffffffff`, a
number no real seq reaches) so ordering by `(empire, member, seq)` is
unambiguous.

`onSeated(seat, key)` and `onAmended(SignedAmendment)` fire on every peer,
including the newcomer — who by then holds the seat and can act. The
`SignedAmendment` is the authority an [archive](../trust-and-verification/archive-format.md)
records, because the `ROSTER_AMEND` move in the log carries no signature of its
own.

[`amendment.test.ts`](../../packages/net/src/test/amendment.test.ts): "a quorum
seats a newcomer at the same index on the same step"; "the substitute takes the
seat without being told"; "a one-seat empire is its own quorum"; "a forged
amendment isn't stored and doesn't hold the game open".
