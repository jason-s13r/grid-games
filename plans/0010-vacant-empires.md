# 0010 — Vacant empires: arriving at a game that has already started

Status: built (2026-09-16)
Depends on: 0002 (`joinWindow` is the shutter on this door)
Branch: `vacant-empires`

## The problem

There is exactly one way into a running game today, and it is being *invited*:
a quorum of an existing empire's seats signs a `ROSTER_AMEND` and you become
their fourth pair of hands (`packages/net/src/lockstep.ts:897`). There is no
way to arrive and play as yourself.

A multi-day game needs one. A game announced on a board on Monday that only
seats the four people who happened to be in the tab at the moment of sealing
is a game nobody can join, and the address book (0007) is then a list of
things you may watch.

## The design in one sentence

**A vacancy is an empire the map generator placed and nobody has claimed** —
territory, not a player — and claiming it is an amendment with nobody to ask.

## Why this is not just "allow an empty members array"

Five places assume an empire has at least one member. Each is a decision, not
an accident, and each needs an answer:

| Site | Today | With vacancies |
|---|---|---|
| `inspectGenesis`, `packages/protocol/src/genesis.ts:91` | `members.length < 1` → `"members"` | allowed for `CONTROL.HUMAN`; still refused for a SimBot empire, and still refused if *no* empire has members |
| `placeCapitals`, `packages/sim/src/mapgen.ts:177` | iterates `state.empires` | **unchanged** — it never looked at members, so a vacancy gets a capital and separation for free |
| `validate` ROSTER_AMEND, `packages/sim/src/rules.ts:256` | `empire.members[move.member]` undefined → `false` | the claim branch is checked *above* that lookup |
| `checkVictory`, `packages/sim/src/victory.ts:35` | vacancy is `alive: 1`, holds its capital forever → `LAST_EMPIRE` can never fire | unclaimed empires are excluded from `alive`, `present` and `leader` |
| `claim`, `packages/sim/src/rules.ts:464` | any adjacent tile is takeable | tiles inside an unclaimed capital's shield are not |

Vacancy is derived, never stored: **an empire is vacant iff
`members.length === 0`.** No new field in `Empire`, and therefore nothing new
in the snapshot encoding (`packages/sim/src/state.ts:145-160`). A member is
only ever appended — a dropped seat is a net-layer concept and never removed
from the simulation — so the derivation cannot go backwards.

## An unclaimed empire is territory, not a player

It cannot win, cannot lose, cannot be abandoned, and does not count toward
"last empire standing". `silentFor` would otherwise report it silent from step
zero and hand `WIN.LAST_ROSTER` to whoever is awake (`victory.ts:61`) — the
same trap 0002 fixes, arriving by a different door.

If every claimed empire is eliminated and only vacancies remain, the game ends
with no winner, which is what `end(state, 0, WIN.LAST_EMPIRE)` already does
(`victory.ts:54`).

## The shield, and the camper it has to beat

A new rule, `vacancyRadius`: no empire may claim, march into, or cascade into a
tile within that von Neumann ball of an **unclaimed** capital. A von Neumann
ball rather than a Euclidean disc because that is what `COIN_RADIUS` already
means here (`packages/sim/src/constants.ts:17`) and two radius metrics is one
too many.

The naive version of this rule fails to a patient opponent, and the failure is
worth writing out because it sets the radius:

> A camper builds a thick, high-population wall one tile outside the shield and
> waits. The shield holds until Thursday. A player claims the vacancy, arrives
> on a single tile inside a sealed pocket, and is annexed in the next few
> minutes. The shield did not protect them; it marked the target and told the
> camper exactly where to build.

Widening the radius alone does not close this — the camper simply builds one
tile further out — but it changes the economics, and that is the point. A
radius of 6 costs an attacker a ring of ~24 tiles. A radius of 14 costs ~56,
held against upkeep decay for days, on ground they cannot use, in plain view of
everyone else on the map. **Proposed default 14**, and the plan should tune it
against how much ground an empire actually holds by day three rather than
against a feeling.

Two further mitigations, and the second is the real fix:

1. **The grace period starts on arrival, not on the game** (below), so a
   claimant's capital cannot be taken while they orient.
2. **The shield is also the starting grant.** On claim, every passable tile
   inside the ball that is still neutral becomes the new empire's, at a
   population set by a `vacancyGrant` rule. The arriving player does not appear
   on one tile inside a wall; they appear holding the whole pocket the shield
   was keeping for them, with a border to push from. A camper's wall then buys
   them a siege, which is a fair thing to have built, rather than a kill.

The grant is ordinary hashed state — `owner`, `pop`, `tilesOwned`, `popTotal`,
applied deterministically from the claim move like any other transition — and
it is the branch that makes claiming a vacancy structurally different from
being amended onto a team. Recommended, and separable: ship the shield first,
add the grant when the radius alone proves insufficient in a real game.

`placeCapitals` separates capitals by greedy max-min over sampled candidates
(`mapgen.ts:176`), so shields do not normally overlap — but nothing guarantees
it at radius 14 on a small map. Overlap is harmless for protection (a tile
inside two shields is protected until both are claimed) and must be resolved
for the grant: a contested tile goes to the first claimant in log order, which
is already a total order.

## When protection ends

Today it is one line, `packages/sim/src/rules.ts:28-31`:

```ts
export function isProtected(state: State, empire: Empire): boolean {
  const rules = state.genesis.rules;
  return empire.tilesOwned < rules.noobTiles && state.step < rules.noobSteps;
}
```

Two problems, one of them fatal for this plan.

**The clock is the game's, not the empire's.** `state.step < noobSteps` is three
minutes from the *start of the game*. A player claiming a vacancy on day three
is past it by three days and gets no grace whatsoever — not a shorter grace,
none.

