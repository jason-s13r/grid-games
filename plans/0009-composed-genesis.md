# 0009 — Composing a game together: a genesis everybody signed

Status: draft
Depends on: 0002 (durations to put in the proposal). Assumes 0006's host peer
as the room; shares its claim record with 0010 and its banner picker with 0013.
Branch: `composed-genesis`

## The problem

Tessera's nature is stated the same way in every part of the system: no
authority, signed records, everyone verifies for themselves, and a change to
the roster needs a quorum of the people it affects. That holds in every phase
of the game **except one**, and the exception is the phase that decides
everything.

Today a lobby does two things. Peers exchange HELLO and land in a `members`
map keyed by peer id (`packages/net/src/lobby.ts:228`), and then one of them
presses Start: `Lobby.host(plan)` (`lobby.ts:253`) reads that tab's own local
UI state — teams, SimBot difficulties, map size — seals it with `sealGenesis`,
and broadcasts the record. The first time anybody else sees the configuration
is as a finished `GenesisFrame`, and their only available response is refusal
(`adopt()`, `lobby.ts:291`).

Mid-game, adding one person to one empire is a signed collective act needing
`Roster.quorum`. Pre-game, composing the entire world — map, duration, victory
condition, opponents, everyone's seat — is one unilateral act by whoever
clicked first. That asymmetry is not a considered position; it is a leftover
from a design where the room *was* someone's tab.

0006 removes the thing that justified it. When the room is a headless peer
that composes nothing, "the host's preferences" is not a category that exists
any more. There is nobody left for the genesis to be the opinion of.

**So this plan does not add a vote. It removes an exception.**

How a game is composed today is described in
[`docs/mesh/the-lobby.md`](../docs/mesh/the-lobby.md) — compose, seal,
broadcast, then no authority — and is not restated here. The constraint it
leaves behind shapes this plan and every later one: **the genesis is immutable
and its hash is the game id**, so anything that must change mid-game is either
a parameter that was already in the rules at sealing time (`joinWindow`,
`endStep`, `vacancyRadius`) or a signed record in the log (`ROSTER_AMEND`,
0010's claim, 0011's application). There is no third option — which is why
what follows is a record and not a message.

## The one decision that makes it work: you sign the world, not the roster

Everything else here follows from this, so it goes first.

The tempting design is "sign the plan" — the whole `HostPlan`, members and
all. It deadlocks. Every arrival changes the member list, which changes the
hash, which voids every signature already collected; in a persistent room
where people drift in over an hour, settling is precisely what attracts the
next joiner, and the proposal can never close.

So the signed object is the **world** — map, rules, duration, opponents, seed,
start time — and it names nobody. The roster is then *derived from who signed
it*. A new player consenting adds them to the game without touching the hash
anybody else committed to, and no signature is ever invalidated by somebody
else arriving.

That inversion is what turns a negotiation into something that can run
asynchronously over a join window, which is the only shape that fits a
persistent room.

## The proposal

```ts
// packages/protocol/src/proposal.ts
export interface Proposal {
  seed: number;
  startedAt: number;          // a future wall-clock instant, not Date.now()
  map: MapConfig;
  rules: Rules;
  simbots: readonly (Difficulty | BotProfile)[];
  vacancies: number;          // empires the map places with nobody in them (0010)
  banners?: BannerId[];       // which house each empire flies (0013)
}

export async function proposalId(p: Proposal): Promise<string> {
  return toHex(await sha256(utf8(canonicalJson(p))));
}
```

`canonicalJson` (`packages/protocol/src/genesis.ts:16`) is the same function
`gameIdOf` already uses, for the same reason: two peers must derive
byte-identical bytes or they derive different ids and never meet.

Any peer may broadcast one. It travels in a frame that supersedes by revision,
which is 0009's original draft channel doing the same job it always did:

```ts
export interface ProposalFrame {
  t: typeof FRAME.PROPOSAL;
  proposal: Proposal;
  rev: number;        // monotonic per proposer; a later rev supersedes
  by: MemberKey;      // who is suggesting it — attribution, not authority
}
```

