# 0002 — Games that end: durations, the join window, abandon scaling

Status: built
Depends on: 0001 (it is this plan's bump that makes a supported set urgent)
Branch: `durations`

## The problem

`rules.endStep` exists and ends a game with `WIN.TIMEOUT`
(`packages/sim/src/victory.ts:67`), default 0 = no timeout
(`packages/sim/src/constants.ts:89`) — nothing sets it. A host who wants a
3-hour or 10-day game has no lever, and nothing stops the abandonment rule
from quietly deciding the game instead.

## The trap this plan fixes first

`abandonWindow` defaults to 3 hours (`constants.ts:87`). `victory.ts:61-63`:
`present = alive.filter(silentFor < abandonWindow)` — if exactly one team
remains present, the game ends `WIN.LAST_ROSTER` for them. In a 10-day game
that is **a losing condition for going to bed**: three teams sleep, one
insomniac wins by 03:00 without taking a tile. Durations must scale the
abandonment window with them, which is why the host sets one control, not
three.

## A duration is a step count

The primitive is `rules.endStep` — an arbitrary number of steps — and it
already exists. Nothing about this plan needs an enum of blessed lengths; a
host who wants 47 minutes should get 47 minutes. What the host must not be
allowed to do is set `endStep` **without** the other two rules moving with it,
because that is the trap above.

So the unit of the design is a function, not a vocabulary:

```ts
// packages/sim/src/duration.ts, exported from index.ts
export function durationRules(
  endStep: number,                 // 0 = open-ended, today's default
  joinShare = 1 / 3,               // 0 = closed to late joins
): Pick<Rules, "endStep" | "joinWindow" | "abandonWindow">;
```

`seconds`/`minutes`/`hours` (`packages/sim/src/constants.ts:41-43`) become
exported, so a caller says `durationRules(hours(6))` rather than doing its own
arithmetic on `STEPS_PER_SECOND`. Steps are wall time (`targetStep()` derives
from `genesis.startedAt`), so those are real hours.

### The two derived rules

```ts
joinWindow    = joinShare === 0 ? 1 : Math.round(endStep * joinShare);
abandonWindow = clamp(Math.round(endStep / 3), hours(3), hours(36));
```

**`abandonWindow` is a third of the game, floored at 3 h and capped at 36 h.**
That formula is not invented here — it reproduces the hand-written table this
section used to contain, exactly:

| duration | `endStep`/3 | after clamp | matches the old preset |
|---|---|---|---|
| 15 min | 5 min | 3 h | never fires, as `3h` did |
| 1 h | 20 min | 3 h | never fires |
| 6 h | 2 h | 3 h | never fires |
| 1 d | 8 h | 8 h | 8 h |
| 3 d | 24 h | 24 h | 24 h |
| 10 d | 80 h | **36 h** | 36 h |
| open (`0`) | 0 | 3 h | today's `DEFAULT_RULES` value |

The floor is what makes short games safe — under about nine hours the
abandonment rule simply never decides anything, which is correct: nobody goes
to bed inside a 15-minute game, and the rule exists for the ones where they
do. The cap is what makes ten-day games safe in the other direction: a third
of 240 hours is a window nothing could ever fire inside, and a table that has
genuinely stopped playing should end.

The open-ended case needs no special case at all — `0/3` clamps to the 3 h
floor, which is exactly `DEFAULT_RULES.abandonWindow` (`constants.ts:87`).

### `joinShare`, and the sentinel that is already taken

The join window is a **fraction of the game**, because "an hour" means
something different in a 15-minute game and a 10-day one:

| duration | share 1/5 | 1/4 | 1/3 | 1/2 |
|---|---|---|---|---|
| 15 min | 3 min | ~4 min | 5 min | ~8 min |
| 1 h | 12 min | 15 min | 20 min | 30 min |
| 3 d | ~14 h | 18 h | 24 h | 36 h |
| 10 d | 2 d | 2.5 d | ~3.3 d | 5 d |

A third is the default because it is the one that reads right at both ends of
that table. A host who wants the door open half the game passes `1/2`; one who
wants a sealed table passes `0`.

**`0` cannot be the closed sentinel.** `rules.joinWindow` is absent from every
genesis written so far, so the enforcement below reads `rules.joinWindow ?? 0`
and 0 has to keep meaning *always open* — otherwise this plan retroactively
closes every existing game. "No late joins" is therefore `joinWindow: 1`: the
window shuts at step 1, and step 0 is the composition of the record itself.
That is not a hack so much as the honest reading of a half-open interval, and
`durationRules` writes it for you so no caller has to know.

### Presets are a UI list, not a type

The old `type Duration = "3h" | "1d" | …` is deleted. What replaces it is a
suggestion list living beside the picker in `apps/web`, not in the sim:

```ts
export const COMMON_DURATIONS: ReadonlyArray<{ label: string; steps: number }> = [
  { label: "15 minutes", steps: minutes(15) },
  { label: "30 minutes", steps: minutes(30) },
  { label: "1 hour", steps: hours(1) },
  { label: "3 hours", steps: hours(3) },
  { label: "6 hours", steps: hours(6) },
  { label: "3 days", steps: hours(72) },
  { label: "5 days", steps: hours(120) },
  { label: "10 days", steps: hours(240) },
  { label: "open-ended", steps: 0 },
];
```

A dropdown of these plus a free-entry field, and the listing row (0007) says
"3 days" by reading the number back out — the same way `Duration` would have,
without a closed set anybody has to extend to add 45 minutes.

What lands in the genesis is only ever `endStep`, `joinWindow` and
`abandonWindow`: three numbers. "This was a 3-day game" stays a fact of the
record the way bot difficulty already is (`packages/sim/src/specs.ts:126`) —
it is just derived from a step count rather than named by an enum member.

## joinWindow

New rule: steps after which no **human** seat may be added; 0 = always open.
Bot seats stay allowed (night cover or a substitute on day six).

It gates one thing today — being voted onto an existing team — and a
second thing once 0010 lands: claiming a vacant empire is a human
`ROSTER_AMEND` and is stopped by this same line, with no second rule. That
is what turns `joinWindow` from a detail about substitutes into the front
door's opening hours, and it is why it is derived as a share of the game
rather than given a token value.

Enforced beside the seat cap in `validate()` — `packages/sim/src/rules.ts:265`,
the ROSTER_AMEND branch that reads `rules.maxSeats`:

```ts
if (move.type === MOVE.ROSTER_AMEND) {
  const window = rules.joinWindow ?? 0;   // ?? 0: old genesis records lack the field
  if (window > 0 && move.step >= window && move.x !== MEMBER.BOT) return false;
  return empire.members.length < Math.min(rules.maxSeats, SEAT_CEILING);
}
```

(`move.x` is what the application at `rules.ts:378` already reads to choose
`MEMBER.BOT` vs `MEMBER.HUMAN` — validation reads the same field.)

Belt and braces, outside the sim: `Lockstep.considerAmendment` refuses a
would-be-human amendment past the window early, and `LobbyPanel` hides the
invite button — so the UI never offers a vote that would die in `advance`.

## Hash safety — the argument

`snapshot()` encodes **no rules** (verified at `packages/sim/src/state.ts:102-138`:
MAGIC, LAYOUT_VERSION, board, rng, events, empire/member stats — nothing
from `rules`). The new branch is inert while `joinWindow` is 0, which every
existing record leaves it. `abandonWindow`/`endStep` are already fields of
`Rules` and already read by `victory.ts` — setting them changes outcomes only
from the step a host chooses, never the encoding.

So `LAYOUT_VERSION` stays 3, and **`sim/test/crossenv` and the recorded game
are the proof** — if that suite moves, the change was not neutral.

## The question that argument does not answer

Hash safety is about *encoding*. `PROTOCOL_VERSION` is about two builds
agreeing on `validate()`, and this plan adds a `validate()` branch:

- a new build refuses a human `ROSTER_AMEND` past the window;
- a v3 build has no such branch, does not know the field exists, and accepts
  it.

Both then apply the same signed log and diverge — which is precisely the
failure `packages/protocol/src/genesis.ts:63` says the version number exists
to prevent: "a peer that joins across a major boundary does not fail, it
desyncs quietly three hours in." The `?? 0` fallback protects *old records*
from new builds; nothing here protects *old builds* from new records, because
`joinWindow` is a field they read straight past.

Contrast 0010, whose new branches are reachable only through a genesis an old
build already refuses at `inspectGenesis`. Same series, opposite verdicts, and
the difference is whether the marker is invisible to v3 or already an error in
it.

Three options, and this plan does not get to duck the choice:

1. **Bump to `PROTOCOL_VERSION = 4`** — correct, and consistent with the
   codebase's stated stance of refusing at the lobby rather than desyncing
   later. It costs the fixture: `new Sim(recorded.genesis)` throws on mismatch
   (`packages/sim/src/sim.ts:52`), so `recorded.json` must be re-stamped —
   after proving the hash unchanged under v3, so the tripwire's continuity is
   demonstrated rather than lost.
2. **Do not bump** — the exposure is bounded (a stale client, in a duration
   game, on a human amendment past the window) but it is the silent divergence
   this design argues hardest against.
3. **Enforce outside the sim only** — `Lockstep.considerAmendment` and
   `LobbyPanel`, leaving `validate()` untouched. Zero consensus risk, ships
   immediately, and the rule is then advisory rather than binding on a hostile
   client.

**Recommended: (1).** Re-recording a fixture is an hour; an unfindable desync
is not. The bump is only survivable because 0001 lands first: without a
supported set, moving the number kills every game in flight and makes every
archive ever written unverifiable — and this is the plan that makes games long
enough for that to happen.

## HostPlan passthrough

`HostPlan` (`packages/net/src/lobby.ts:67`) gains `rules?: Partial<Rules>` —
the test harness already proves the plumbing shape (`options.rules` flows into
`makeGenesis`, `packages/net/src/test/harness.ts:97-100`). The web host panel
gains one dropdown (0008) feeding `durationRules()` into it.

## Verification

- `packages/sim/src/test/duration.test.ts`:
  - `durationRules` over the table above: every clamp boundary, `0` in and
    3 h out, and `joinShare: 0` producing `1` rather than `0`;
  - an arbitrary length round-trips — `durationRules(minutes(47))` is a
    47-minute game, no preset involved;
  - a game ends at `endStep` with `WIN.TIMEOUT`, winner = current leader;
  - a human ROSTER_AMEND at/after `joinWindow` is refused by `validate`, a
    bot one is accepted;
  - with `endStep: 0`, silence past `abandonWindow` still ends
    `WIN.LAST_ROSTER` (today's behaviour preserved);
  - with a scaled window, a silent-but-alive table does **not** end
    overnight — the trap's regression test;
  - a genesis with no `joinWindow` field behaves as 0 (old records).
- `sim/test/crossenv` + the recorded fixture pass byte-identical — the
  hash-neutrality claim, checked.

---

# Implementing it

## The verdict, taken

Option (1). The rest of this section assumes `PROTOCOL_VERSION = 4` and
`SUPPORTED_PROTOCOLS = [4, 3]`, which is only affordable because 0001 shipped
first — and which, in return, gives 0001 the thing it could not have: a real
second version, and the first gated branch.

The work splits four ways, and only the second part is delicate:

| Part | Where | Risk |
|---|---|---|
| `durationRules` and the `joinWindow` field | `sim`, new file + two lines | none: pure arithmetic, nothing reads it yet |
| The `validate()` branch and the bump | `sim` | the whole plan's risk, and it is a *gate*, not a field |
| Enforcement outside the sim | `net` | none: advisory by construction |
| The dropdown | `web` | none |

## The field is optional, and `DEFAULT_RULES` does not move

`packages/sim/src/types.ts:110`, beside `endStep`:

```ts
/** Steps after which no human seat may be added; absent or 0 = always open.
 *  Optional because every genesis written before v4 lacks it, and reading it
 *  as 0 is what keeps those games playable rather than retroactively sealed. */
joinWindow?: number;
```

Optional rather than required-and-defaulted, so `DEFAULT_RULES`
(`packages/sim/src/constants.ts:45`) is **not touched at all**. A game composed
with no duration therefore produces a genesis byte-identical to what today's
build composes — same `canonicalJson`, same `gameIdOf`, same everything. That
is worth more than the tidiness of a required field: it means the only records
carrying `joinWindow` are the ones a host deliberately asked for.

`seconds`, `minutes` and `hours` (`constants.ts:41-43`) gain `export`. They stay
in `constants.ts` rather than moving to `duration.ts`, because `DEFAULT_RULES`
uses them three lines later and moving them would put a cycle between the two
files for no gain.

## `packages/sim/src/duration.ts`

```ts
// How long a game runs, and the two windows that have to move with it.
//
// One function rather than an enum of blessed lengths: a host who wants 47
// minutes gets 47 minutes. What a host must not be able to do is set an end
// without the abandonment window scaling to match, because a 3-hour window in
// a 10-day game is a losing condition for going to bed.

import { days, hours } from "./constants.js";
import type { Rules } from "./types.js";

/** The three numbers a duration decides. Nothing else about a game changes. */
export type DurationRules = Pick<Rules, "endStep" | "joinWindow" | "abandonWindow">;

/** The longest game this build composes. Argued for under "The ceiling"
 *  below; the comment that belongs on it lives there too. */
export const MAX_DURATION = days(31);

/** The shortest abandonment window any game may have, and the floor
 *  `durationRules` clamps to. Exported because `inspectGenesis` checks the
 *  same number — a clamp and a check that could drift apart are a bug with a
 *  waiting period. */
export const MIN_ABANDON_WINDOW = hours(3);
const MAX_ABANDON_WINDOW = hours(36);

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);

export function durationRules(request: number, joinShare = 1 / 3): DurationRules {
  // Clamped, not thrown on: see "The ceiling" below for where 31 days comes
  // from and why the join path deliberately does not enforce it.
  const endStep = clamp(request, 0, MAX_DURATION);
  return {
    endStep,
    // 0 means always open and is what every existing record says, so "closed"
    // cannot be 0. Step 0 is the composition of the record itself, so a window
    // that shuts at step 1 is the honest half-open reading of "no late joins".
    joinWindow: joinShare === 0 ? 1 : Math.round(endStep * joinShare),
    abandonWindow: clamp(
      Math.round(endStep / 3),
      MIN_ABANDON_WINDOW,
      MAX_ABANDON_WINDOW,
    ),
  };
}
```

`packages/sim/src/index.ts` gains `export * from "./duration.js"` beside the
other re-exports.

Note what `durationRules(0)` returns: `{ endStep: 0, joinWindow: 0,
abandonWindow: hours(3) }` — field for field, `DEFAULT_RULES` today. The
open-ended case needs no branch because the clamp already produces it.

## The gate, which is the only part that must be exactly right

`packages/sim/src/rules.ts:265`:

```ts
if (move.type === MOVE.ROSTER_AMEND) {
  // Gated on the record, never on the build. A v4 build playing a v3 game has
  // to reach the same verdict a v3 build would, and a v3 game has no such
  // field — so for a v3 record this line does not exist.
  const window = state.genesis.protocol >= 4 ? (rules.joinWindow ?? 0) : 0;
  if (window > 0 && move.step >= window && move.x !== MEMBER.BOT) return false;
  return empire.members.length < Math.min(rules.maxSeats, SEAT_CEILING);
}
```

The `protocol >= 4` test is not belt and braces on top of `?? 0`. Without it the
branch is only *incidentally* inert on v3 records — inert because no v3 record
happens to carry the field, which is a property of the records that exist rather
than of the records that are possible. A hand-composed v3 genesis carrying
`joinWindow` would be accepted by a v3 build and by a v4 build, and they would
then disagree about one ROSTER_AMEND and diverge from that step on: exactly the
silent overnight desync the whole version scheme exists to prevent, reintroduced
by the plan that bumped the version to prevent it.

Read against the record, the field cannot exist in a v3 game no matter what a
record claims. This is the first gated branch in the codebase, and it is the
shape every later one copies: **`state.genesis.protocol`, never
`PROTOCOL_VERSION`.**

`rules.ts` already imports `MEMBER` for the append at line 381, so `move.x !==
MEMBER.BOT` needs no new import — and reading the same field the application
reads is the point of writing it that way.

`victory.ts` is untouched. `endStep` and `abandonWindow` are v3-legal fields
already read there; a host setting them changes when a game ends, never how it
is encoded or validated.

## The rule that falls out of this, worth keeping

The contrast the plan draws with 0010 generalises, and it is the cheapest
compatibility test in the repository:

> A new check in `inspectGenesis` is safe across versions. A new branch in
> `validate()` is not.

`inspectGenesis` runs before anyone plays and its only power is refusal: two
builds that disagree about a record end up with one of them not in the game,
which is a bad afternoon and not a corrupt one. `validate()` runs inside the
hash's blast radius, where disagreement is divergence. So: checks are free,
branches cost a version — and if a rule can be expressed as a refusal at join
time, it should be.

## `HostPlan` should not carry `Partial<Rules>`

The plan proposes `rules?: Partial<Rules>` on `HostPlan`
(`packages/net/src/lobby.ts:67`). The harness precedent it cites
(`packages/net/src/test/harness.ts:97-100`) is a test fixture, where arbitrary
rules are the feature.

In the lobby it is a hole. Today `abandonWindow` is `hours(3)` in every genesis
that has ever existed — nothing anywhere overrides it, confirmed by grep across
`packages` and `apps`. Open the passthrough and a modified client can compose a
game with `abandonWindow: 12`, at which point `victory.ts:61-63` hands it
`WIN.LAST_ROSTER` the first time it is the only empire to have beaten inside a
second. Every peer verifies the record and every peer accepts it, because
`inspectGenesis` checks seats, keys, ids and the protocol — and not one number
in `rules`. The same door lets a host set `popMax`, `marchCost` or
`coinIntervalMin` to whatever wins.

Two changes, both small:

```ts
// lobby.ts — the type says what a host may choose, which is a duration
duration?: DurationRules;
```

and in `host()` (`lobby.ts:272`), `...(plan.duration ? { rules: plan.duration } :
{})`. `DurationRules` is a `Pick` of three fields, so the type itself refuses
`popMax`.

A type binds our client and not a hostile one, so the check goes where every
peer already looks — `packages/protocol/src/genesis.ts`, alongside the seat cap
that is there for precisely this reason:

```ts
// The abandonment window is the one rule a host could set to win outright: a
// short enough window makes every opponent "absent" and hands the composer the
// game before anyone has moved. Checked here because the seat cap taught us
// the lesson — a genesis record is the one place a rule can be born unfair.
const rules = genesis.rules ?? DEFAULT_RULES;
if ((rules.abandonWindow ?? DEFAULT_RULES.abandonWindow) < MIN_ABANDON_WINDOW) {
  problems.push("rules");
}
if ((rules.joinWindow ?? 0) < 0 || (rules.endStep ?? 0) < 0) problems.push("rules");
```

`GenesisProblem` gains a seventh member, `"rules"`. 0001's note that the enum
keeps its six members was about not splitting `"protocol"` into a family; this
adds a different check, not a finer-grained version of that one.

The check is unconditional on version, and by the rule above that is safe: no
record that exists violates it, and the worst a disagreement can produce is a
peer declining to join.

## Outside the sim: an early refusal, and a hold that never happens

`Lockstep.seatArrivals` (`packages/net/src/lockstep.ts:1078`) already calls
`this.sim.validate(move)` and skips the amendment when it fails — deterministic
on every peer, since every peer runs the same `validate` on the same record. So
the sim gate is *already* binding end to end, and the net layer needs nothing
for correctness.

What it needs is to not stop the game for a proposal that is going to die. A
carried amendment holds readiness below its step (`hold()`, `lockstep.ts:1020`)
until it resolves; a doomed one would hold the table, arrive, be skipped, and
release. So in `considerAmendment`, immediately after the dated-in-the-past
branch (`lockstep.ts:960`):

```ts
// Past the door's closing time, and not a bot. The sim would refuse this at
// its step anyway; refusing it here means the table is not held waiting for a
// vote whose outcome is already decided.
const genesis = this.sim.state.genesis;
const window = genesis.protocol >= 4 ? (genesis.rules.joinWindow ?? 0) : 0;
if (window > 0 && step >= window && incoming.amendment.kind !== MEMBER.BOT) return;
```

Same expression as the sim's, deliberately — and if the two ever disagree the
sim wins, because this one only ever declines to *start* a vote.

`LobbyPanel` (`apps/web/src/view/LobbyPanel.ts:290`) hides the "Offer a seat"
button. It holds no sim, so `RosterView` gains one field:

```ts
/** True once the join window has closed: the panel says so instead of
 *  offering a vote that would be refused. */
joinsClosed: boolean;
```

computed in `main.ts` where the rest of the roster view is assembled, from
`driver.sim.state`. The waiting list stays visible — people are still there,
watching — with a line saying the door closed rather than a button that lies.

## The bump, and the fixture pair that proves it moved nothing

`packages/sim/src/constants.ts`, on top of 0001's block:

```ts
export const PROTOCOL_VERSION = 4;
export const SUPPORTED_PROTOCOLS: readonly number[] = [4, 3];
export const PROTOCOL_SUNSET: Readonly<Record<number, string>> = {
  3: "YYYY-MM-DD", // release day + 90; see below
};
```

0001 says a sunset date is "the release date plus the longest duration preset".
That derivation does not work for 3, and the reason is this plan: **v3 predates
durations, so a v3 game has no scheduled end at all.** Every game in flight on
the day this ships is open-ended, and no arithmetic bounds it. So the date for 3
is a policy choice rather than a derivation — 90 days is the suggestion, long
enough that a marathon game started the week before the release is not cut
short by it, short enough to be a real deadline. From 4 onwards the derivation
works for every game that named a length — and with the cap below, the
derivation is arithmetic rather than judgement. Open-ended games are exactly
what 0001's shelf-life notice is for: they cannot be given a date, so they have
to be given a warning.

The fixture set 0001 built is what makes the bump checkable. `recorded-v3.json`
is **not** re-stamped — that was the pre-0001 plan, and it would have thrown the
evidence away. It stays exactly as it is, and a sibling is recorded under the
new build:

```
pnpm --filter @tessera/sim replay --record src/test/fixtures/recorded-v4.json
```

`record()` (`packages/sim/src/replay.ts:94`) is deterministic in the seed and
draws its hand from `Rng(seed ^ 0x5eed)`, and none of that reads the protocol
number. So the two files must differ in exactly one field:

```
diff <(jq 'del(.genesis.protocol)' recorded-v3.json) \
     <(jq 'del(.genesis.protocol)' recorded-v4.json)
```

Empty output — same move log, same step count, **same hash** — is the
hash-neutrality claim demonstrated rather than asserted, and `protocols.test.ts`
should assert it directly (`v3.hash === v4.hash`) so it cannot rot. That is a
stronger statement than "crossenv still passes": crossenv proves each fixture
reproduces itself, and this proves the bump changed nothing about what a game
*is*.

What the fixture pair does **not** prove is the gate. `record()` emits only
policy moves, so neither fixture contains a ROSTER_AMEND and neither one ever
reaches the new branch. The gate needs its own test, and it is worth being blunt
about that rather than letting a green crossenv imply coverage it does not have.

That test also happens to be the one 0001 wanted and could not write: one
process, one build, two versions, and an observable difference in behaviour.

```ts
// testkit's arena gains an options bag: arena(empires, seed, rules, { protocol })
const v3 = arena([humans(1), humans(1)], 1, { joinWindow: 40 }, { protocol: 3 });
const v4 = arena([humans(1), humans(1)], 1, { joinWindow: 40 }, { protocol: 4 });
// same record, same move, opposite verdicts — and the v3 one is the old build's
expect(v3.validate(amend(80, MEMBER.HUMAN))).toBe(true);
expect(v4.validate(amend(80, MEMBER.HUMAN))).toBe(false);
```

`arena` (`packages/sim/src/test/testkit.ts:25`) builds through `makeGenesis`,
which stamps the current version, so it needs a way to stamp another. A fourth
parameter as an options bag keeps its three existing call shapes untouched; the
`Sim` constructor never checks `gameId`, so a hand-stamped genesis is enough
here and no re-sealing is involved.

## The web control

`MAP_SIZES` and `mapSize()` (`apps/web/src/main.ts:71-80`) are the pattern to
copy exactly: a table beside the picker, read at the moment the game starts
rather than cached, so changing the dropdown and pressing start agree.

```ts
const COMMON_DURATIONS: ReadonlyArray<{ label: string; steps: number }> = [ … ];
const duration = () =>
  durationRules(Number(pick<HTMLSelectElement>('[data-cfg="length"]').value));
```

`index.html` gains a `<select data-cfg="length">` beside `#cfg-size:124`, its
options generated from `COMMON_DURATIONS` plus a free-entry field for the host
who wants 47 minutes. `main.ts:429` becomes:

```ts
start: (plan) => void lobby?.host({ ...plan, ...mapSize(), duration: duration() }),
```

The solo card keeps no duration control in this plan. A solo game against
SimBots is open-ended today and nothing about that is broken; `soloSetup()`
(`main.ts:86`) can take one later, and the reason to leave it out now is that
`joinWindow` and `abandonWindow` are both about people who are not there.

## The ceiling, and where the cap actually comes from

**Cap durations at 31 days.** The number is a policy choice, and it is worth
being precise about what it is *not* bounded by, because two different ceilings
get conflated and neither one is 31 days.

### The type ceiling is eleven years away

Every step-valued field in the system is a `u32`. In the snapshot: `state.step`,
`member.lastBeat`, `member.joinedAt`, `empire.eliminatedAt`, and each scheduled
event's `step` and `seq` (`packages/sim/src/state.ts:127-175`). On the wire:
`move.step`, `checkpoint.step` and `amendment.step`, range-checked before they
are signed (`packages/protocol/src/records.ts:57,203,409`).

| | steps |
|---|---|
| one second | 12 |
| one day | 1,036,800 |
| **31 days** | **32,140,800** (~2²⁵) |
| `u32` ceiling | 4,294,967,295 — 4,142 days, 11 years 4 months |

So a 31-day game spends 0.75% of the range, with 133× headroom. Nothing about
this cap is an encoding decision, and no derived quantity narrows it:
`abandonWindow` is `endStep / 3`, `joinWindow` is a fraction of it, and
`targetStep()` (`packages/net/src/lockstep.ts:403`) computes
`elapsed * 12 / 1000` in float64, exact past any date this game will see.

Two notes for whoever reads this in a decade. `moveInRange`
(`records.ts:54`) *refuses* an out-of-range step rather than wrapping, so the
wire fails loudly. The snapshot writer's `setUint32` truncates modulo 2³²
silently — deterministically on every peer, so it desyncs nobody, but it is the
one place the ceiling is not announced.

### The real ceiling is the archive, and it is much closer

Each seat signs a HEARTBEAT every 30 s (`lockstep.ts:536`), and those cannot be
elided from the log: `MOVE.HEARTBEAT` sets `lastBeat`, which is hashed state, so
a log without them replays to a different hash. They are the one cost that grows
with *duration* rather than with how much anybody plays.

| | 31-day game |
|---|---|
| heartbeats per seat | 89,280 |
| a 4-seat game | 357,120 signed records, ~70 MB of JSON |
| a 12-seat game | 1,071,360 signed records, ~210 MB |

A retaining archive holds all of it in one array (`packages/net/src/archive.ts:89`),
which is what a browser tab does — a peer writing an append-only file sets
`retain: false` and pays disk instead. So the practical limit on a long game is
a tab's heap, at a number four hundred times smaller than the type allows. 31
days is generous against that, not against `u32`, and the work that would move
it belongs with the archive and resume plans rather than here.

### The cap, and the one place it must not go

One helper joins `seconds`/`minutes`/`hours` in `constants.ts`:

```ts
export const days = (n: number) => hours(n * 24);
```

and `MAX_DURATION` in `duration.ts` — declared in the file above, and carrying
the comment that explains it:

```ts
/** The longest game this build composes. Policy, not encoding: the wire and
 *  the snapshot carry 133× this, and the real constraint is the archive
 *  arithmetic above. Raising it is this constant, one UI string, and an answer
 *  to that arithmetic — nothing else moves. */
export const MAX_DURATION = days(31);
```

`durationRules` clamps `endStep` to `[0, MAX_DURATION]`, the same way it clamps
the abandonment window: a caller asking for two years gets 31 days rather than
an exception.

It does **not** go in `inspectGenesis`, and that is the whole design of the cap.
Compare the two rules:

| | `abandonWindow` floor | duration ceiling |
|---|---|---|
| what a bad value does | hands the composer the win before anyone moves | makes that game's own archive large |
| who it hurts | everyone else at the table | the people who chose it, visibly |
| where it is checked | `inspectGenesis` — it must bind a hostile host | the composing path only |

A check in `inspectGenesis` is safe across versions, because refusal is all it
can cause — but it is also a *promise about what this build refuses*, and two
builds of the same version that disagree about it cannot play together. Weld
`MAX_DURATION` into the join path and raising it later needs a protocol bump.
Leave it on the composing side and raising it is a constant. Since an
over-long game cheats nobody, the cheap answer is the correct one.

What the lobby owes instead is legibility: the chosen length shown before the
start button, and in 0007's listing row, so a stranger dialling into a
three-month game knows that is what it is.

### What the cap buys the version scheme

0001 has to write each sunset date by hand, and the section above concedes that
for v3 it cannot even be derived, because a v3 game is open-ended and no
arithmetic bounds it. A cap changes that from v4 on:

```
sunset(version) = release date of its successor + MAX_DURATION + slack
```

and it is sound for a reason worth stating: a version's longest possible game is
fixed at the moment that version stops being current. Raising the cap later
lengthens the games *the new version* composes, never the retiring one's, so a
published sunset date can never be invalidated by a later raise. The formula
should read `MAX_DURATION` rather than hard-coding 31 days, and then the
retirement machinery inherits the cap automatically.

One exception survives: `endStep: 0`. Keep it legal in the sim forever — every
v3 record depends on it and the solo card has no reason not to use it — but make
**31 days the longest thing the multiplayer host card offers, and drop
open-ended from it.** Then every hosted game from v4 on has an end date, the
sunset derivation covers all of them, and 0001's shelf-life notice is left
covering only the v3 stragglers it was really written for.

None of this ties the version scheme to 31 days. `SUPPORTED_PROTOCOLS`, the
sunset table and the gated branches do not mention a duration; the cap reaches
them through one formula, and lengthening games later is a constant plus the
archive work that has to justify it.

## Order of work

Five commits. The first is green and inert; the second is the one to review.

1. `feat(sim): a duration is a step count` — `duration.ts`, the exported
   `seconds`/`minutes`/`hours`, `joinWindow?` on `Rules`, `duration.test.ts`.
   Nothing reads the field yet: hash-neutral, version-neutral, a **minor**.
2. `feat(sim)!: late joins close, and the protocol is 4` — the gated
   `validate()` branch, the constants, `recorded-v4.json`, the v3-vs-v4 gate
   test, the fixture-pair hash assertion.
3. `feat(protocol): refuse a genesis whose windows are unplayable` — the
   `MIN_ABANDON_WINDOW` check and `GenesisProblem` gaining `"rules"`.
4. `feat(net): the door closes on late human seats` — `HostPlan.duration`,
   `considerAmendment`, `RosterView.joinsClosed`, `LobbyPanel`.
5. `feat(web): choose how long the game runs` — the dropdown and its wiring.
6. `docs: durations, and a protocol that is 4`.

On semver: commit 2 is a **major** on `@tessera/sim`, and `dispat.yaml:10-20`
does not currently say so. Its rule is stated purely in terms of the hash —
"only genuinely hash-neutral work is a minor or patch" — and this change is
hash-neutral and breaking, because a v3 build refuses the games a v4 build
composes. The comment needs a third clause: **a `PROTOCOL_VERSION` bump is
breaking whether or not the hash moved.** Worth fixing in this plan rather than
discovering it when the release tool proposes a minor.

## Docs

| File | What changes |
|---|---|
| `docs/gameplay/victory.md:18-20` | `endStep` is no longer always 0; a host sets it, and the abandonment row gains the scaling |
| `docs/gameplay/difficulty-and-balance.md:58,60` | `abandonWindow` "3 h" becomes "3 h floor, a third of the game"; a `joinWindow` row joins the table |
| `docs/concepts/time-and-steps.md:51` | same correction to the same number |
| `docs/continuity/heartbeats-and-liveness.md:32` | the **3 h** in that table is now a floor, and the sentence that explains why is this plan's opening trap |
| `docs/protocol/genesis.md:48,64` | the `rules` problem row, and `DEFAULT_RULES` no longer being the only rules a record carries |
| `ARCHITECTURE.md:29`, `docs/concepts/the-one-invariant.md:38-44`, `docs/protocol/README.md:29`, `docs/simulation/README.md:29`, `docs/simulation/snapshot-and-hash.md:63` | 0001 rewrote the *shape* of these; 0002 moves the *number*, `#L8` deep links included |
| `dispat.yaml:10-20` | the third clause above |

A new `docs/gameplay/durations.md` is worth its own page rather than a section:
the trap, the two derived windows, the table, and why the door is a fraction of
the game. `docs/gameplay/victory.md` links it from the timeout row.

## Verification, mapped to files

`packages/sim/src/test/duration.test.ts` — everything from the plan's list
above, plus:

- `durationRules(0)` equals `DEFAULT_RULES`'s three fields exactly, field for
  field, read off `DEFAULT_RULES` rather than retyped.
- `joinShare: 0` yields `1`, and `joinShare: 1/3` on an open-ended game yields
  `0`. The two sentinels, adjacent, in one test.

`packages/sim/src/test/rules.test.ts`, extending "an empire cannot vote itself
past the seat cap" (line 386) since it already builds ROSTER_AMEND moves:

- a human amendment at and after `joinWindow` is refused, one before it is
  accepted, and a `MEMBER.BOT` one is accepted on both sides of the line;
- **the v3/v4 pair above** — the same record and the same move reaching
  opposite verdicts on the two versions. This is the plan's load-bearing test.

`packages/sim/src/test/protocols.test.ts` (0001's file) gains:

- `PROTOCOL_SUNSET[3]` exists, parses, and is in the future;
- `recorded-v3.hash === recorded-v4.hash` — the bump moved nothing.

`packages/net/src/test/amendment.test.ts` — a proposal past the window is
neither gossiped nor held: readiness keeps advancing, which is the failure mode
worth a test because it looks like a hang rather than a refusal.

`packages/protocol/src/test/genesis.test.ts` — a genesis with `abandonWindow`
below the floor is refused; one at the floor is accepted.

And three bullets 0001 listed as pending now come due, which is the honest
measure of whether these two plans worked:

- a v3 genesis and a v4 genesis both playing under one build, each reproducing
  its own fixture — `crossenv`, both files;
- `verifyArchive` accepting a v3 archive under a v4 build, `rankArchives`
  counting it — `packages/net/src/test/archive.test.ts` against a stored v3
  archive;
- a build on `[4, 3]` running a v3 game **as v3** — the gate test above, which
  is what "as v3" finally means in code.

## Two things this plan does not settle

**Open-ended games still have no end of their own.** The cap bounds every game
that names a length, and dropping open-ended from the host card means no new
multiplayer game is composed without one. Neither reaches the games already
running, and neither gives a table a way to *extend* a game it is enjoying —
which is the feature that would make a duration a choice rather than a guess. If
a later plan wants it, the move is to let a table lengthen its own game by
signed amendment, which is a records design and not a rules change, and does not
belong here.

**A host can still pick a hostile length.** The floor stops
`abandonWindow: 12`; nothing stops `endStep: 13`, a game that ends four seconds
after it starts and hands the leader a win. That is visible in the record before
anyone plays and refusing it is a judgement about what a game is *for* rather
than whether it is fair — so the recommendation is to leave it, and to make the
lobby show the chosen length before the start button rather than encode a
minimum. Worth revisiting when 0007 lists rooms a stranger might dial into: the
listing is where a four-second game becomes worth catching.