It changes to measure from the empire's own arrival, derived rather than
stored: `arrivedAt(empire)` is the **minimum `joinedAt` across its members**,
which `Member` already carries (`packages/sim/src/types.ts:257`) and
`applyMove` already stamps (`rules.ts:391`). No new field, so no change to the
snapshot encoding.

The derivation is exactly right, and the reason is worth stating: grace belongs
to the **empire**, not to the person. An empire seated at genesis has a minimum
of 0 forever, however many substitutes it amends in on day six — a team does
not get its capital immunity back by recruiting. An empire that arrived as a
claim has the claim step, because that is when it came into existence.

That is also what keeps this change bit-identical on every record written so
far: no existing genesis has an empire whose members all joined after step 0,
so `arrivedAt` is 0 everywhere and the old behaviour is reproduced exactly.

**One strength test is too blunt.** `tilesOwned` alone says nothing about
whether an empire can defend what it has: forty tiles of one population each is
not an established empire, and it is what a claimant holding a granted pocket
looks like on arrival. Protection ends when the empire is *established*, which
is a combination:

```ts
export function isProtected(state: State, empire: Empire): boolean {
  const r = state.genesis.rules;
  const since = state.step - arrivedAt(empire);
  if (since >= r.graceSteps) return false;          // the ceiling: time alone
  return (
    state.pop[empire.capital]! < r.graceCapitalPop &&
    empire.popTotal        < r.gracePopTotal &&
    empire.tilesOwned      < r.graceTiles
  );
}
```

Read it as: **a hard ceiling in time, lifted early by any one measure of
strength.** Crossing the capital-population bar, the total-population bar or
the tile bar ends protection immediately; otherwise it runs until `graceSteps`.

The shape matters, because the alternative reading is a trap. Four conditions
OR'd together can only ever *shorten* protection — every new condition is
another way to lose it early, and a claimant who is granted a pocket at radius
14 would trip the tile bar on the step they arrive. The time ceiling has to sit
outside the disjunction, and the strength bars have to be set against what a
grant actually gives you rather than against a genesis start.

`noobTiles` becomes `graceTiles` and `noobSteps` becomes `graceSteps`, read as
`r.graceTiles ?? r.noobTiles` so a stored record keeps working. The two new
population bars default high enough that a genesis-seated empire crosses the
tile bar first, exactly as it does today — which is the migration test, not a
hope.

## The claim record

A claim cannot be a `Move`. Moves carry no key: attribution is
`roster.keyOf(empire, member)` (`packages/protocol/src/records.ts:48`), and a
claimant holds no seat, so `verifyMove` refuses it by construction — correctly.

It is instead a signed record that names its own key, exactly as `Amendment`
does, and converts into the ordinary ROSTER_AMEND move that `amendmentMove`
already builds (`records.ts:505`):

```ts
// tag: tessera/claim/1
export interface Claim { empire: number; key: MemberKey; step: number; }
export interface SignedClaim { claim: Claim; sig: string; }   // signed BY claim.key
```

The difference from an amendment is the whole point: an amendment needs a
quorum of the empire's existing seats, and **a vacant empire has no seats to
ask**. Zero endorsements is not a weakening of the quorum rule; it is the
quorum rule evaluated on an empty set.

What stops a claim being forged is that it is signed by the key it seats, and
what stops it being abused is that a vacancy can be claimed once.

### Races cost nothing

Two strangers claiming empire 5 on the same step are resolved by machinery
that already exists. `seatArrivals` sorts everything booked on a step by key
before applying it — "key order, so two amendments landing on one step are
applied in the same order by everyone" (`lockstep.ts:1071`) — and calls
`sim.validate` per move, skipping what it refuses (`lockstep.ts:1079`). The
lower key seats; the second claim then fails `validate` because the empire is
no longer vacant, identically on every peer. No new tie-break, no new record
ordering.

## The join window closes this door

`joinWindow` from 0002 gates a human `ROSTER_AMEND`; a claim is one, so it is
gated by the same line and needs no second rule. This is what turns
`joinWindow` from a detail about substitutes into the front door's opening
hours.

## What the claimant chooses, and what they do not

They do not pick a **location**. The capital was placed at genesis from the
shared seed, before anyone knew who would sit there, and that is precisely what
makes it fair — a claimant takes the ground the map gave that empire, not the
best ground still going.

They do pick a **name** (0012), and they pick **which vacancy** — which, once
0013 lands, is the same thing as picking a house. A vacancy is not "empire 5";
it is *Sping, unclaimed*, with its flag and its colours fixed in the genesis
record before anybody arrived. That is what makes a vacancy worth advertising
rather than merely available: a player joins the game that still has theirs
open.

The banner is not the claimant's to change. It was sealed with the record, so
every peer draws the same board — but they chose it by choosing which empire to
claim, which is the same freedom arriving through the only door that keeps
everyone's screenshots comparable.

## Versioning: no bump, and the reason matters

`PROTOCOL_VERSION` stays 3 and `LAYOUT_VERSION` stays 3. The argument is not
the one 0002 makes, and the difference between them is the interesting part.

Every new branch here — the claim path in `validate`, the victory exclusions,
the shield — is reachable only in a game whose genesis has an empire with
`members: []`. **A v3 build handed such a record refuses it**, today, with no
new code: `inspectGenesis` pushes `"members"` and `adopt` fails the lobby
(`packages/net/src/lobby.ts:293`). The old build does not desync; it declines,
which is the exact outcome the version number exists to produce.

That is a design constraint, not a happy accident, and it must be honoured:
**vacancy is expressible only as an empty members array**, precisely because
that is already an error in v3. Any other encoding — a flag in `rules`, a
sentinel key — would be silently ignored by an old build, and that is the
quiet three-hours-in desync `genesis.ts:63` warns about.

