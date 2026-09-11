# 0001 — Games that outlive their release

Status: draft
Depends on: nothing (but 0002 needs it, and 0002 is what makes it urgent)
Branch: `supported-protocols`

## The problem

A ten-day game started on Monday is still running when Thursday's release goes
out. Every tab that reloads gets the new bundle, every headless peer restarts
into it, and the new build refuses the game they were playing:

```ts
if (genesis.protocol !== PROTOCOL_VERSION) {
  // Refuse at the lobby rather than desyncing silently hours later.
  throw new Error(`sim protocol mismatch: …`);
}
```

(`packages/sim/src/sim.ts:52`, and `inspectGenesis` refuses in the same breath
at `packages/protocol/src/genesis.ts:68`.) **The release kills the game.**

Nobody has met this because no game has ever outlived a deploy — every game so
far has been one sitting long. 0002 is precisely the plan that makes multi-day
games ordinary, and 0006 is precisely the plan that keeps their doors open
after everyone has gone to bed. The series creates the exposure.

And it is worse than one game dying. `verifyArchive` goes through
`inspectGenesis` (`packages/net/src/archive.ts:19`), so the moment the constant
moves, **every archive ever written becomes unverifiable** — the leaderboard
(0008), `rankArchives`, and the replay tool all stop reading history. That is a
larger loss than the game, and a quieter one.

## What ships

`PROTOCOL_VERSION` splits into two ideas that have been sharing a name:

```ts
/** Stamped into every genesis this build composes. */
export const PROTOCOL_VERSION = 4;
/** Every version this build can play, verify and replay. Newest first. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [4, 3];
```

Six call sites, all of them mechanical:

| Site | Today | After |
|---|---|---|
| `sim.ts:38` (`makeGenesis`) | stamps `PROTOCOL_VERSION` | unchanged — new games are always current |
| `sim.ts:52` (`Sim` ctor) | `!== PROTOCOL_VERSION` → throw | `!SUPPORTED_PROTOCOLS.includes(...)` → throw |
| `genesis.ts:68` (`inspectGenesis`) | `!== PROTOCOL_VERSION` → `"protocol"` | membership test |
| `lobby.ts:217` (HELLO out) | stamps the build's version | stamps **the game's**, once one exists |
| `lobby.ts:226` (HELLO in) | `!== PROTOCOL_VERSION` → drop | drop unless both support the game's version |
| `main.ts:41` (status line) | `protocol N` | `protocol N (also plays 3)` |

`lobby.ts:226` is the one that needs thought rather than a find-and-replace.
Its comment — "a build we cannot play with" — is right about the intent and
wrong about the test: what matters is not whether two peers were built the same
day, but whether both can play *this* game. In a lobby with no game yet, that
is an intersection of supported sets; once a genesis exists, it is a single
number both must support.

## What it costs, and it is not free

Supporting v3 means **behaving like v3 when handed a v3 record.** Every
version-gated branch reads the record rather than the constant:

```ts
if (move.type === MOVE.ROSTER_AMEND) {
  const window = state.genesis.protocol >= 4 ? (rules.joinWindow ?? 0) : 0;
  …
}
```

That is a discipline with a real ongoing tax, and it is only affordable while
the number of gated branches is small. Which is the argument for being strict
about when a bump is owed in the first place: every unnecessary bump buys a
permanent conditional. The table below — *a bump is owed when two builds
would compute different state from the same log* — is what keeps this cheap.

Two rules to hold the line:

1. **A gated branch is written once and never nested.** If a change needs
   `protocol >= 4` in five places, it is one change to a shared helper, not
   five conditionals.
2. **Support N and N-1 only.** A version is dropped once the longest duration
   preset — ten days (0002) — has elapsed since the release that superseded it,
   at which point no game on it can still be running. That is a checkable rule
   with a date attached, not a judgement call.

## Which plans move a version number, and why so few

Four independent constants. The series moves two of them, in one plan each:

