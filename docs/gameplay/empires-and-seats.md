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

## Vacancies: an empire nobody has claimed

An empire with **no members** is a *vacancy*. It is territory, not a player: the
map generator gives it a capital and separation from the shared seed like any
other, before anybody knows who will sit there, and it cannot win, lose, be
abandoned, or count toward "last empire standing".

That last part is a rule with teeth. Left inside those counts, a vacancy holds
its capital forever so [`LAST_EMPIRE`](victory.md) could never fire — and worse,
it has never beat, so it reads as *silent since step zero* and `LAST_ROSTER`
would go to whoever beat first. So a game must have **two empires somebody is
playing**; a held-open seat cannot be the second one, and the lobby refuses a
plan that tries.

Vacancy is derived and never stored — `members.length === 0`, nothing else — so
there is no new field in `Empire` and nothing new in the snapshot. Members are
only ever appended (a dropped seat is a mesh concept the simulation never hears
about), so the derivation cannot go backwards.

**It is the empty array on purpose.** That was already an error to every build
written before vacancies existed, so an older peer handed such a record *declines
to play* rather than desyncing three hours in — which is exactly the outcome a
protocol bump exists to produce, and why this needed none. A flag in `rules`
would have been read straight past.

### Arriving into one

Claiming a vacancy is the second way into a running game, and the only one that
needs nobody's permission. An amendment needs a quorum of an empire's existing
seats; a vacant empire has none to ask, so the record is a **claim**, signed by
the key it seats. A vacancy can be arrived at once — enforced against the roster,
not the simulation, because the simulation cannot tell a claim from an amendment
and should not be taught to.

The claimant does not pick a **location**. The capital was placed at genesis,
before anyone knew who would sit there, and that is precisely what makes it fair:
you take the ground the map gave that empire, not the best ground still going.
What you do pick is *which* vacancy — which, once banners land, is the same thing
as picking a house.

A claim is a human `ROSTER_AMEND`, so the [join window](durations.md) closes this
door on the same line it closes the other one. Until the pocket is claimed it is
held clear; see [capitals.md](capitals.md) for the shield and the grant.

## Shift handover needs no mechanism

Because each seat has its own timer, a player leaving and another sitting down in
the same empire just… works. The incoming player has their own timer, accruing
from when they joined. There is no "pass the turn" — see
[concepts/time-and-steps.md](../concepts/time-and-steps.md). A team that wants
cover while everyone sleeps seats a [bot](bots.md) in a spare slot, at the cost
of that slot.

## Applying for a seat

An empire can be joined by invitation — a member proposes and a quorum agrees —
and, since applications, by **asking**: a peer with a key and no seat puts a
standing signed request in front of that empire's seats, and one of them agreeing
turns it into the same amendment. See [joining](../continuity/joining.md).

The seat cap below is therefore a thing applicants run into and not only
inviters. A request to an empire already holding `maxSeats` is refused when it is
made, rather than left waiting on a quorum that could never pass it: an applicant
told no can ask somebody else, and one left waiting cannot tell the difference
between patience and a rule.

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