Compare 0002, where `joinWindow` is a field an old build reads straight past.
Same series, opposite verdicts, for a reason that is legible in each case.

## Verification

- `packages/sim/src/test/vacancy.test.ts`:
  - a vacancy gets a capital, holds one tile, and never wins, loses or ends
    the game — a two-human + two-vacancy game plays to `endStep` normally;
  - a claim seats the key at member 0 and the shield lifts on the same step;
  - with the grant enabled, the claimant arrives holding the pocket, and a
    camper's ring outside it is a border rather than a seal;
  - **the camper scenario, end to end**: an empire walls the shield's edge for
    three days, a claim lands, and the claimant is still alive an hour later;
  - a claim at/after `joinWindow` is refused (0002's branch, exercised here);
  - a tile inside a shield is refused for CLAIM, MARCH and cascade alike;
  - grace measured from arrival: an empire claimed at step 200,000 gets its
    grace; a genesis-seated empire's is unchanged; and an empire that amends a
    new member in on day six does **not** get its capital immunity back;
  - protection ends on the time ceiling with every strength bar uncrossed, and
    ends early on each bar independently.
- `packages/net/src/test/claim.test.ts`: two peers claim empire 5 on one step
  over the harness; both peers seat the same key and both drop the other,
  hashes identical.
- **The compat test**: `inspectGenesis` on a vacancies record returns
  `["members"]` under the *current* protocol constant. This is the test that
  proves the no-bump argument rather than asserting it.
- `sim/test/crossenv` and the recorded fixture unmoved.

---

# Implementing it

## What ships

| File | Change |
|---|---|
| `packages/sim/src/types.ts` | `Rules` gains `graceSteps`, `graceTiles`, `graceCapitalPop`, `gracePopTotal`, `vacancyRadius`, `vacancyGrant`; `noobSteps`/`noobTiles` stay, deprecated |
| `packages/sim/src/constants.ts` | defaults for the six, chosen against the fixture rather than against a feeling |
| `packages/sim/src/rules.ts` | `arrivedAt`, the new `isProtected`, the vacancy ball inside `isShielded`, the claim branch above the member lookup in both `validate` and `applyMove`, the grant |
| `packages/sim/src/state.ts` | a derived `shielded` count layer, built with the state and rebuilt in `restore`; **no change to the snapshot encoding** |
| `packages/sim/src/victory.ts` | unclaimed empires excluded from `alive`, `present` and `leader` |
| `packages/protocol/src/genesis.ts` | `members: []` allowed for `CONTROL.HUMAN`, still refused for a SimBot empire and still refused if no empire has members |
| `packages/protocol/src/records.ts` | `TAG_CLAIM`, `Claim`, `SignedClaim`, `encodeClaim`, `signClaim`, `verifyClaim`, `claimMove` |
| `packages/protocol/src/wire.ts` | `FRAME.CLAIM` and one case beside `FRAME.AMENDMENT` at `wire.ts:212` |
| `packages/net/src/lockstep.ts` | `claim()`, `onClaim`, `considerClaim`, the still-vacant guard inside `seatArrivals`, the step window |
| `packages/net/src/archive.ts` | `ArchivedGame.claims`, `ARCHIVE_FORMAT` 1 → 2, and one merged replay order shared with the driver |
| `packages/net/src/teams.ts`, `lobby.ts` | a plan may ask for vacancies; `checkPlan` stops calling one an error |
| `packages/net/src/test/harness.ts` | `TableOptions.vacancies`, so a net test can seat a claimant |
| `apps/web/src/view/Renderer.ts` | the shield is drawn, because an invisible no-go zone is a trap rather than a rule |

## The lead finding: races do **not** cost nothing

The body's tidiest paragraph is the one that is wrong. "The lower key seats; the
second claim then fails `validate` because the empire is no longer vacant,
identically on every peer" — it does not, and the reason is the same reason the
claim record has to exist at all.

**A claim and an amendment produce the same move.** `amendmentMove` builds
`{ type: MOVE.ROSTER_AMEND, x: kind, y: 0 }` (`records.ts:505`), and the only
thing the sim reads out of it is the new member's kind. Nothing in the move says
whether a quorum endorsed it or nobody did, because the sim addresses members by
index and knows nothing about keys — which is the property the whole design rests
on. So when `seatArrivals` reaches the second claim for empire 5, the sim is
asked `validate` and answers with the ROSTER_AMEND branch at `rules.ts:263`:

```ts
if (move.type === MOVE.ROSTER_AMEND) {
  return empire.members.length < Math.min(rules.maxSeats, SEAT_CEILING);
}
```

The empire now has one member and `maxSeats` is 4. It returns **true**. The
second claimant seats as member 1 of the empire the first claimant took thirty
milliseconds ago, sharing their territory and their capital, with no quorum, no
endorsement, and nobody asked. That is not a lost race; it is the exact failure
`amend()` spends forty lines of comment preventing (`lockstep.ts:889-897`).

It cannot be fixed in the sim, and it should not be. A `MOVE.CLAIM_EMPIRE`
distinct from `MOVE.ROSTER_AMEND` would move the hash, would need a protocol
bump, and would put an authorisation concept inside the one layer that has no
business holding one. The fix belongs where the authorisation already lives:

```ts
booked.forEach((record, i) => {
  const { empire, key, kind } = entry(record);
  if (this.roster.has(key)) return;
  // A claim authorises seating an *empty* empire and nothing else. The sim
  // cannot tell the two records apart — a ROSTER_AMEND is a ROSTER_AMEND — so
  // the difference is enforced here, against the roster as it stands at this
  // point in this loop. Two claims for one empire on one step therefore resolve
  // the way the body says they do, rather than the way the sim would.
  if (isClaim(record) && this.roster.size(empire) > 0) return;
  const move = amendmentMove(...);
  ...
});
```

Evaluated inside the loop, against a roster the loop is mutating, over a list
every peer sorted the same way (`lockstep.ts:1071`). It is deterministic for the
same reason the sort is, and it needs no new tie-break — the body's claim,
restored, by putting it in the layer that can actually make it true.

Three further lines say the same thing from other directions, and all three have
to be answered rather than inherited:

- `Roster.quorum` of a vacant empire is **1**, not 0: `Math.floor(0 / 2) + 1`
  (`roster.ts:84`). "Zero endorsements is the quorum rule evaluated on an empty
  set" is a nice sentence about a function that returns one.
- `tallyAmendment` refuses a vacant empire outright — `if
  (roster.membersOf(...).length === 0) return nothing` (`records.ts:472`) — and
  `verifyAmendment` requires `tally.needed > 0`. The amendment path was
  deliberately closed against exactly this record.
- `verifyArchive` verifies every stored amendment through that same function
  (`archive.ts:259`), so an archive of a claimed game reports `amendment for
  empire 5 lacks a quorum` and 0008's leaderboard declines to count it.

So `verifyClaim` is a **separate** function beside `verifyAmendment`, not a
loosening of it, and the two verification paths stay apart on purpose. What they
share is the move they produce and the order they produce it in.

## Eleven things the body assumes that the code does not do

1. **`applyMove` crashes before `validate` gets a chance.** The body notes the
   lookup in `validate` (`rules.ts:256`) and stops there. `applyMove` opens with
   `const member = empire.members[move.member]!` and immediately calls `bump(empire,
   member, STAT.MOVES)` (`rules.ts:327-331`). A non-null assertion over an empty
   array is a thrown `TypeError` inside `advance`, on every peer, at the same
   step. Both functions need the claim branch lifted above the lookup, and the
   `bump` needs an empire-only form — the moving member does not exist yet.

2. **`arrivedAt` of a vacancy is a minimum over an empty set.** The body defines
   it as "the minimum `joinedAt` across its members" and never says what an
   empire with no members returns. It has to be `state.step`: an empire that has
   not arrived arrives now. That keeps `since` at 0, keeps every strength bar
   uncrossed at one tile and one population, and therefore makes an unclaimed
   capital `isProtected` for as long as it is unclaimed — a second lock behind
   the radius, holding even at `vacancyRadius: 0`. Write it as the definition,
   not as a fallback, because it is the one value that makes the derivation total.

3. **`checkPlan` already calls this an error.** `teams.ts:78`: `if
   (plan.empires.some((keys) => keys.length === 0)) return "an empire has no
   members"`. And `Plan.empires` is `MemberKey[][]` (`teams.ts:56`), a shape in
   which a vacancy is indistinguishable from a mistake. A plan needs to *ask*
   for vacancies — `vacancies: number` beside `simbots` — so that an empty array
   stays the error it is and a vacancy stays a decision somebody made.

4. **`verifyArchive` will call a claimed game corrupt, and then get the roster
   wrong.** Beyond the quorum refusal above: claims and amendments must reach the
   roster in the order the live game applied them, or `roster.amend` assigns a
   different member index than the driver did and every subsequent move signed by
   that seat fails `keyOf` attribution — a fragment-sized problem reported as a
   hash mismatch. One merged order, `(step, key)`, shared between `seatArrivals`
   and `verifyArchive`, exported from one place so the two cannot drift.

5. **`ARCHIVE_FORMAT` moves, and the body does not mention it.** An archive
   written by a build that does not know about `claims` replays to a smaller
   roster and a different hash, silently — which is the failure mode `genesis.ts`
   spends its header warning about, arriving through the archive rather than the
   wire. `ARCHIVE_FORMAT` goes 1 → 2 (`archive.ts:25`), and a v1 archive of a
   game with vacancies is refused rather than replayed.

6. **A claim names its own step; an amendment does not.** `amend()` computes
   `step = this.sim.step + AMENDMENT_DELAY` from its own clock (`lockstep.ts:904`),
   so the step is the proposer's honest local answer. `Claim.step` arrives from a
   stranger, and `accept()` books whatever step it is handed (`lockstep.ts:1010`).
   A claim naming step 40,000,000 sits in `seating` forever; one naming
   `sim.step + 1` gives no peer time to hear it. Bound it on receipt: strictly
   greater than `sim.step`, no further than `sim.step + AMENDMENT_DELAY * 2`, and
   refuse rather than clamp — a clamped step is a different record from the one
   that was signed.

7. **A claim gets no hold.** `hold()` lowers the readiness ceiling from
   `this.amendments` — proposals still undecided (`lockstep.ts:1027-1033`). A
   claim is decided the instant its one signature verifies, so it goes straight
   to `accept()` and never raises a ceiling anywhere. A peer that has not received
   it by the time it simulates that step takes the `step <= this.sim.step` branch,
   counts a desync and requests a snapshot (`lockstep.ts:959-967`). That is a
   real recovery path and it is the existing one for an instantly-carried
   amendment too — but it is now reachable by an ordinary event rather than a
   rare one. Either a claim holds the ceiling from receipt to its step, or
   `AMENDMENT_DELAY` is the entire safety margin and the plan says so out loud.
   Prefer the hold: it costs three seconds of latency and removes a snapshot
   round-trip from the common path of arriving at a game.

8. **There is no `CLAIM` frame.** `FRAME` (`wire.ts:25-39`) has no entry, so
   `decodeFrame` returns `null` and a claim never crosses the wire — correctly,
   and invisibly. One member of the union and one case beside `FRAME.AMENDMENT`
   at `wire.ts:212`, sharing the same `isObject(parsed.signed)` check, because
   field-level checking belongs to the verifier that re-derives the payload.

9. **`isProtected` is exported and drawn.** `Renderer.ts:192` puts
   `is-protected` on the tile and `Controls.ts:102` shows a `protected` tag.
   Changing what the function means changes both without anybody editing them.
   Separately: the *shield* is a different thing and nothing draws it at all. A
   421-tile region where every click silently fails is not a rule players can
   play around; it is a bug they will report. It ships drawn or it does not ship.

10. **`arena()` parks capitals two tiles apart.** `testkit.ts:52`: `idx(e.id * 2,
    0, s.width)` on a 24×24 board. At `vacancyRadius: 14`, one vacancy shields
    the entire arena and every rules test that touches one fails for a reason
    that has nothing to do with what it is testing. Sim tests set the radius
    explicitly; the fixture must never inherit the default.

11. **`PROTOCOL_VERSION` is not 3 by the time this lands.** 0002 moves it to 4 and
    gates `joinWindow` on `protocol >= 4` (`0002-durations.md:349`). See below —
    the argument survives, the sentence does not.

## The shield is one line, not three

The body's table lists three places a shield has to be enforced: `claim`, `march`
and cascade. It is one, and finding that out is the best news in this plan.

**Every ownership change in the game goes through `place`** (`rules.ts:67`), and
`place` already asks `isShielded` on its second line (`rules.ts:76`). A claim
reaches it through `land`; a march reaches it twice, through `land` for the gap
tile and `place` for the target; a cascade reaches it once per tile it touches.
`marchVia` asks separately about the route (`rules.ts:208`), which means a shield
also blocks a march *through* a pocket rather than only into one — a rule nobody
had to write.

So the vacancy ball goes inside `isShielded`, above the `empire.capital !== i`
short-circuit, and all four routes are closed by construction. There is no third
code path to keep in step with the other two, which is the kind of thing worth
noticing before writing the other two.

Two consequences follow.

**It has to be O(1).** `isShielded` runs once per tile a cascade touches, up to
`cascadeTileCap`, so it cannot scan the empire list. A derived `shielded`
`Uint8Array` — one entry per tile, holding *how many* unclaimed capitals cover
it — is built alongside the state and rebuilt in `restore` from `empires[].capital`
and `members.length`, both of which the snapshot already carries. It is never
serialised, so the body's promise that nothing changes in the snapshot encoding
holds exactly. On a claim, walk that empire's ball once and decrement.

A **count** rather than a flag is also what makes the body's overlap rule true
without any special handling: a tile inside two shields is at 2, one claim
brings it to 1, and it is still protected — "protected until both are claimed",
falling out of the data structure rather than being enforced on top of it.

**Terrain is not ownership.** `PLACE_BRIDGE` and `PLACE_LADDER` change
`state.terrain` and never call `place`, so a camper can ladder the walls and
bridge the rivers inside a pocket days before anyone claims it, reshaping the
ground an arrival is promised. It is a smaller exploit than the wall, and it is
one the shield as designed does not touch. Either the two `PLACE_*` branches gain
the same check, or the plan says why a pre-opened pocket is acceptable.

## Radius 14 is a quarter of the map

`ballSize(r) = 2r² + 2r + 1` (`geometry.ts:33`). At 14 that is **421 tiles**.
`DEFAULT_MAP` is 96 × 64 = 6144 (`constants.ts`). A game composed with four
vacancies — an unremarkable thing to want, and exactly what 0009's proposal
screen makes easy — closes **1,684 tiles, 27% of the board**, from step zero, to
every player who turned up on time, for as long as the vacancies stand. If the
join window is a third of a ten-day game, that is three days.

The body sets the radius from the camper's side of the ledger: 14 costs an
attacker a ring of ~56 tiles held against upkeep. It is the right calculation
about the wrong person. The camper is hypothetical and the four players staring
at a quarter of the map they cannot enter are not.

The grant makes it sharper rather than softer. Every passable neutral tile
inside the ball becomes the claimant's, so an arrival at radius 14 is handed 421
tiles — **ten times `noobTiles`** — in one move, on day three, against players who
took three days to build forty. That is not "a border to push from"; on the
default map it is the largest empire in the game.

The recommendation, stated as a verdict because it is one:

> **Default `vacancyRadius: 6.** 85 tiles granted, a ring of 24 to wall, and 5.5%
> of the default map held per vacancy. Ship the shield at 6 with the grant, and
> let the camper scenario — measured, in the test the body already asks for —
> argue it upward. A radius tuned against how much ground an empire holds by day
> three is the right instinct; the number it produces has to be paid by the
> people already playing, and 14 is not a number they would agree to.

One more thing the body half-says. `placeCapitals` separates capitals by `dist2`
— Euclidean squared (`mapgen.ts:180`) — while the ball is von Neumann, "because
that is what `COIN_RADIUS` already means here". Those two metrics disagree by up
to √2, and they disagree *by angle*: two capitals 20 tiles apart diagonally are
28 apart in Manhattan and do not overlap at 14, while two 20 apart along an axis
are 20 apart in Manhattan and overlap by four tiles in every row. So overlap at
radius 14 is not the rare accident the body treats it as; it is a function of
where the RNG put them. The count layer makes overlap *correct*. Nothing makes
it *fair*, and the honest fix is a radius small enough that it does not happen.

## The version numbers, all three

The body's argument is right and its sentence is out of date. Restated against
what will actually be true when this branch opens:

**`PROTOCOL_VERSION` does not move — and it will read 4, not 3.** 0002 bumps it
and gates `joinWindow` on `protocol >= 4` (`0002-durations.md:349`). The argument
does not depend on the number, which is the point of it: a build older than this
one, handed a vacancies record, refuses it at `genesis.ts:91` with `"members"`,
today, with no new code. It declines rather than desyncing, which is the exact
outcome a version bump exists to produce, so the bump would be paying for an
outcome already delivered. Say "the current constant" and let 0002 own the number.

**`LAYOUT_VERSION` does not move**, and the shield layer is why the sentence is
worth keeping: it is derived, rebuilt in `restore`, and never written. Had it
been stored, this line would read the other way.

**`ARCHIVE_FORMAT` does move, 1 → 2.** An archive is the one artefact where an
old reader neither refuses nor desyncs — it replays a claimed game against a
roster missing a seat, produces a wrong hash, and reports it as corruption
somewhere else entirely. The format number is what turns that into a refusal.

Three artefacts, three verdicts, and each is legible from what an old reader
would otherwise do. That is the same test 0002 applies and it happens to give a
different answer here, which is the argument working rather than failing.

## The order that has to be exactly right

`seatArrivals` and `verifyArchive` must agree, to the member index, on the order
seats appear.

Live, per step: everything booked on that step, sorted by key
(`lockstep.ts:1071-1074`), each asked of `sim.validate` and skipped if refused.
In the archive: one flat array, iterated in whatever order it was stored
(`archive.ts:258`).

With claims in a second array these diverge the moment a claim and an amendment
land on the same step, and the divergence is a different member index, and a
different member index is a `keyOf` miss on every later move that seat signed.

So it is one exported comparator and one exported merge, used by both:

```ts
/** The one order seats appear in, live and on replay. Step first because a
 *  seating is booked onto a step; key within a step because that is the only
 *  field two records landing together are guaranteed to differ on — the same
 *  reason seatArrivals has always sorted by it. */
export function seatingOrder(a: Seating, b: Seating): number;
```

The test is not that each side is correct. It is that a recorded game containing
both, replayed through `verifyArchive`, produces the hash the driver produced —
which is the only assertion that can fail if they drift.

## Order of work

Each step leaves the tree green, and the first five are invisible without a
vacancy in a genesis record — which is what lets them land before anything can
produce one.

| # | Step | Files | Green because |
|---|---|---|---|
| 1 | `arrivedAt` and the new `isProtected` | `sim/rules.ts`, `types.ts`, `constants.ts` | no existing record has an empire whose members all joined after step 0, so `arrivedAt` is 0 everywhere and the shape reduces to today's |
| 2 | Victory exclusions | `sim/victory.ts` | no empire has `members: []` yet, so no filter changes |
| 3 | The `shielded` layer, built and restored, read by `isShielded` | `sim/state.ts`, `rules.ts` | with no vacancy the layer is all zeroes |
| 4 | The claim branch above the member lookup, in `validate` **and** `applyMove` | `sim/rules.ts` | unreachable without an empty empire |
| 5 | `inspectGenesis` allows `members: []` for `CONTROL.HUMAN` | `protocol/genesis.ts` | strictly a loosening; the SimBot and no-empires-at-all refusals stay |
| 6 | `Claim`, `SignedClaim`, `TAG_CLAIM`, `verifyClaim`, `claimMove`; `FRAME.CLAIM` | `protocol/records.ts`, `wire.ts` | additive; nothing sends one yet |
| 7 | `seatingOrder`, and `seatArrivals` moved onto it with the still-vacant guard | `net/lockstep.ts` | same order it already used, now named |
| 8 | `Lockstep.claim()`, `considerClaim`, the step window, the hold | `net/lockstep.ts` | new entry point, no existing caller |
| 9 | `ArchivedGame.claims`, `ARCHIVE_FORMAT` 2, replay on `seatingOrder` | `net/archive.ts` | a v1 archive has no claims and replays as before |
| 10 | `Plan.vacancies`, `checkPlan`, `HostPlan` | `net/teams.ts`, `lobby.ts` | a plan asking for zero vacancies is today's plan |
| 11 | The shield drawn; a vacancy legible in the roster | `web/Renderer.ts`, `Controls.ts` | UI only |
| 12 | The grant | `sim/rules.ts`, `constants.ts` | last on purpose — see below |

**Step 12 is last and separable, as the body says.** But the body's reason
("ship the shield first, add the grant when the radius alone proves
insufficient") understates it: the grant is the only part of this plan that
creates hashed state out of a claim, so it is the only part whose bugs are
desyncs rather than refusals. It also cannot be tuned before step 11 exists,
because "is 85 tiles a fair arrival on day three" is a question you answer by
looking at the board.

**On 0009.** The index has 0009 before 0010 and 0009's proposal already carries
`vacancies: number`, so step 10 is either a two-line addition to a `Proposal`
that exists or the whole `Plan` change above, depending on which branch lands
first. Nothing else here depends on 0009 — and nothing in 0009 depends on this —
so the two can be built in either order and the loser of the race writes step 10.

**On 0002.** `joinWindow` does not exist yet (nothing in `packages/` mentions
it). The body is right that a claim needs no second rule because it is a
ROSTER_AMEND and 0002 gates those in `validate` — but until 0002 lands, **a
vacancy can be claimed on the last day of a ten-day game**. If 0010 ships first,
say that in the release note rather than leaving it to be discovered.

## Docs

The header comments in this codebase carry the arguments, so these are part of
the change rather than a pass afterwards.

| File | What has to change |
|---|---|
| `sim/rules.ts:17-31` | `isProtected`'s one-line comment describes the OR it no longer is. Replace with the ceiling-and-bars reading, and say why the time bound sits outside the disjunction |
| `sim/rules.ts:33-48` | `isShielded`'s comment argues about capitals falling to claims. It now also holds a ball around empires nobody has arrived at — a different rule sharing a function, and the comment has to hold both |
| `sim/rules.ts:378-381` | "Quorum of signatures is verified by the net layer before the move reaches the sim" is now half true: a claim carries no quorum and the net layer verifies something else. Name both |
| `sim/victory.ts:1-8` | the header explains presence-from-the-log. Add why an unclaimed empire is outside every count — it is territory, and territory does not go quiet |
| `sim/state.ts` | the `shielded` layer needs its own note saying it is derived, rebuilt in `restore`, and deliberately absent from `snapshot` |
| `protocol/genesis.ts:82-88` | the seat-cap comment explains why genesis is checked here as well as on amendments. The floor now differs from the ceiling and the reason is worth one sentence |
| `protocol/roster.ts:79-84` | `quorum`'s "a single-member empire is its own quorum" needs the next line: a zero-member empire is not, which is why claims verify elsewhere |
| `protocol/records.ts:462-472` | `tallyAmendment`'s vacant-empire guard is now load-bearing in a way it was not written to be. Say that it is deliberate and that `verifyClaim` is the other door |
| `net/lockstep.ts:1062-1071` | `seatArrivals`' key-order comment gains the claim case: why the guard is inside the loop, and why the sim cannot make this decision |
| `net/archive.ts:25` | `ARCHIVE_FORMAT` gains the note on what 1 → 2 refuses and why an archive is the one place an old reader would neither refuse nor desync |
| `net/teams.ts:74-93` | `checkPlan` loses "an empire has no members" as an unconditional error; the comment has to distinguish a vacancy asked for from an empire composed wrong |
| `docs/` | the rules reference gains the shield, the grant and grace-from-arrival — a player who cannot see why a click failed is owed the rule in prose |

## Verification, mapped to files

| Claim | Where |
|---|---|
| A vacancy gets a capital, holds one tile, and never wins, loses or ends the game | `sim/test/vacancy.test.ts` |
| Two humans + two vacancies plays to `endStep` and ends on `TIMEOUT`, not `LAST_EMPIRE` | `sim/test/vacancy.test.ts` |
| Every claimed empire eliminated, only vacancies left → `end(state, 0, LAST_EMPIRE)` | `sim/test/vacancy.test.ts` |
| A vacancy is never `leader()`, even holding more tiles than a dying empire | `sim/test/vacancy.test.ts` |
| A claim seats the key at member 0 and the shield lifts on the same step | `sim/test/vacancy.test.ts` |
| A tile inside a shield is refused for CLAIM, for MARCH, for a march *route*, and for a cascade sweeping across it — all four through `place`/`marchVia`, no fifth path | `sim/test/vacancy.test.ts` |
| Overlapping shields: a tile in two balls stays protected after one claim, opens after the second | `sim/test/vacancy.test.ts` |
| The shield layer round-trips: `restore(snapshot(s))` rebuilds it, and the snapshot's byte length is unchanged | `sim/test/vacancy.test.ts` |
| `applyMove` on a claim into an empty empire does not throw | `sim/test/vacancy.test.ts` |
| Grace from arrival: claimed at step 200,000 gets its grace; genesis-seated is unchanged; an empire that amends a member in on day six does **not** get capital immunity back | `sim/test/rules.test.ts` |
| Protection ends on the time ceiling with every bar uncrossed, and early on each bar independently | `sim/test/rules.test.ts` |
| **The migration test**: the recorded fixture's hash is unmoved after steps 1–5 | `sim/test/crossenv.test.ts`, unedited |
| **The default test**: on the default rules a genesis-seated empire still crosses the tile bar before either population bar — the claim the two new defaults rest on, measured | `sim/test/rules.test.ts` |
| The camper, end to end: a wall one tile outside the shield for three days, a claim lands, the claimant is alive an hour later | `sim/test/vacancy.test.ts`, slow |
| A claim at/after `joinWindow` is refused | `sim/test/vacancy.test.ts` — **only once 0002 has landed** |
| Two peers claim empire 5 on one step: both seat the same key, both refuse the other, hashes identical | `net/test/claim.test.ts` |
| The second claimant is refused as a *claim* and does not arrive as a member — the lead finding, asserted | `net/test/claim.test.ts` |
| A claim naming a step in the past, or too far ahead, is refused and never booked | `net/test/claim.test.ts` |
| A forged claim — right shape, wrong signer — is refused, stored nowhere, and gossiped to nobody | `net/test/forgery.test.ts` |
| An archive of a game containing a claim **and** an amendment on the same step replays to the driver's hash | `net/test/archive.test.ts` |
| A v1 archive of a vacancies game is refused on format rather than replayed | `net/test/archive.test.ts` |
| A claimed game counts on the leaderboard, crediting the claimant's key | `net/test/rankings.test.ts` |
| **The compat test**: `inspectGenesis` on a vacancies record returns `["members"]` under the constant as it stood *before* step 5 — the no-bump argument proved rather than asserted | `protocol/test/genesis.test.ts`, pinned |
| `decodeFrame` returns `null` for a malformed claim frame and never throws | `protocol/test/wire.test.ts` |
| An observer peer can claim, and is playing on the next step | `net/test/claim.test.ts` via `TableOptions.vacancies` |

## What came out differently, and what the open questions turned into

Written after building it. The appendix above was right about almost everything
it audited; these are the places the tree answered back.

**The pop bars are 60 and 400, and the default test is what chose them.** Open
question 3 said the plan had "a hole in it shaped like two integers", and the
hole is filled by the test it asked for: on the default rules an empire grown one
population per tile crosses the **tile** bar first, exactly as it does today, and
neither new bar ends protection for an ordinary genesis-seated empire. The
numbers are a consequence of that check rather than a feeling.

**`vacancyRadius` is 6, as the appendix argued and the body did not.** 85 tiles
granted, a ring of 24 to wall, 5.5% of the default map per vacancy. The verdict
paragraph won.

**Terrain inside a pocket is refused** (open question 5). `PLACE_BRIDGE` and
`PLACE_LADDER` bypass `place` and so bypass the shield, and the two-line answer
is the one that matches the rest of the rule: a camper spending three days
reshaping ground an arrival is promised is the same exploit as the wall, through
a door the shield happened not to cover. Both branches now ask the layer.

**The grant shipped with the shield, not after it.** The order of work has it
last and separable, on the grounds that it is the only part whose bugs are
desyncs rather than refusals. That reasoning is sound and the separation turned
out to be the wrong unit: lifting the shield and filling the pocket are the same
event on the same step, in one eight-line function, and splitting them would have
meant writing `claimVacancy` twice. It is rule-gated instead — `vacancyGrant: 0`
is the shield alone — which is the same option the staging was for.

**`checkPlan` needed the opposite of what the plan implies.** "A plan may ask for
vacancies" reads as loosening, and one line of it is genuinely tightening: a
vacancy is outside `alive`, so **one player plus one vacancy is one empire
standing** and `WIN.LAST_EMPIRE` fires on the first pass. The game would end
before anybody could arrive into the seat it was held open for. So a game needs
two empires *somebody is playing*, vacancies never count toward that number, and
the lobby, the host peer's flags and the web client's form all say so.

**The no-bump argument is narrower than the plan states, and the code had to be
built to fit it.** "A vacancy is an empty members array, which is already an
error, so an old build declines rather than desyncing" is true and is not
sufficient. Six new rule fields exist, and two of them — `graceCapitalPop` and
`gracePopTotal` — change `isProtected` for **any** game, not only one with a
vacancy in it. A field in `rules` is exactly the thing an older build reads
straight past, so with those two in `DEFAULT_RULES` an old peer handed an
ordinary new record would keep a capital protected that this build had stopped
protecting, and disagree about a move some hours later: the quiet desync
`genesis.ts` warns about, arriving through the one door this plan claimed was
shut.

So none of the six are defaults. `VACANCY_RULES` is a separate export that
`Lobby.host` merges in **only when the plan asks for vacancies**, which is also
the only case that puts an empty members array in the record. A game with no
vacancies composes rules byte-identical to what every build before this one
composed; a game with vacancies carries all six and is declined wholesale by
anything that would misread them. Neither build is ever left half-agreeing,
which is what the argument actually requires, and `rules.test.ts` asserts the
absence rather than trusting it.

**One latent desync fell out, and it is not about vacancies.** A newly seated
claimant beats immediately, and `blocked()` deliberately never waits on our own
seat — nobody can be waiting on themselves. So a peer could simulate past the
step its own in-flight move belonged to, broadcast the move anyway, and become
the only peer in the game that never applied it: a one-move divergence with no
bad actor and nothing in any log to explain it. `readyCeiling` already meant
"the last step we may commit to while a signature is out"; it now bounds the
simulation as well as the promise. A `readiness.test.ts` case that documented the
old divergence is inverted, which is the clearest statement of the change.

It costs one pump of latency per submitted move, and that showed up as a
flake somewhere unrelated: `gap.test.ts` asserted that a disconnected observer
falls behind the seats, and a seat that now pauses on its own signature no
longer reliably outruns an observer whose socket keeps reconnecting. The socket
is killed on every step there instead of once per chunk — which is the scenario
the test's own comment describes, "a relay that stays unreachable" — so the
precondition is a fact about a dead socket rather than a race between two kinds
of latency.

**`rankings.ts` had to learn about claims too.** `seatsByIndex` walked
`amendments` alone, so a leaderboard had no row for the one player whose key the
genesis record never named. It walks `mergeSeatings` now, like the driver and the
verifier — three callers, one comparator, which is the whole reason the
comparator is exported.

**Reachability, which the plan's file table leaves out.** Nothing in it creates or
claims a vacancy from a client, and a rule nobody can reach is not shipped: the
host peer takes `--vacancies <n>`, the web client's create form has a
seats-held-open control, and an observer with a key gets a **Take it** button on
an unclaimed row in the standings, gated on the join window.

Open questions 1 (what a vacancy is at the end of a long game), 2 (a claimant who
is dropped) and 4 (vacancy created after genesis) are all unchanged and
deliberately so — each is a rule with a hash behind it, and none is needed to
make this one work.

## What this plan does not settle

1. **What a vacancy is at the end of a long game.** The join window closes on
   day three; a vacancy nobody claimed keeps its shield, its capital and its
   ~85 tiles for the remaining seven days, unclaimable and unenterable, and the
   body has no opinion about it. Three answers are available — the shield lifts
   when the window closes and the ground becomes ordinary; the empire is
   eliminated outright; nothing changes — and the first is probably right, but
   it is a rule with a hash behind it and it needs deciding before, not after.

2. **A claimant who is dropped.** `eject` puts a seat out for the rest of the
   game (`lockstep.ts:1096`), and members are never removed from the simulation,
   so a dropped sole claimant leaves an empire with `members.length === 1`: not
   vacant, therefore unclaimable and unshielded, playing no moves, holding its
   pocket until somebody conquers it. That is defensible — an abandoned empire
   should be conquerable — but it means "a vacancy can be claimed once" is
   really "an empire can be arrived at once", which is a stronger rule than the
   body states.

3. **The two new population bars have no numbers.** `graceCapitalPop` and
   `gracePopTotal` are named, argued for, and left blank. They cannot be chosen
   from first principles; they come from the default test above, and until that
   test is written this plan has a hole in it shaped like two integers.

4. **Whether a vacancy can be created after genesis.** Everything here derives
   vacancy from a genesis record. An empire whose whole roster is dropped on day
   four is the natural second source, and it is out of scope — but 0011's
   applications and 0014's roster screen will both make it look available, so
   the answer wants writing down even if the answer is no.

5. **Terrain inside a pocket.** `PLACE_BRIDGE` and `PLACE_LADDER` bypass `place`
   and therefore bypass the shield. Whether a camper may spend three days
   reshaping the ground an arrival is promised is a real question with a
   two-line answer either way, and this plan does not pick one.