| Constant | Where | Moved by |
|---|---|---|
| `PROTOCOL_VERSION = 3` | `packages/sim/src/constants.ts:8` | **0002**, see its own argument — recommended 3 → 4 |
| `LAYOUT_VERSION = 3` | `packages/sim/src/state.ts:20` | nothing here |
| `ARCHIVE_FORMAT = 1` | `packages/net/src/archive.ts:25` | nothing here |
| secrets `VERSION = 1` | `packages/protocol/src/secrets.ts:30` | **0012**, 1 → 2 (direct-message key derivation) |

Four plans add a field to a record an old build will read, and they reach
different verdicts. The contrast is the clearest statement in the series of
what the version number is actually for:

| Plan | What an old build does with it | Bump? |
|---|---|---|
| 0002 `joinWindow` | reads past it, then enforces a **different rule** in `validate()` | **yes** — invisible divergence |
| 0010 vacancies | **refuses the genesis** at `inspectGenesis`, today, with no new code | no — it declines instead of desyncing |
| 0013 banners | reads past it; nothing downstream of `validate()` ever sees it | no — identical state, different picture |
| 0009 consent | reads past it; hashes it into the same `gameId` and plays on | no — but see 0009: an unchecked consent list may be worse than none |

The rule underneath all four: **a bump is owed when two builds would compute
different state from the same log.** Not when they render it differently, and
not when one of them refuses to play.

Being strict about that is what keeps this plan affordable, which is why the
rule is written down here rather than wherever it was first needed.

## The fixture becomes a set

`sim/test/crossenv` reads one stored genesis and asserts a hash. It becomes one
per supported version — `recorded-v3.json`, `recorded-v4.json` — each asserting
that *this build* reproduces *that version's* hash exactly. This is the honest
cost of the feature and also its only real proof: a v3 branch that has quietly
stopped behaving like v3 is caught by the file that has not changed.

Each release records, commit by commit, whether the hash moved and whether the
number went with it — dispat builds the changelog from those bodies. That
discipline is what makes the fixture set maintainable rather than
archaeological.

## Telling the player

The one piece of UI: a game running on a superseded version says so, with the
date its support ends. "This game uses rule set 3. Your build plays it until
14 October." A player who knows a game has a shelf life can finish it; one who
does not simply finds it broken one morning.

The address book (0007) carries the genesis, so a listing can be shown as
unplayable *before* the dial rather than after — `inspectGenesis` runs on
arrival there already.

## The horizon

This mechanism should get less important, not more. The rule set stabilises,
bumps become rare, `SUPPORTED_PROTOCOLS` collapses back to a single entry, and
the gated branches age out on the ten-day clock. It is worth building anyway,
because the alternative during the years before that is either never shipping a
rule change or killing a game every time you do — and because the archive
argument holds regardless of how stable the rules get. History should stay
readable after the rules move on.

## Verification

- A v3 genesis and a v4 genesis both construct, both play, and each reproduces
  its own stored fixture hash under the same build.
- Two peers, one supporting `[4, 3]` and one supporting `[3]`, converge on a v3
  game over the harness and refuse each other on a v4 game — refuse, not
  desync, asserted by hash comparison rather than by the absence of an error.
- `verifyArchive` accepts an archive of a v3 game under a v4 build;
  `rankArchives` counts it.
- Dropping v3 from the array makes exactly the v3 fixture fail and nothing
  else — the retirement path, exercised before it is needed.

---

# Implementing it

## What ships first, and what it can therefore prove

0001 lands while `PROTOCOL_VERSION` is still 3, so on the day it merges
`SUPPORTED_PROTOCOLS` is `[3]` and every membership test has one member. The
plumbing carries no traffic until 0002 bumps the number.

That is fine for the feature and fatal for its tests. A predicate that can only
be asked about the single version this build stamps is a predicate nobody has
run. So every decision this plan touches becomes a **pure function taking the
supported set as a parameter**, defaulted to the constant. Production call sites
read exactly as before; the tests hand in `[4, 3]` and `[3]` and exercise the
behaviour a year before the constant does.