`FRAME` is an additive string union (`packages/protocol/src/wire.ts:25`) and
`decodeFrame` returns null for anything it does not recognise, so an older
peer in the lobby ignores proposals and behaves exactly as it does today.

**Anyone proposes; a revision is a counter-proposal.** "Make it three days"
stops being a thing you say in chat and hope for, and becomes a rev with one
field changed that everybody can see and sign.

## Consent

```ts
const TAG_CONSENT = "tessera/consent/1";

export interface SignedConsent {
  key: MemberKey;
  proposalId: string;
  sig: string;        // over TAG_CONSENT ‖ proposalId
}
```

One signature, meaning *I will play this world*. It follows the domain-tag
discipline every other record follows (`packages/protocol/src/records.ts:22-28`).

It carries no game id, because there is no game yet — the same fact that makes
a lobby HELLO "prove nothing beyond here is a key to seat me under"
(`lobby.ts:212`). What stands in for the game id is the proposal hash itself,
and that only works if a proposal cannot recur: **`seed` becomes random rather
than a hash of the room code and the clock** (`lobby.ts:273`, `rng.ts:54`), so
two identical-looking worlds in two different rooms are distinct objects and a
consent cannot be lifted from one into the other. The current derivation is
guessable anyway; this is an improvement it was owed.

## Determinism: `seed` and `startedAt` move into the proposal

Signing a proposal is only meaningful if the proposal determines the genesis.
Today it does not — `Lobby.host` mints both non-deterministic fields at the
moment of sealing:

```ts
seed: seedFrom(`${this.code}:${Date.now()}`),
startedAt: Date.now(),
```

(`lobby.ts:272-277`.) Two peers holding the same plan seal different records.
Move both into the proposal and `proposal → genesis` becomes a pure function,
at which point **signing the proposal is signing the genesis** and every peer
can derive the sealed bytes for itself.

`startedAt` becoming a future instant is a gain rather than a cost. Every peer
derives its step number from it, so an agreed start time means everyone begins
on the same step instead of whenever their `GENESIS` frame happened to land —
and the deadline for consenting is a fact of the record rather than a
convention in the UI.

## Who seals, and why that is not authority

Peers will not hold identical consent sets at the same instant, and two peers
sealing with different sets produce different game ids and never meet. Somebody
has to say "sealed".

The room peer does it (0006), and everybody verifies. That is not the old
authority returning, because of what it demonstrably cannot do:

| | Caught by |
|---|---|
| change a rule | the proposal is hashed; every consent names that hash |
| seat a non-signer | each consent is verified against the proposal id |
| drop you quietly | your client looks for its own key first, and fails the lobby |
| invent a player | a consent is signed by the key it seats |

What is left to it is deciding *who was late*, which is the one power a
doorman is supposed to have. Sealing becomes a clerical act.

## The genesis carries its own consent

```ts
export interface Genesis {
  protocol: number;
  gameId?: string;
  seed: number;
  startedAt: number;
  map: MapConfig;
  rules: Rules;
  empires: EmpireSpec[];
  consent?: SignedConsent[];   // new
}
```

(`packages/sim/src/types.ts:225`.) `gameIdOf` strips only `gameId`
(`genesis.ts:41`), so consents are hashed into the game id like everything
else. Verification is not circular: strip `gameId` and `consent`, recompute
`proposalId` from what remains, check each signature against it.

`inspectGenesis` gains one problem code, `consent`, raised when a keyed member
has no valid consent for the record it is seated in.

This buys something the series does not otherwise have. **An archive can
today prove what happened; it cannot prove anybody agreed to play under those
rules.** With consents in the record, `verifyArchive` can assert "these four
keys accepted this world" — which starts mattering the moment there is a
leaderboard (0008) and a disputed game.

## Which empire you play

Not in the proposal, because the proposal names nobody. A player says which
empire they want by **claiming** it — the record 0010 designs for mid-game
vacancies, run before step 0 instead of during it. Unclaimed empires at seal
time simply stay vacant, which is what 0010 already makes them.

Pre-game and mid-game arrival stop being two mechanisms. That is the second
reason the world/roster split is worth its cost.

## Lobby chat

