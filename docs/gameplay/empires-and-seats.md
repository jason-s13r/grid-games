# Empires and seats

**An empire is not a player.** It is a colour on the board and a set of *seats*
that share its territory, each seat with its own population timer.

[`Empire`](../../packages/sim/src/types.ts#L261) carries the shared things:
`capital`, `diamonds`, `bridges`, `ladders`, `marchUnlocked`, `growthUnlocked`,
`tilesOwned`, `popTotal`, `alive`. [`Member`](../../packages/sim/src/types.ts#L247)
carries the per-seat things: `popMax`, `popTimer`, `popAcc`, `lastBeat`,
`joinedAt`, `kind`.

## Teams

Up to `maxSeats` (default **4**) seats per empire. Three teammates in one empire
are three independent click streams into one shared territory — which is what
produces simultaneous battle fronts: each seat accrues
[independently](population.md), so a team can push in three places at once while a
solo empire pushes in one.

`composeTeams` in the [lobby](../mesh/the-lobby.md) puts people on the same empire
number to team them. Putting everyone on empire 3 makes *one* empire, not four —
the numbers are compacted.

## Shift handover needs no mechanism

Because each seat has its own timer, a player leaving and another sitting down in
the same empire just… works. The incoming player has their own timer, accruing
from when they joined. There is no "pass the turn" — see
[concepts/time-and-steps.md](../concepts/time-and-steps.md). A team that wants
cover while everyone sleeps seats a [bot](bots.md) in a spare slot, at the cost
of that slot.

## The seat cap is the whole of team-size fairness

An empire that could add seats freely would simply out-accrue everyone else — and
since a [PeerBot](bots.md) is an ordinary peer holding an ordinary seat, "add
seats" would otherwise cost nothing but processes. So:

- `maxSeats` is **uniform** across every empire in a game.
- It is in the [genesis](../protocol/genesis.md) `rules`, agreed before anyone
  plays rather than argued about afterwards.
- It is enforced in three places: [`inspectGenesis`](../protocol/genesis.md) (a
  genesis is the one place an empire can be *born* oversized), every
  [`ROSTER_AMEND`](../continuity/roster-amendments.md) in
  [`validate`](../moves/validation.md), and again in the amendment quorum check.
- `SEAT_CEILING = 32` ([`constants.ts:105`](../../packages/sim/src/constants.ts#L105))
  is a hard ceiling above any `maxSeats` — empire and member ids ride in single
  bytes of every signed move, so 32 members (and 255 empires) are wire limits,
  not tunables.

## Control

`CONTROL.HUMAN` — the empire's seats are played by people (or
[PeerBots](bots.md)). `CONTROL.SIMBOT` — the empire is driven inside every peer's
simulation from the shared RNG ([bots.md](bots.md)); a SimBot empire has one BOT
seat and no keys, so nothing can be voted into it.