Three verification bullets above cannot be honestly claimed on this branch —
the archive one, the two-peer convergence one, and half the fixture one — because
they need a second real version to exist. They are listed at the end under what
lands with 0002 rather than quietly counted here.

## The constants

`packages/sim/src/constants.ts`, replacing line 8:

```ts
/** Stamped into every genesis this build composes. New games are always
 *  current: nothing anywhere downgrades this. */
export const PROTOCOL_VERSION = 3;

/** Every version this build can play, verify and replay, newest first.
 *  PROTOCOL_VERSION is always its first entry. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [3];

/** The day each superseded version stops being played, ISO. Written by hand at
 *  the bump — the release date plus the longest duration preset — and checked
 *  by a test that fails once a date has passed. Retirement is an alarm clock,
 *  not something somebody has to remember. */
export const PROTOCOL_SUNSET: Readonly<Record<number, string>> = {};

/** Whether this build will play a game stamped with `version`.
 *
 *  The set is a parameter with a default rather than a closed-over constant.
 *  On the day this ships the constant has one entry, and a predicate that can
 *  only be asked about that entry is a predicate no test can move. */
export function playsProtocol(
  version: number,
  supported: readonly number[] = SUPPORTED_PROTOCOLS,
): boolean {
  return supported.includes(version);
}

/** What to tell a player whose game is on a superseded version: null while the
 *  game is current, which is every game until the first bump. */
export function shelfLife(
  genesis: Genesis,
): { version: number; until: string } | null {
  const until = PROTOCOL_SUNSET[genesis.protocol];
  return until === undefined ? null : { version: genesis.protocol, until };
}
```

`constants.ts` already imports types from `./types.js`; `Genesis` joins `Rules`
and `MapConfig` on that line. `packages/sim/src/index.ts` re-exports
`./constants.js` with `export *`, so all five names are public with no edit
there.

## The four refusals

| File | Today | After |
|---|---|---|
| `sim/src/sim.ts:38` | `protocol: PROTOCOL_VERSION` | unchanged |
| `sim/src/sim.ts:52` | `genesis.protocol !== PROTOCOL_VERSION` | `!playsProtocol(genesis.protocol)`; the message becomes `this build plays v3` — the whole list, because a one-number message on a build with two is a lie |
| `protocol/src/genesis.ts:68` | `!==` → `push("protocol")` | `!playsProtocol(...)` → `push("protocol")`. `GenesisProblem` keeps its six members: the caller needs a version and a date, and gets those from the record plus `shelfLife`, not from a wider enum |
| `net/src/archive.ts:243` | via `inspectGenesis` | **no edit** — this is the whole archive fix, and it is free |

`packages/protocol/src/test/genesis.test.ts:54` (protocol `99` is refused) keeps
passing unchanged, which is the point: widening the accepted set must not widen
it to everything.

## The HELLO frame grows a field

The frame today carries one number, and one number cannot express "I can play
either of these". `packages/protocol/src/wire.ts:46`:

```ts
export interface HelloFrame {
  t: typeof FRAME.HELLO;
  /** The version at stake: the game's if there is one, otherwise the one the
   *  sender would compose. An old build reads only this and reaches the right
   *  answer from it, which is why it stays a bare number. */
  protocol: number;
  /** Every version the sender can play. Absent from an older build, and read
   *  as `[protocol]` when it is. */
  supported?: number[];
  gameId: string;
  key?: MemberKey;
  nonce: string;
}
```

`decodeFrame` (`wire.ts:185`) gains one clause — `supported` is either absent or
an array of numbers. `wire.test.ts` gets the round trip and the two rejections.

Then `packages/net/src/lobby.ts`. `greet` (line 214) stamps the stake rather
than the build:

```ts
protocol: this.sealed?.protocol ?? PROTOCOL_VERSION,
supported: [...SUPPORTED_PROTOCOLS],
```

and `route` (line 226) replaces the comment that was right about the intent and
wrong about the test:

