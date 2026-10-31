# Durations

A game ends when somebody wins or when it runs out of time. This page is about
the second one, and about the trap that makes a duration three numbers rather
than one.

## The trap

`abandonWindow` defaults to three hours. When exactly one empire has moved
inside that window, [`checkVictory`](../../packages/sim/src/victory.ts) ends the
game `LAST_ROSTER` for them.

In a one-hour game that rule never fires and never needed to. In a ten-day game
it is **a losing condition for going to bed**: three teams sleep, one insomniac
is the only empire still "present", and the game is over by 03:00 without a tile
changing hands.

So a host does not get to set an ending without the abandonment rule changing
with it. That is the whole reason a duration is a function.

## One number in, three out

```ts
durationRules(hours(72)) // → { endStep, joinWindow, abandonWindow }
```

`durationRules` is the only supported way to compose a duration, and
`HostPlan.duration` takes its result rather than a `Partial<Rules>` — a general
passthrough would let a modified client set `abandonWindow: 12` and win before
anyone moved, and the same door would set `popMax` or `marchCost` to whatever
wins.

There is no enum of blessed lengths. A host who wants 47 minutes gets 47
minutes; `COMMON_DURATIONS` in the client is a dropdown, not a type.

### The abandonment window

Off, for any game with an end: `abandonWindow` is `NO_ABANDONMENT` (`0`), and
an empire may idle until the timeout. The timeout is what stops a long game
waiting for somebody who has left, so abandonment adds nothing there but a way
to lose by not opening the tab.

| duration | `abandonWindow` |
|---|---|
| any length | `0` — none |
| open (`0`) | 3 h, the floor |

An open-ended game keeps the floor, because it has nothing else to end it. That
is what `DEFAULT_RULES` has always said, so `durationRules(0)` still equals it
field for field.

This replaced a window of a third of the game, floored at 3 h and capped at
36 h. Under the cap a 10-day game could end on day three, as soon as one
empire's players were the only ones to have opened it in the last 36 hours.

A window of zero holds no heartbeat, so `present` is empty and `LAST_ROSTER`
cannot fire, under this build or any earlier one. `inspectGenesis` accepts `0`
as the one value below the floor; an older build refuses it, so an old peer
declines to join rather than desyncing, and no protocol bump is needed.

The floor is still checked in `inspectGenesis`, because
a type binds our client and not a hostile one.

### The join window

`joinWindow` is the step after which no **human** seat may be added. Bots stay
allowed — night cover, or a substitute on day six.

It is a **fraction of the game**, because "an hour" means something different in
a 15-minute game and a 10-day one. A third is the default:

| duration | share 1/5 | 1/4 | 1/3 | 1/2 |
|---|---|---|---|---|
| 15 min | 3 min | ~4 min | 5 min | ~8 min |
| 1 h | 12 min | 15 min | 20 min | 30 min |
| 3 d | ~14 h | 18 h | 24 h | 36 h |
| 10 d | 2 d | 2.5 d | ~3.3 d | 5 d |

**`0` cannot mean "closed."** Every genesis written before protocol 4 lacks the
field, and is read as 0 — so 0 has to keep meaning *always open*, or this would
retroactively seal every existing game. "No late joins" is `joinWindow: 1`: the
window shuts at step 1, and step 0 is the composition of the record itself.
`durationRules(n, 0)` writes that for you.

The window is enforced in three places, for three different reasons:

| Where | Why |
|---|---|
| `validate()` in the sim | the binding one — every peer reaches the same verdict on the same record |
| `Lockstep.considerAmendment` | liveness, not correctness: a doomed proposal would hold the table waiting for a vote whose outcome is decided |
| `LobbyPanel` | so the UI never offers a vote that would be refused |

## The version it cost

The `validate()` branch is why protocol 4 exists. A new build refuses a late
human amendment; a protocol-3 build has no such branch, does not know the field
exists, and accepts it. Both then apply the same signed log and diverge — the
silent overnight desync the version number is for.

The branch is gated on **`state.genesis.protocol`, never `PROTOCOL_VERSION`**,
which is the shape every later gated branch copies. Read against the record, the
field cannot exist in a v3 game no matter what a record claims.

The general rule this produced is worth more than the branch:

> A new check in `inspectGenesis` is safe across versions. A new branch in
> `validate()` is not.

`inspectGenesis` runs before anyone plays and its only power is refusal: two
builds that disagree end up with one of them not in the game, which is a bad
afternoon and not a corrupt one. `validate()` runs inside the hash's blast
radius, where disagreement is divergence. Checks are free; branches cost a
version — and if a rule can be expressed as a refusal at join time, it should
be.

## The ceiling

`MAX_DURATION` is **31 days**, and it is policy rather than encoding. Every
step-valued field is a `u32`, which carries 4,142 days — 133 times the cap. The
real constraint is the archive: each seat signs a heartbeat every 30 s, and
those cannot be elided from the log because `lastBeat` is hashed state. A 31-day
four-seat game is ~357,000 signed records and ~70 MB of JSON, which is what a
retaining browser tab holds in one array.

`durationRules` clamps rather than throws — a caller asking for two years gets 31
days.

The cap is deliberately **not** checked in `inspectGenesis`, and the contrast
with the abandonment floor is the whole design:

| | `abandonWindow` floor | duration ceiling |
|---|---|---|
| what a bad value does | hands the composer the win before anyone moves (`0` excepted: nobody can be present inside it) | makes that game's own archive large |
| who it hurts | everyone else at the table | the people who chose it, visibly |
| where it is checked | `inspectGenesis` — it must bind a hostile host | the composing path only |

A check in `inspectGenesis` is a promise about what this build refuses, and two
builds of the same version that disagree about it cannot play together. Weld
`MAX_DURATION` into the join path and raising it later needs a protocol bump;
leave it on the composing side and raising it is a constant. Since an over-long
game cheats nobody, the cheap answer is the correct one.

What the cap does buy is
[retirement](../concepts/the-one-invariant.md): a version's longest possible
game is fixed the moment that version stops being current, so

```
sunset(version) = release date of its successor + MAX_DURATION + slack
```

can never be invalidated by a later raise. Protocol 3 is the one exception — it
predates durations, so every v3 game is open-ended and no arithmetic bounds it,
which is why its sunset is a policy choice and why the shelf-life notice exists.

## What is still open

**A table cannot extend its own game.** The cap bounds every game that names a
length, and the host card offers no open-ended multiplayer game, so every new
game has an end. Neither reaches a game already running, and neither gives a
table enjoying itself a way to play on. The move would be a signed amendment
lengthening the game — a records design, not a rules change.

**A host can still pick a hostile length.** The floor stops `abandonWindow: 12`;
nothing stops `endStep: 13`, a game that ends four seconds after it starts and
hands the leader a win. That is visible in the record before anyone plays, and
refusing it is a judgement about what a game is *for* rather than whether it is
fair. The lobby shows the chosen length instead.