Worth having and cheap, but it cannot reuse the `Message` record: those bind
to a game id that does not exist yet. Nor should it bind to `proposalId`, or
the conversation fragments every time somebody edits the map size.

Scope it to the room instead — attributed by connection, ephemeral, and
explicitly not part of the game record. It is a room, not a log, and the log
starts at step 0.

## Custom opponents

`BotProfile` is already fully data-driven and already in the genesis record:
`popMax`, per-phase `steps` and `rate`, `coins` (`packages/sim/src/types.ts`),
carried on `MemberSpec.bot` and read straight from the genesis by the
simulation (`packages/sim/src/sim.ts:133`). `DIFFICULTY`
(`packages/sim/src/specs.ts:84`) is three presets over that type and nothing
more.

So "custom difficulty" needs no new mechanism — only a way to put a profile
where a preset name goes:

```ts
export const simbotFrom = (profile: BotProfile): EmpireSpec => ({
  control: CONTROL.SIMBOT,
  members: [{ kind: MEMBER.BOT, bot: profile }],
});
```

Two clamps already exist and must be pointed at rather than duplicated:
`popMax` is clamped to the rule on state construction
(`packages/sim/src/state.ts:78` — "a difficulty setting can only ever hold a
seat back"), and click rate is floored at `rules.botActionInterval` in
`runSimBots` (`sim.ts:121`) and again for headless bots
(`packages/net/src/peerbot.ts:115`). A hand-rolled profile asking for
`rate: [0, 0]` cannot out-reflex anybody; it is already refused by the floor.
The UI's job is to say so, not to re-implement it.

What the UI must reject before proposing: non-integer or negative durations, an
empty `phases` map (a bot that never acts is a bot that is not there), and a
`popMax` above `rules.popMax` — refusing early for the same reason `checkPlan`
refuses early (`packages/net/src/teams.ts:72`: by the time `inspectGenesis`
catches it, it has already been broadcast).

## What this is not

**It is not a vote.** A vote binds the outvoted, and nothing in Tessera has
ever bound a key that did not sign. Three players cannot impose a duration on
a fourth; the fourth simply is not in that game. The consent set *is* the
roster, so unanimity is not a threshold anybody clears — it is a tautology.

That is the same logic 0010 uses for an empire with no members having an empty
quorum, and it is why this needs no new governance concept.

**It does not weaken refusal.** `inspectGenesis` still runs on arrival and a
record you did not agree to is a record you do not join. Consent is voice
added on top of exit, not in place of it.

## Version numbers

**No bump.** An old build reading a genesis with an unknown `consent` field
hashes it into the same `gameId` and computes identical state; it simply does
not check consent, which is exactly what it does today. That is a security
property degrading, not a divergence, and the series' rule — *a bump is owed
when two builds would compute different state from the same log* — does not
reach it.

Flagged as the one place in the series where the rule says no and it is still
worth asking. The counter-argument is that an unverified consent list is worse
than none, because it looks like proof. If that argument wins, this rides along
with 0002's bump rather than owning one.

## Verification

- `packages/protocol/src/test/proposal.test.ts`: `proposalId` is stable across
  key order and engines; a consent verifies against its proposal and fails
  against a one-field revision of it.
- **Determinism**: two peers independently sealing the same proposal with the
  same consent set produce byte-identical genesis records and the same
  `gameId`. This is the test the whole plan rests on.
- **Roster churn**: a consent signed at rev 4 stays valid as three more players
  consent. The deadlock this design exists to avoid, asserted rather than
  argued.
- **The dishonest sealer test**: the room peer seals a record whose rules
  differ from the proposal that was consented to. Every peer's `adopt` refuses
  it — `gameId` recomputes, and `consent` fails against the altered proposal.
  Replaces the old "dishonest host" test and is strictly stronger: it now
  fails on a check rather than on a courtesy.
- **Exclusion**: a peer whose own consent is missing from a sealed record fails
  the lobby with a distinguishable problem, rather than joining as an observer.
- `simbotFrom` with an absurd profile (`popMax: 99999`, `rate: [0, 0]`) plays
  a deterministic game whose bot never acts faster than `botActionInterval`
  and never banks above `rules.popMax` — the clamps, exercised rather than
  trusted.
- `sim/test/crossenv` unmoved: this plan adds no sim code.

---

# Implementing it

## What ships

| File | What it is |
|---|---|
| `packages/protocol/src/proposal.ts` | new: `Proposal`, `proposalId`, `proposalOf`, `composeGenesis`, `checkConsent` |
| `packages/protocol/src/records.ts` | `TAG_CONSENT`, `SignedConsent`, `signConsent`, `verifyConsent` — beside the other six tags |
| `packages/protocol/src/genesis.ts` | `inspectGenesis` gains `consent`, and its first signature check |
| `packages/protocol/src/wire.ts` | `FRAME.PROPOSAL`, `FRAME.CONSENT`, two decode cases |
| `packages/sim/src/types.ts` | `Genesis.consent?`; the stale phase-order comment on `BotProfile` |
| `packages/sim/src/specs.ts` | `simbotFrom`, `checkProfile` |
| `packages/net/src/lobby.ts` | propose / consent / seal; `Lobby.host` becomes a one-signer wrapper |
| `packages/net/src/archive.ts` | `verifyArchive` says who accepted the world, or that nobody stated it |
| `apps/host` (0006) | seals at `startedAt` with whoever signed by then |
| `apps/web/src/view/LobbyPanel.ts` | a sign button and a revision count — the screen itself is 0014 |

## The lead finding: the body's verification sketch does not close

> "Verification is not circular: strip `gameId` and `consent`, recompute
> `proposalId` from what remains, check each signature against it."

That cannot work, and the reason is the plan's own central decision. What
remains after stripping those two fields still contains **`empires`** — which
is derived from the consent set, is different for every signer count, and is
exactly the field the proposal was designed not to contain. Hashing the
residue hashes the roster, and the deadlock the world/roster split exists to
avoid comes back in the verifier instead of the proposer.

The proposal has to be **reconstructed** rather than uncovered, and then the
whole record recomposed from it:

```ts
// packages/protocol/src/proposal.ts
export function composeGenesis(p: Proposal, consents: readonly SignedConsent[]): Genesis {
  const signers = [...consents].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const empires: EmpireSpec[] = signers.map((c) => ({
    control: CONTROL.HUMAN,
    members: [{ kind: MEMBER.HUMAN, key: c.key }],
  }));
  for (let i = 0; i < p.vacancies; i++) empires.push({ control: CONTROL.HUMAN, members: [] });
  for (const one of p.simbots) empires.push(typeof one === "string" ? simbot(one) : simbotFrom(one));
  return { ...makeGenesis({ ...p, empires }), consent: signers };
}

/** The inverse. Returns undefined for a record this function did not produce. */
export function proposalOf(genesis: Genesis): Proposal | undefined;
```

and verification is one comparison rather than a list of field checks:

```ts
export async function checkConsent(genesis: Genesis): Promise<boolean> {
  const consents = genesis.consent;
  if (!consents) return true;                    // a legacy record claims nothing
  const proposal = proposalOf(genesis);
  if (!proposal) return false;
  const id = await proposalId(proposal);
  for (const c of consents) if (!(await verifyConsent(c, id))) return false;

  const { gameId: _stamp, ...rest } = genesis;
  return canonicalJson(rest) === canonicalJson(composeGenesis(proposal, consents));
}
```

That single line subsumes the whole table under "Who seals". A changed rule, a
seated non-signer, an invented player, a reordered roster, a bot profile
quietly swapped, an extra vacancy — every one of them either fails the
signature check or fails the recomposition, and none of them needs its own
branch. It is the same discipline `SnapshotFrame` already uses: restore it,
hash it, discard it if the number disagrees.

Two obligations fall out, and both are load-bearing:

**Every field of the proposal must be visible in the genesis it produces**, or
`proposalOf` cannot recover it and no consent will ever verify. `simbots`,
`vacancies` and (0013) `banners` are recoverable from `empires` only because
the composition order is fixed: **signers in key order, then vacancies, then
SimBots.** That order is part of the format, not a convenience.

**The proposal carries fully resolved `MapConfig` and `Rules`.** `makeGenesis`
merges `DEFAULT_MAP` and `DEFAULT_RULES` (`sim.ts:36-46`), so a proposal
carrying `{width, height}` produces a genesis carrying nine map fields, and
`proposalOf` cannot know which two were signed. The proposer resolves the
defaults *before hashing* and `makeGenesis`'s merge becomes a no-op on this
path. This also closes a hole the current design never had to think about: two
builds with different `DEFAULT_RULES` would otherwise derive different worlds
from one signed object. With resolved rules they derive the same world, and a
build carrying a rule the proposer had never heard of simply cannot seal that
proposal — noisily, at the recomposition, which is the outcome 0001's supported
set exists to produce.

## Nine things the body assumes that the code does not do

**1. A consent has no way to travel.** `ProposalFrame` is specified; the frame
carrying the signature back is not, and without it the sealer has nothing to
seal. `FRAME.CONSENT` with `{ t, signed: SignedConsent }`, decoded by the same
`isObject(parsed.signed)` clause the other six signed frames share
(`wire.ts:196-203`). Both new frames also have to be *re-sent to a late
arrival*, the way `welcome()` already re-sends `sealed` (`lobby.ts:161`) — in
a persistent room the interesting case is somebody who was not there when the
proposal was posted.

**2. Key order is not tidiness — it is the map.** `placeCapitals` positions
capitals by empire index from the shared seed, so whoever decides the order of
the consent list decides whose capital lands where. If the sealer supplies the
order, the doorman is quietly choosing starting positions, which is a larger
power than "deciding who was late" and is not in the table that argues sealing
is clerical. Sorting by key removes it, costs nothing, and matches what
`seatArrivals` already does for the same reason — "key order, so two
amendments landing on one step are applied in the same order by everyone"
(`lockstep.ts:1071`).

**3. `consent` is checked when it is present, and never demanded.**
`inspectGenesis` is stateless: it can ask "does every keyed member have a valid
signature over this record's own proposal", and it cannot ask "was *I* meant to
be in this". So the check splits in two, and both halves are needed:

- `inspectGenesis` runs `checkConsent` and pushes `"consent"` on failure. A
  record with no `consent` field passes untouched, which is what keeps every
  existing archive, fixture and test green.
- `Lobby` holds what it signed. If we consented to proposal `P` in this room,
  a sealed record must reconstruct to `P` **and** contain our own consent —
  otherwise `fail("the sealed game does not carry your signature")`, which is
  the distinguishable exclusion the Verification section asks for. Without this
  half, an excluded peer adopts the record and becomes an observer, exactly as
  it does today.

**4. A future `startedAt` needs nothing from the simulation and everything from
the lobby.** `targetStep()` clamps at zero (`lockstep.ts:404-405`), so a
record sealed for 19:40 sits at step 0 until 19:40 with no new code. But
`adopt` sets `phase = "playing"` and fires `onStart` immediately
(`lobby.ts:311-315`), so what a player gets is the game screen and a frozen
board. `LobbyPhase` gains `composing` (a proposal is on the table) and
`starting` (sealed, waiting for the instant), and `onStart` fires on the
transition out of `starting`. The driver may still be built early — it is the
screen that must not claim the game is running.

Worth checking rather than assuming while the game sits at step 0: the
readiness pipeline and the stall detector both key off steps, and neither has
ever been asked to hold still for an hour.

**5. `canonicalJson` throws, and proposals now arrive from strangers.**
`"non-finite number in a canonical record"` (`genesis.ts:19`) is raised inside
`gameIdOf`, inside `inspectGenesis`, inside `void this.adopt(...)`
(`lobby.ts:235`) — an unhandled rejection today, reachable by anyone who can
send a `GENESIS` frame. Hashing an arbitrary peer's proposal on receipt widens
the same hole. Every hash of an untrusted object gets wrapped, and a throw is
read as a refusal. `decodeFrame` does the cheap half: a `PROPOSAL` frame whose
`seed`, `startedAt` or `vacancies` is not a finite non-negative integer decodes
to `null` and never reaches the hash.

**6. The bot phase editor cannot offer an ordering, because there is not
one.** `turnOf` builds its cycle with `MODES.map(...)` — a fixed constant,
`expand, attack, defend, fortify, heal, sleep` (`policy.ts:33, 80`). The
comment on `BotProfile.phases` says "in the order they are declared here"
(`types.ts:196-198`) and has been wrong for as long as `MODES` has existed.
Nobody has noticed because the three presets declare their phases in exactly
that order. A custom-profile editor is the first thing that would put the
promise in front of a player, and `canonicalJson` sorts object keys anyway, so
a declared order could not survive a proposal even if the sim honoured it. Fix
the comment in this plan; a profile is a set of durations, not a sequence.

**7. Profile validation needs one home, and it is not the UI.** The body puts
the rejection of `popMax > rules.popMax`, empty `phases` and negative durations
in "the UI's job". There are three composers — the web panel, `--plan`
(0006) and a test — and `checkPlan` already demonstrates the pattern
(`teams.ts:74`, refuse early "while the host can still fix it"). So
`checkProfile(profile, rules): string` goes in `specs.ts` beside `simbotFrom`,
where both `rules.popMax` and `rules.botActionInterval` are already in scope,
and every composer calls it. It refuses; it does not clamp — the clamps at
`state.ts:78` and `sim.ts:121` stay exactly where they are and remain the
things that actually bind.

**8. The lobby HELLO stops mattering, and that is worth stating.** A lobby
hello "proves nothing beyond here is a key to seat me under"
(`lobby.ts:210-213`) — an unproven claim, seated on trust, because the host
was composing from `members` (`lobby.ts:228`). Under this plan nothing is
seated from `members` at all: a seat comes from a signature over the proposal
id, which is a proof of possession by construction. `members` becomes a
presence list for the screen, and the one unauthenticated input in the
composition path is gone. No code change — it is the check that stops being
load-bearing, and the doc that says so should be updated with it.

**9. Nothing bounds how many times one proposal is sealed.** A consent names a
world and a world only, so *any* peer may seal *any* subset of the consents it
has seen, and two seals of the same proposal with different consent sets are
two valid games both carrying your signature. Your client plays the one it
adopted and the other is a record you never touch — but it is a record with
your key seated in it, and 0008 counts verified archives. See "What this plan
does not settle".

## Teams: the dependency the index does not show

The body settles which empire you play by pointing at 0010's claim record —
"run before step 0 instead of during it". 0010 ships **after** this plan, and
`composeGenesis` seats one signer per empire, so on this branch the lobby loses
team-picking: no `composeTeams`, no putting three people on one empire, no
`MAX_SEATS` conversation. That is a real regression from the screen that exists
today, and the plan should not discover it during implementation.

Three ways out, and only the first keeps every plan's tree green:

1. **Ship the machinery with solo empires; teams return with 0010.** One empire
   per signer in key order is precisely what today's picker produces when
   nobody touches it, so the default game is unchanged. A team forms after step
   0 by `ROSTER_AMEND`, which is the mechanism that already exists, and pre-seal
   claiming lands with 0010 — where the record is designed anyway.
2. **Put a slot in the consent.** Deadlocks less obviously than signing the
   plan, but a signer choosing empire 4 is a signer who must re-sign when
   somebody else takes it, which is the same never-settling proposal in
   miniature.
3. **Reorder the series, 0010 before 0009.** Defensible — 0010 depends only on
   0002 — but it makes the hardest plan in the series land first and delays the
   thing every later plan is written against.

**Recommended: (1)**, and it decides the shape of `Lobby.host`. Rather than two
sealing paths, the legacy call becomes a proposal with one signer:

```ts
async host(plan: HostPlan): Promise<boolean> {
  // Unchanged for every caller, and no longer a second way to seal a record.
  const problem = checkPlan(plan, [this.identity.key, ...this.members.values()]);
  ...
  return this.propose(proposalFrom(plan)) && this.seal();
}
```

Which leaves exactly one composer, one verifier and one inverse. The existing
`lobby` and `teams` tests passing unchanged is the check on that wrapper, and
`checkPlan` keeps its job for as long as the old screen does — until 0014
replaces it.

## The seal, stated exactly

1. Any peer broadcasts `PROPOSAL` at `rev` *n*. A later `rev` from the same
   `by` supersedes; a different `by` is a different proposal, and the screen
   shows both. Nothing arbitrates, because nothing has to: a proposal with no
   signatures dies of it.
2. A peer signs `TAG_CONSENT ‖ proposalId` and broadcasts `CONSENT`. Everyone
   holds the set; nobody's copy is authoritative.
3. The room peer (0006) seals at `startedAt`: sort the consents by key,
   `composeGenesis`, `sealGenesis`, broadcast `GENESIS`. `--wait` and `--auto`
   keep their meaning — they decide *when* the room stops waiting, never what
   it seals.
4. Every peer runs `inspectGenesis` (which now runs `checkConsent`), then the
   stateful half, then `adopt`.

`encodeConsent` reuses `preamble(TAG_CONSENT, proposalId)` from `records.ts`
unchanged: the proposal id occupies the slot the game id normally holds, which
is exactly what it is standing in for while there is no game. That is why the
record belongs in `records.ts` beside the other six tags rather than in the new
file — the domain-tag discipline is legible in one place or it is not legible.

## The version-number question, taken

**No bump, and the counter-argument is answered rather than dismissed.**

The body flags the real objection: an unverified consent list is worse than
none, because it looks like proof. That is a claim about what a *reader* is
told, not about what a build computes — an old build handed a consent-bearing
record derives the same `gameId` and the same state, and refusing it would kill
a game for a field it could safely ignore. So the answer belongs in the reader:

```
verifyArchive → problems: []  ·  consent: 4 of 4 keyed seats signed this world
verifyArchive → problems: []  ·  consent: not stated
```

A verdict that distinguishes *checked*, *absent* and *failed* cannot be
mistaken for proof, and it is what 0008 needs anyway. `PROTOCOL_VERSION` stays
where 0002 left it, `LAYOUT_VERSION` does not move, and `sim/test/crossenv` is
the tripwire: this plan adds no simulation code, so if that suite moves,
something has gone in that should not have.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `records.ts`: `TAG_CONSENT`, `SignedConsent`, sign/verify | yes — nothing calls it |
| 2 | `proposal.ts`: `Proposal`, `proposalId`, `composeGenesis`, `proposalOf`, `checkConsent` | yes |
| 3 | `specs.ts`: `simbotFrom`, `checkProfile`; the `BotProfile` comment | yes |
| 4 | `types.ts`: `Genesis.consent?`; `genesis.ts`: the `consent` problem | yes — no record carries the field yet |
| 5 | `wire.ts`: two frames, two decode cases, the numeric shape checks | yes |
| 6 | `lobby.ts`: `propose`, `consent`, `seal`; `host` as a one-signer wrapper | yes — the existing suite unchanged is the check |
| 7 | `lobby.ts`: `composing` / `starting`, and the stateful exclusion check | yes |
| 8 | `archive.ts`: the three-way consent line in the verdict | yes |
| 9 | `apps/host`: seal at `startedAt`; re-send proposal and consents on join | yes |
| 10 | `LobbyPanel`: sign, revise, and a countdown | yes |
| 11 | Docs | yes |

Steps 2 and 6 are the ones to review rather than the ones to write. Everything
else is a field, a frame or a screen; those two are where "the sealer has no
authority" is either true or merely asserted.

Steps 1–5 are one session and touch nothing that runs. 6–10 are a second.
The index's "1–2 sessions" holds only because the proposal *screen* is 0014's
work and not this plan's — what ships here is a sign button on the panel that
exists.

## Docs

| File | Change |
|---|---|
| `docs/mesh/the-lobby.md` | the biggest rewrite in the series: "Hosting: compose, seal, broadcast" becomes propose, consent, seal, verify — and the HELLO note stops being the seating story |
| `docs/protocol/genesis.md` | `consent`, and why hashing it in is not circular |
| `docs/protocol/signed-records.md` | the seventh tag, and the one record whose preamble carries a proposal id instead of a game id |
| `docs/protocol/the-wire.md` | `PROPOSAL` and `CONSENT`; supersede-by-rev |
| `docs/concepts/peers-and-roles.md` | a sealer is not a host; what it demonstrably cannot do |
| `docs/gameplay/bots.md`, `docs/gameplay/difficulty-and-balance.md` | a custom profile is a `BotProfile` in the record; the two clamps, and that the phase set is a set |
| `docs/trust-and-verification/verifying-an-archive.md` | checked / absent / failed, and what each is worth |
| `docs/trust-and-verification/trust-model.md` | the row that changes: the composer stops being trusted for anything but the guest list |
| `docs/clients/host-peer.md` (0006) | sealing at the start time; what `--wait` and `--auto` mean once the roster is signatures |
| `docs/continuity/joining.md` | pre-game arrival and mid-game arrival, and where they still differ |

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| `proposalId` is stable across key insertion order, and across engines | `packages/protocol/src/test/proposal.test.ts` |
| a consent verifies against its proposal and fails against a one-field revision | the same file |
| **`composeGenesis` ∘ `proposalOf` is the identity on every record `composeGenesis` produces** | the same file, over a generated matrix: 1–6 signers × 0–3 vacancies × presets and custom profiles |
| **two peers sealing the same proposal and consent set produce byte-identical records and one `gameId`** | the same file — the test the whole plan rests on |
| a consent signed at rev 4 survives three more signers arriving | the same file |
| consents are sorted by key, and a record whose list is not sorted is refused | the same file |
| **the dishonest sealer: an altered rule, an unsigned seat, a dropped signer, a reordered roster, a swapped bot profile** | the same file — five records, one `checkConsent`, five refusals |
| a genesis with no `consent` field is unchanged in every respect | `packages/protocol/src/test/genesis.test.ts` |
| a non-finite number in a proposal or genesis is a refusal, never a throw | the same file, and `wire.test.ts` for the decode half |
| `PROPOSAL` / `CONSENT` decode, and an unknown frame still returns null | `packages/protocol/src/test/wire.test.ts` |
| **an excluded peer fails the lobby with its own problem rather than observing** | `packages/net/src/test/lobby.test.ts` |
| a peer that signed nothing still refuses a record whose consents do not verify | the same file |
| `Lobby.host` composes what it composes today | the existing `lobby` and `teams` suites, unchanged |
| a game sealed for a future instant sits at step 0, then starts on the same step everywhere | `packages/net/src/test/harness.ts` with a fake clock |
| an absurd profile (`popMax: 99999`, `rate: [0, 0]`) plays deterministically, never faster than `botActionInterval`, never banking above `rules.popMax` | `packages/sim/src/test/rules.test.ts` |
| `checkProfile` refuses an empty phase set, a negative duration and an over-cap `popMax` | `packages/sim/src/test/rules.test.ts` |
| an archive says checked / absent / failed, and a tampered consent list says failed | `packages/net/src/test/archive.test.ts` |
| nothing moved the hash | `sim/test/crossenv` and the recorded fixture; `packages/sim` is not in the diff |

## What this plan does not settle

**One proposal, many games.** Point 9 above. A consent authorises a world, and
nothing bounds how many records get sealed from it — so a stranger can produce
a verified archive seating your key in a game you never played, which under
0008 is a game you abandoned. Binding the consent to a sealer would undo the
inversion the whole plan rests on, so the fix belongs in the counting: a
leaderboard should count a seat only where that seat produced at least one
signed move. Cheap, and it wants writing down in 0008 rather than discovering
after the first disputed game.

**Team composition before step 0.** Deferred to 0010's claim, above.

**The proposal screen.** A sign button and a signer count is what ships here.
The duration control, the vacancy rows, the profile editor and the revision
history are 0014, which is why that plan lists this one first among its
dependencies.

**Lobby chat.** Scoped in the body, unimplemented here — it needs a frame, a
cap and a place on a screen that does not exist yet. It costs an afternoon
whenever 0014 wants it, and nothing else waits on it.

**Sealing without a room peer.** Two tabs in a WebRTC mesh with no host peer
have nobody to seal, and this plan's answer is the one-signer wrapper: the tab
that presses Start seals, exactly as today. A genuinely hostless multi-peer
seal — every peer sealing the set it holds and converging on a game id — is a
different design, and the deadlock argument at the top of this plan is the
reason not to attempt it here.