```ts
if (frame.t === FRAME.HELLO) {
  // Not "were we built the same day" but "can they play this game" — the one
  // we are in, or the one this build would compose if we are not in one yet.
  if (!canPlay(frame, this.sealed?.protocol ?? PROTOCOL_VERSION)) return;
```

with the decision exported from `lobby.ts` so it can be tested without a broker:

```ts
export function canPlay(hello: HelloFrame, stake: number): boolean {
  return (hello.supported ?? [hello.protocol]).includes(stake);
}
```

`this.sealed` is set in `adopt` (line 310) before `onStart`, and `welcome`
already greets before sending GENESIS, so a mid-game arrival is greeted with
the game's version and no ordering changes.

## One game, one version

This is not compatibility negotiation, and reading it as negotiation is what
makes it look expensive. **A game is stamped at version N and every peer in it
plays N, for its whole life.** What a multi-version build gains is not the
ability to talk to a peer on another version — it is the ability to *be* the
version a game it already agreed to is on:

> A game starts at N. A player goes away and comes back, twice, on the same
> build. The release ships N+1. The player's client updates. They rejoin, and it
> runs N for that game, because that is the game they are in.

So `SUPPORTED_PROTOCOLS` is a **version-selection** mechanism, not a handshake
one, and its centre of gravity is the gated branch — `state.genesis.protocol`,
never the build's constant, decides behaviour once the record is adopted. The
plan's "What it costs" section is not a caveat on the feature; it *is* the
feature. Everything in the lobby is the smaller half.

Three consequences follow, and each removes work rather than adding it.

**The prose above says a fresh lobby compares "an intersection of supported
sets". It should not, and now does not.** `makeGenesis` is unchanged and new
games are always current, so a new game is N+1 and nothing negotiates it down.
Picking a lower version to accommodate whoever happened to be in the room would
make a game's rule set a function of its attendance, which is worse than a
refusal and harder to explain.

**A v4 build and a v3 build meeting in an *empty* lobby drop each other, and
that is the correct answer, not a gap.** The game that lobby would produce is
one the v3 build cannot play. Two supported versions buy the *running* game its
remaining days; they do not buy a shared lobby, and were never meant to.

**`canPlay` is therefore an early-out and a better error message, not the
gate.** The real gate is `adopt` → `inspectGenesis`, which is the first moment
either side knows what game is being proposed. The HELLO check only earns its
place in one case, and it is the case the user story above is entirely about: a
returning player on N+1 dials a room running N. Without `supported` on the
frame the host sees `protocol: N+1`, reads it as a stranger, and drops the peer
*before* sending the genesis that would have settled it — refusing the exact
rejoin this plan exists to allow. That single scenario is why the field is worth
adding; it is not there to let two versions coexist in one game.

## Why a running game is never upgraded

The tempting alternative — rewrite a live game's `protocol` from N to N+1 and
let everyone move together — is not merely harder. It is closed off by the trust
model, decisively and in one step:

`gameIdOf` hashes the genesis record with only its own `gameId` removed
(`packages/protocol/src/genesis.ts:41`), so `protocol` is *inside* the hash.
And every signature in the game binds the game id in its preamble — moves,
messages, amendments, readiness, the proof exchange
(`packages/protocol/src/records.ts:37`). Change the protocol field and the game
id changes; change the game id and every move already cast stops verifying, the
roster's endorsements stop verifying, and the archive stops being checkable.

An upgraded game is a *different game* by the only definition this codebase
has. So there is no migration path to design, no half-upgraded state to
reconcile, and no partial rollout to reason about — which is the strongest
argument for the version-selection design over the alternative, and worth
having written down before somebody proposes migration as the simpler option.
The corollary: a version's retirement date is a real deadline for the games on
it, and cannot be extended by converting them. The shelf-life notice is the
whole mitigation, which is why it is not optional UI.

## The fixture becomes a set

`packages/sim/src/test/fixtures/recorded.json` → `recorded-v3.json`, and a
sibling `index.ts` that names them:

```ts
import v3 from "./recorded-v3.json";
export const RECORDED = [v3] as unknown as Recorded[];
```

An explicit index rather than `import.meta.glob`, because this file is loaded by
two runners — Node under `packages/sim`, and Chromium, Firefox and WebKit under
`apps/web/vitest.config.ts:23` — and one line per version is cheaper than
depending on glob semantics agreeing across both.

`crossenv.test.ts` wraps its four assertions in `for (const recorded of RECORDED)`
and names the version in the `describe`, so a red run says *which* version
diverged in which engine. Its existing assertions are unchanged; each is now
asserted per fixture. `replay.ts:120` writes the versioned filename and says so
in the `note`.

A new `packages/sim/src/test/protocols.test.ts` is where retirement is actually
enforced:

- `SUPPORTED_PROTOCOLS[0] === PROTOCOL_VERSION`.
- Every entry but the first has a `PROTOCOL_SUNSET` date; the first has none.
- **No sunset date is in the past.** This is the alarm: the suite goes red on the
  day a version is due to be dropped, rather than on the day somebody notices.
- Every supported version has a fixture, and every fixture's version is
  supported — both directions. The second is what makes the retirement path
  honest: drop `3` from the array and `crossenv` fails on exactly the v3 fixture
  while this test says the fix is to delete the file.
- `playsProtocol` against fabricated sets: `(4, [4,3])`, `(3, [4,3])`,
  `(2, [4,3])`, `(4, [3])`.

And `packages/net/src/test/protocols.test.ts` for `canPlay`, again on fabricated
frames: same version agrees; disjoint sets refuse; a frame with no `supported`
is read as `[protocol]`, which is the old-build case and the one most likely to
rot unnoticed.

## Telling the player

Two places, both small.

The status line (`apps/web/src/main.ts:41`) lists what else this build plays:

```ts
const also = SUPPORTED_PROTOCOLS.filter((v) => v !== PROTOCOL_VERSION);
const version =
  `v${pkg.version} · protocol ${PROTOCOL_VERSION}` +
  (also.length ? ` (also plays ${also.join(", ")})` : "");
```

which today renders exactly what it renders now — the branch is dead until 0002,
and shipping it dead is the point.

The shelf-life notice needs a home in the page. `index.html` gains a
`[data-shelf-life]` span beside `[data-version-menu]:142`, filled from
`shelfLife(genesis)` where `main.ts` receives the genesis in `lobby.onStart`:
*"This game uses rule set 3. Your build plays it until 14 October."* Null result,
empty span, no layout.

The refusal is worth the same care. `lobby.ts:296` currently fails with
`refused the game: protocol`, which tells a player nothing they can act on.
Where the problems include `protocol`, it should name the version and say which
side is old — a genesis below `SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length-1]`
means their build has moved on without you; one above `PROTOCOL_VERSION` means
yours has not caught up. Two sentences, and it is the difference between
"update your client" and a shrug.

0007's listing-side use — showing a room as unplayable before the dial — needs
nothing new here: `inspectGenesis` already runs on arrival and now returns the
right answer.

## Docs, and the sentence that is repeated in six places

Six files say some version of "a peer refuses a game whose major differs", and
all six become wrong on the same day:

| File | What changes |
|---|---|
| `ARCHITECTURE.md:29` | the bullet gains the second constant and the N/N-1 rule |
| `docs/concepts/the-one-invariant.md:38` | the section heading is still right; the body and the `#L8` deep link are not |
| `docs/protocol/genesis.md:48` | the `protocol` row of the problems table |
| `docs/protocol/README.md:29` | "(3)" becomes the supported set |
| `docs/simulation/README.md:29` | "throws on a major mismatch" → "throws on an unsupported version" |
| `dispat.yaml:18-20` | the comment tying the semver rule to `PROTOCOL_VERSION` |

Do not write `packages/sim/CHANGELOG.md` by hand — dispat generates it from the
commit bodies at release, so the body of commit 1 *is* the release note: the
hash does not move, `PROTOCOL_VERSION` stays at 3, and the build gains
`SUPPORTED_PROTOCOLS`. Hash-neutral and additive, so this is a **minor** on
`@tessera/sim` under `dispat.yaml`'s contract, not a major — the first plan in a
while where that is true, and worth stating in the commit so nobody "corrects"
it to a `feat!`.

## Order of work

Six commits, each green on its own:

1. `feat(sim): SUPPORTED_PROTOCOLS, and a build that plays more than one` —
   constants, `sim.ts:52`, `protocols.test.ts`.
2. `feat(protocol): inspectGenesis accepts any supported version` — `genesis.ts`,
   the `supported` field on `HelloFrame`, `decodeFrame`, `wire.test.ts`.
3. `feat(net): the lobby admits a peer that can play this game` — `greet`,
   `route`, `canPlay`, its test.
4. `refactor(sim): the recorded fixture becomes a set` — the rename, the index,
   the `crossenv` loop, `replay --record`. No behaviour, one hash, still green in
   all four engines.
5. `feat(web): say which rule set a game uses, and until when` — status line,
   shelf-life span, the refusal message.
6. `docs: two constants where there was one` — the six files above.

Steps 1–3 are the feature; 4 is what makes 0002 cheap; 5–6 are what stop it
being a trap. Nothing here is ordered by dependency after 3, so 4–6 can land in
any order or together.

## Verification, mapped to files

Claimable on this branch:

- `playsProtocol` and `canPlay` decide correctly for fabricated sets, including
  a HELLO with no `supported` field — `sim/src/test/protocols.test.ts`,
  `net/src/test/protocols.test.ts`.
- The v3 fixture reproduces its hash in Node, Chromium, Firefox and WebKit
  through the new loop — `crossenv.test.ts`, unchanged assertions.
- A genesis stamped `99` is still refused, by `inspectGenesis` and by the `Sim`
  constructor — `protocol/src/test/genesis.test.ts:54`, plus a new ctor case.
- Every supported version has a fixture and no sunset date has passed —
  `protocols.test.ts`. Deleting `3` from `SUPPORTED_PROTOCOLS` locally fails
  exactly `crossenv`'s v3 block and `protocols`' pairing check, and nothing else:
  the retirement path, walked before it is needed.

Waiting on 0002, and listed as pending rather than counted:

- A v3 genesis and a v4 genesis both playing under one build, each reproducing
  its own fixture.
- `verifyArchive` accepting a v3 archive under a v4 build, and `rankArchives`
  counting it. Testable today only against a version this build refuses, which
  tests the refusal and not the acceptance.
- A build on `[4, 3]` running a v3 game *as v3* — the whole point, and untestable
  until a gated branch exists to tell v3 behaviour from v4. 0002 ships the first
  one, and the v3 fixture is what holds it honest.

## Two things this plan does not settle

**Verifying and playing have different natural lifetimes.** "Support N and N-1"
is right for joining a game and wrong for reading an archive: on the third bump,
v3 archives become unverifiable again — the loss this plan opens by calling
larger and quieter than a dead game. One array means one lifetime and
no illusion about it; splitting into a short join list and a long replay list
would keep history readable but does *not* reduce the tax, since a gated branch
must exist for any version the build can still reproduce. The recommendation is
to ship one array now and revisit at the second bump, when the question is real
and there is something to measure — but the trigger belongs written down, so:
**when a third version is proposed, this decision is due.**

**How a returning client proves it selected the right version.** Once a game is
adopted, "this build is running v3" is not directly observable — it is a claim
about which side of a gated branch every one of a thousand steps took. The only
instrument that sees it is the recorded fixture, which is why the fixture set is
listed above as the honest cost of the feature *and its only real proof*, and
why it should land in this plan rather than with 0002.

What is not settled is whether the harness should be able to hold two builds at
once. `new Sim(genesis, { supported })` would let one process put a `[4, 3]`
peer and a `[3]` peer in the same test. Under one-game-one-version that buys
only the refusal case — which the `Sim` constructor already covers on its own —
so the recommendation is to leave it out. Revisit only if 0002's gated branch
proves hard to test at the seam.
