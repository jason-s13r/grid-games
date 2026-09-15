# 0011 — Applications: asking an empire for a seat

Status: built (2026-09-16)
Depends on: nothing (sibling of 0010; either may land first)
Branch: `applications`

## The problem

Joining an existing empire is invite-only, and there is no way to knock.
`Lockstep.amend` (`packages/net/src/lockstep.ts:897`) opens with

```ts
const seat = this.options.seat;
if (!seat || !this.options.identity || this.halted) return false;
```

so only somebody already holding a seat can propose one. An observer watching
a game they would like to play has no move available except saying so in chat
and hoping.

## Why the obvious fix is wrong

The tempting version is "let a seatless peer broadcast an amendment with zero
signatures and wait for endorsements". `considerAmendment` refuses it, on
purpose:

```ts
if (tally.needed === 0 || tally.endorsed === 0) return;
// Nothing valid in it. A stranger's forgery must not be stored, gossiped,
// or — worst of all — allowed to hold the game open at its named step.
```

(`lockstep.ts:990`.) That line is doing two jobs. It stops junk being
gossiped, and it stops an unsigned record calling `hold()` and pinning
`amendCeiling` below a step nobody is going to vote on — a free denial of
service against the pipeline. An application arriving as an unsigned amendment
is indistinguishable from that attack, and it should be.

## What ships

A distinct record, signed by the person asking:

```ts
// tag: tessera/application/1
export interface Application { empire: number; key: MemberKey; step: number; }
export interface SignedApplication { application: Application; sig: string; }
```

Signed by `application.key` itself — the same construction as 0010's `Claim`,
and for the same reason: a record that names its own key can be verified by a
peer that has never heard of the signer. The two are siblings. **A claim seats
immediately because there is nobody to ask; an application seats when the
people already there agree.**

Three properties, each answering something the zero-signature version could
not:

- **It never calls `hold()`.** An application carries no scheduling weight and
  names no step the pipeline must reach. Only the amendment it turns into
  does. This is the whole of the DoS answer.
- **`step` is when it was asked**, kept for display and expiry, not for
  seating. When a member endorses, a *fresh* `Amendment` is built at
  `sim.step + AMENDMENT_DELAY` by the existing path, so a request made an hour
  ago cannot land in the past — the case `considerAmendment` currently handles
  by rebuilding from a snapshot (`lockstep.ts:961`).
- **It is bounded.** A `pending` map capped at 32, keyed `empire:key`, oldest
  evicted, one live application per key across the whole game. An applicant
  who is refused can ask again; an applicant who floods is dropped by the cap
  rather than by a judgement about who deserves a seat.

## The endorsement side

`Lockstep` gains:

```ts
apply(empire: number): Promise<boolean>;          // seatless peers only
applications(): SignedApplication[];              // drives the UI list
accept(empire: number, key: MemberKey): Promise<boolean>;  // a seated member agrees
```

`accept` is thin: it calls today's `amend(key)` with the applicant's key, and
everything downstream — the quorum, the merge, the gossip, the seating — is
the machinery that already exists and is already tested
(`packages/net/src/test/amendment.test.ts`). This plan adds a way to *ask*; it
changes nothing about how the answer is reached.

`onApplication?: (application: Application) => void` fires on the empire being
asked, mirroring `onInvitation` (`lockstep.ts:222`).

Refusal needs no record at all. An application that nobody endorses expires,
and "we did not seat you" is the absence of an amendment rather than a signed
rejection — the same reasoning that keeps muting local in
`apps/web/src/view/Chat.ts:12`. A signed refusal would be a rule about who may
ask, which is a different and much worse feature.

## No sim change, no version move

Nothing here reaches `packages/sim`. An application is never applied to the
world; it is a request that turns into the ROSTER_AMEND that already exists.
`FRAME` gains one additive member and `decodeFrame` returns null for it on
older builds (`packages/protocol/src/wire.ts:25`), so a mixed mesh degrades to
today's invite-only behaviour rather than desyncing.

## Verification

- `packages/net/src/test/application.test.ts`:
  - a seatless peer applies; the empire's members see it; one endorsement on a
    single-seat empire seats them; on a three-seat empire two are needed;
  - an application does **not** move `amendCeiling` — the pipeline advances at
    the same rate with one outstanding as with none (the DoS claim, measured);
  - an application made 5,000 steps before its endorsement still seats, at a
    fresh step, with no snapshot request (the stale-step claim);
  - 200 applications from 200 keys leave the map at 32 and the game running;
  - a forged application (signature by another key) is dropped and not
    gossiped.
- The existing amendment suite passes untouched — the quorum path is not
  modified, only newly reachable.

---

# Implementing it

A plan of action for 0011, written after reading the code it names. Every line
number below was checked against the tree at `docs` HEAD.

The body is right about the shape and right about the danger it is avoiding.
Where it is wrong is smaller than 0010's error and lives entirely in one
method: **`accept` is not one call, it is two, and which one it is depends on
whether somebody on your empire has already agreed.** Get that wrong and the
feature fails silently — no error, no record, nothing gossiped, an applicant
watching a button do nothing.

## What ships

| File | Change |
|---|---|
| `packages/protocol/src/records.ts` | `Application`, `SignedApplication`, `TAG_APPLICATION`, `encodeApplication`, `signApplication`, `verifyApplication` |
| `packages/protocol/src/wire.ts` | `FRAME.APPLICATION`, `ApplicationFrame`, one `decodeFrame` case |
| `packages/protocol/src/index.ts` | export the six new names and two new types |
| `packages/net/src/lockstep.ts` | `apply`, `applications`, `admit`; the `asked` map, `onApplication`, `refreshApplication`, `expireApplications`; rename `private accept` → `book` |
| `packages/net/src/test/harness.ts` | `applicants?: number` — a keyed, seatless peer that `pumpAll` actually pumps |
| `packages/net/src/test/application.test.ts` | new |
| `apps/bot/src/main.ts` | `--apply <empire>`, and delete the paragraph of usage text that documents the workaround |
| `docs/continuity/joining.md` | a fourth way in |
| `docs/continuity/roster-amendments.md` | who may start one |
| `docs/protocol/signed-records.md` | the third self-signed record shape |
| `docs/protocol/the-wire.md` | the new frame |
| `docs/concepts/peers-and-roles.md` | what an observer can now do |
| `docs/clients/bot.md` | the flag that replaces the key-paste |

Nothing in `packages/sim`. Nothing in `archive.ts`. Nothing in `state.ts`. That
is not an accident of scope — see **Why no version number moves**.

## The lead finding: `accept` is two different calls

The body says `accept` is thin:

> `accept` is thin: it calls today's `amend(key)` with the applicant's key, and
> everything downstream — the quorum, the merge, the gossip, the seating — is
> the machinery that already exists.

That is true for the **first** member of the empire to agree, and false for
every one after them.

`amend` (`lockstep.ts:897`) builds a *new* `Amendment` at
`sim.step + AMENDMENT_DELAY` and hands it to `considerAmendment`. A record is
keyed by `${empire}:${key}@${step}`, and the endorsement lock is keyed by
`${empire}:${key}` without the step, with the comment that says exactly why
(`lockstep.ts:283`):

> At most one endorsement per empire-and-key, ever. Two records naming
> different steps then cannot both reach a quorum, so the mesh cannot split
> over which step the newcomer's seat appeared on.

Walk a three-seat empire through it. Alice clicks accept, so `amend` proposes
step *S*, `considerAmendment` signs it, `endorsedAmend` locks `1:bob`, the
record goes out with one signature of the two it needs. Bob clicks accept.
`amend` proposes step *S′*, a **different slot**. Bob reaches the signing
branch at `lockstep.ts:978` — and `endorsedAmend` is empty on Bob's driver, so
he signs. Now there are two live records for one proposal, at two steps, each
carrying one signature of two, and each driver has spent the one endorsement it
is ever allowed to spend on `1:bob`. Neither can ever carry. Both expire at the
steps they name. The applicant is not seated, and the two people who both said
yes are told nothing.

Worse in the other direction: if Bob clicks accept **twice**, the second
`amend` builds a third record, the lock refuses him a signature, the tally is
`endorsed: 0`, and `lockstep.ts:990` drops it on the floor —

```ts
if (tally.needed === 0 || tally.endorsed === 0) return;
```

— which is the correct behaviour for a stranger's forgery and an invisible
no-op for the empire's own member.

**The fix.** `accept` dispatches on whether a proposal is already in flight:

```ts
/** Agree to an applicant. The first member of the empire to call this starts
 *  a proposal; everyone after them signs the one that exists.
 *
 *  Both halves are today's machinery — the split is not a new mechanism, it is
 *  the one `endorsedAmend` has always required and that `amend` has no way to
 *  discover for itself. A member who calls this twice gets the second call
 *  refused here rather than silently dropped at the tally. */
async admit(empire: number, key: MemberKey): Promise<boolean> {
  const seat = this.options.seat;
  // `amend` reads the empire off our own seat and ignores its argument, so an
  // unguarded call from empire 2 on empire 1's applicant would seat them here.
  if (!seat || seat.empire !== empire) return false;
  if (this.roster.has(key)) return false;
  if (!this.asked.has(`${empire}:${key}`)) return false;
  if (this.endorsedAmend.has(`${empire}:${key}`)) return false;
  return this.invitation(empire, key) ? this.endorse(empire, key) : this.amend(key);
}
```

Three of those four guards are findings in their own right, so they are broken
out below. And the name: **`accept` is taken.** `private accept(signed:
SignedAmendment)` is at `lockstep.ts:1009`, and its own doc comment gives the
better name away — "Book a carried amendment onto the step it names." Rename it
`book` and the public method can be called `admit`, `accept`, or whatever 0014
finds readable. Do the rename first, in its own commit, so the diff that adds
the feature is not also a rename.

`pending` is taken too: `private readonly pending = new Map<number,
SignedMove[]>()` at `lockstep.ts:233` is the move buffer. The application map
is `asked`.

## Ten things the body assumes that the code does not do

1. **`amend` ignores the empire you name.** It reads `this.options.seat.empire`
   (`lockstep.ts:900-908`). A public `accept(empire, key)` that forwards to it
   without checking would let a member of empire 2, clicking a row in a list
   that shows every empire's applicants, invite that applicant onto **their
   own** team. Silent, signed, and correct as far as every peer is concerned.
   Guard it at the entry point.
2. **`amend` returns `true` when nothing happened.** `await
   this.considerAmendment(...); return true;` — the return value has never been
   an answer, and the body's `Promise<boolean>` signatures inherit that. Say so
   in the doc comment or return the tally.
3. **An application to a full or a dead empire can never carry, and nothing
   says so.** `validate` refuses a dead empire at `rules.ts:254` and caps seats
   at `rules.ts:266` — `min(maxSeats, SEAT_CEILING)`, which is **4** by default
   (`constants.ts:98`). An applicant to a four-seat empire waits forever on a
   request no quorum could pass. `apply()` should refuse, the way
   `tallyAmendment` refuses by returning `needed: 0`.
4. **`step` is chosen by the applicant and nothing bounds it.** The only
   ceiling is `u32` in the encoder. An application naming step 4,000,000,000
   never expires, and the body's "kept for display" would display a lie. Same
   gap as 0010's `Claim.step`, and it wants the same answer: a skew window
   against the receiver's own `sim.step`.
5. **There is no expiry.** `expireAmendments` runs at the top of every step
   (`lockstep.ts:1043`, called from `pump` at `:422`); nothing equivalent
   exists for applications and the body names no rule. See **An application
   nobody re-sends**, which supplies one for free.
6. **An observer cannot chat either.** The problem statement says an observer
   "has no move available except saying so in chat" — but `say()` returns false
   without a seat (`lockstep.ts:504-508`), and a `Message` carries `empire` and
   `member` fields there is nothing to fill in with. The honest statement is
   stronger than the one in the body: **a seatless peer has no channel to the
   game at all.** Worth fixing the sentence, because it is the argument for the
   feature.
7. **`identity` is documented as the thing that makes an observer.**
   `lockstep.ts:74` — "Absent means observer: it follows, verifies and archives,
   but holds no seat." Every actual test in the file is `!seat`, and the web
   lobby always supplies an identity (`lobby.ts:104`, `readonly identity:
   Identity`), so a browser observer already has a key. `apply()`'s guard is
   `identity && !seat`. Correct that comment in the same commit or the next
   reader will conclude an applicant is a contradiction in terms. The amendment
   suite already has the right words for it — "Watching the game with a key and
   no seat — which is all an observer is" (`amendment.test.ts:114`).
8. **The workaround is documented as the product.** `apps/bot/src/main.ts:49`:
   "It joins as an observer and waits to be voted a seat. Give the key it
   prints to whoever is hosting: they invite it, the empire endorses, and it
   starts playing." That is the strongest argument for this plan anywhere in
   the tree, and `--apply <empire>` deletes the paragraph. It is also the only
   way the feature is reachable end to end before 0014 — see **Order of work**.
9. **`amendCeiling` is private with no getter** (`lockstep.ts:286`). The body's
   central claim — "an application does **not** move `amendCeiling`" — has
   nothing to assert on. A comparison of step counts against a control run
   proves nothing here, because the harness advances on a fake clock either
   way. Add `get ceiling(): number` and the property becomes testable rather
   than inferred.
10. **The harness cannot build an applicant.** `table({ observer: true })`
    calls `build("observer")` with no identity (`harness.ts:214`), which is the
    one peer shape that *cannot* apply. A keyed seatless peer has to be built
    by hand, as `amendment.test.ts:116` does — and because it is not in
    `t.peers`, `pumpAll` never pumps it (`harness.ts:232-236`), so every call
    site must remember `settleNetwork(t, () => joining.pump())`. Add
    `applicants?: number` to `TableOptions`, seated peers first so member
    indices stay stable, and the whole suite stops repeating the ceremony.

## An application nobody re-sends is invisible to the people it is for

The body says an application is stored in a bounded map and never says how it
travels. The answer matters more than it looks, because applications and
amendments have opposite lifetimes.

An amendment is gossiped by **growth**: `considerAmendment` rebroadcasts only
when `record.signatures.length` increased (`lockstep.ts:993-995`). That works
because an amendment lives three seconds and collects signatures the whole
time. An application never grows. It carries one signature, from one key,
forever. Broadcast once at creation and it reaches whoever happened to be
connected in that instant — and a mesh does not form in an instant. The driver
already knows this, at `lockstep.ts:137`:

> A READY is cumulative and idempotent, so repeating one costs a signature and
> nothing else. It is also the only way a peer that was not connected when we
> last spoke ever learns what we are ready for: a full mesh takes a second hop
> to form, and two peers who joined a host at the same moment can easily be
> playing before their channel to each other has opened.

`Transport` has no connection-established hook — `id`, `peers`, `broadcast`,
`send`, `listen`, and nothing else (`transport.ts:14-21`) — so there is nowhere
to hang "tell the newcomer what is outstanding". Relaying is the other option
and it is worse: with no growth signal, a relayed application loops until
something suppresses it.

**Re-sign on a slow timer, exactly as READY does.** `sendReady` re-signs from
scratch every time (`lockstep.ts:573-582`); repeating a standing promise is an
established idiom here, not a new one. An applicant re-signs its application
every thirty seconds or so at the current `sim.step` and broadcasts it. Three
things fall out at once:

- **The step field becomes honest.** It stops meaning "when it was first asked"
  and starts meaning "still asking, as of". A skew check (finding 4) can then
  be strict in both directions, because a live application is never stale.
- **Expiry is free** (finding 5). Drop anything whose step falls more than one
  refresh interval behind `sim.step`. No `expireApplications` deadline to
  choose, no rule to explain.
- **A closed tab withdraws itself.** An applicant who wandered off stops
  refreshing and their row disappears within a minute — which is the behaviour
  you want and which the body's version does not have. Its applications sit in
  the map until evicted by a cap, so the list an empire is looking at is a list
  of people who asked once, some of whom left hours ago.

The cost is one signature per applicant per interval. Set it against
`READY_REPEAT_MS = 1000` (`lockstep.ts:145`) and it is not a cost.

This does change the body's third bullet, which should now read: an application
is bounded *and* self-expiring, and `step` is when it was last refreshed.

## Hold it for one empire, not for all of them

The body's cap is one map of 32, keyed `empire:key`, oldest evicted. Read it as
an attacker: **key generation is free.** Thirty-two throwaway identities fill
the map on every peer in the mesh and evict every real applicant, to every
empire, permanently, for the price of thirty-two signatures. The body's own
sentence — "an applicant who floods is dropped by the cap rather than by a
judgement about who deserves a seat" — inverts under a global cap, where an
applicant who floods drops *everybody else*.

Two changes, both simplifications:

- **Store only applications addressed to our own empire.** A seatless peer
  stores its own outstanding request and nothing else. This is what 0014 wants
  anyway — its roster screen lists "**Applications** to our empire" — and it
  means an opponent's flood costs you nothing at all, because you never held
  their list. It also removes the relay question entirely: with the refresh
  timer above, the applicant reaches the target empire's members directly, and
  nobody needs to forward on anyone's behalf.
- **Then cap at 32 per empire.** Which is now simply 32 per driver, and the
  blast radius of a flood is one empire's own list — the one whose members can
  ignore it.

Keep "one live application per key", and note *why* it is worth keeping, which
the body asserts without arguing. Two simultaneous applications from one key
can both be endorsed: `endorsedAmend` is keyed by `empire:key`, so empire 1 and
empire 2 can each build a carrying amendment for the same person at different
steps. Both book into `seating`; `seatArrivals` skips the second because of
`if (this.roster.has(key)) return` (`lockstep.ts:1080`) — deterministically, as
long as every peer holds both records. A peer that missed the *first* one seats
on the second and desyncs. The rule is not tidiness; it is what keeps that
window shut.

## Why no version number moves — and the one line that makes that true

0010 moves `ARCHIVE_FORMAT`. 0011 moves nothing, and it is worth being precise
about why, because "additive frame, no bump" is a claim that has to be checked
in four places rather than asserted:

| Artefact | Where | Verdict |
|---|---|---|
| `PROTOCOL_VERSION` | `sim/src/constants.ts:8` (3 today, **4** after 0002) | No move. Nothing here reaches the sim, the genesis or the state hash. |
| `LAYOUT_VERSION` | `sim/src/state.ts:20` | No move. An application is never in a snapshot; it is not state. |
| `ARCHIVE_FORMAT` | `net/src/archive.ts:25` | No move. An archive stores the `SignedAmendment` an application became; the application is not the authority for anything and `verifyArchive` never sees one. |
| `FRAME` | `protocol/src/wire.ts:25` | One additive member. |

The degradation claim checks out in all three places a frame can be dropped:
`decodeFrame` returns null on an unrecognised `t` (`wire.ts:255`), and both
carriers drop a null frame without complaint — `mesh.ts:267-268` ("A peer can
send whatever it likes; anything unrecognised is simply not heard, and never
reaches the driver") and `hub.ts:125-126`. An old build never sees the frame,
never counts it as a violation, and behaves exactly as it does today.

One caveat the body should carry: the mixed mesh it degrades gracefully into
only exists **because** nothing bumps. `lobby.ts:226` is a strict equality —
`if (frame.protocol !== PROTOCOL_VERSION) return; // a build we cannot play
with` — so builds either share a protocol number and can mix, or do not and
never meet. In the window after 0002 lands and before everyone updates, the
degradation path is unreachable for a different reason. It costs nothing to
say so.

## The retry the body gets for free

An invitation today is a three-second window (`AMENDMENT_DELAY`,
`lockstep.ts:155`) that opens when someone types a key and closes whether or
not anyone was looking. Miss it and the inviter has to find the key and type it
again. `expireAmendments` releases the endorsement lock at the step the
proposal named (`lockstep.ts:1043-1055`), specifically so the empire can try
again.

With a standing application, retry is a second click on a row that is still
there. The three-second deadline stops being a deadline and becomes a poll
interval: propose, nobody answers, it expires, propose again — against a
request that is still live because its owner is still refreshing it.

Two consequences for the UI contract 0014 will build on, both worth writing
into 0011 rather than discovering in 0014:

- **The count belongs to the amendment, not the application.** "1 of 2 signed"
  comes from `tallyAmendment` on the record in flight and resets to nothing
  when that record expires. The application row does not have a count.
- **`admit` must refuse while our own endorsement is spent**, which is the
  `endorsedAmend` guard above. Otherwise a member who clicks during a live
  proposal they already signed gets the silent no-op of the lead finding, and a
  member who clicks after it expires correctly starts a fresh one.

## Order of work

| # | Step | Leaves the tree green? |
|---|---|---|
| 1 | Rename `private accept` → `book` in `lockstep.ts`. Nothing else. | yes — one commit, zero behaviour |
| 2 | `Application`, `SignedApplication`, `TAG_APPLICATION`, encode/sign/verify in `records.ts`; export them. Range-check `empire` and `step` the way `encodeAmendment` does. | yes |
| 3 | `FRAME.APPLICATION`, `ApplicationFrame`, the `decodeFrame` case, the exports. | yes |
| 4 | `asked` map, `apply()`, `applications()`, `onApplication`, the receive path and the `handle` case. No endorsement side yet. Applications arrive, are stored, are announced, and do nothing. | yes |
| 5 | The refresh timer and the skew/expiry window. Pump-driven, not a `setInterval` — the driver holds no timer, and it says so at `lockstep.ts:16`. | yes |
| 6 | `admit()`, with all four guards. | yes |
| 7 | `get ceiling()`. One line, and the DoS test depends on it. | yes |
| 8 | `applicants?: number` in `harness.ts`; `application.test.ts`. | yes |
| 9 | `apps/bot`: `--apply <empire>`, wired through `onDriver` in `headless/src/peer.ts:121`, which already hands back a driver and an optional seat. Rewrite the usage paragraph. | yes — and this is the first point at which a human can use the feature |
| 10 | Docs. | yes |

Steps 1–3 are mechanical and can land before anyone agrees about step 6.

Nothing here has an ordering constraint against 0010, and the two do not touch
the same lines — 0010 lives in `sim/rules.ts` and `seatArrivals`; 0011 lives in
`records.ts`, `wire.ts` and the amendment API. If both land, factor the
self-signed encode/verify shape once: `Claim` and `Application` are the same
record with a different tag and a different meaning, and the body already says
so.

## Docs

| File | What changes |
|---|---|
| `docs/continuity/joining.md` | The list at `:9` has three ways in. Add the fourth: ask, and be admitted. |
| `docs/continuity/roster-amendments.md` | `:20` says `amend(key, kind)` proposes. Now something else can start one, and the quorum rule is untouched — which is the point worth making, not a footnote. |
| `docs/protocol/signed-records.md` | The self-signed shape: a record naming its own key, verifiable by a peer that has never heard of the signer. Third instance if 0010 landed, first if not. |
| `docs/protocol/the-wire.md` | `FRAME.APPLICATION`, and the additive-frame rule it demonstrates. |
| `docs/concepts/peers-and-roles.md` | `:66` — "An observer can later be voted a real seat" is still true, but it is no longer the only thing an observer can do. |
| `docs/clients/bot.md` | `--apply`. |
| `docs/clients/observer.md` | Whether an archiving observer applies for anything. It should not; say so. |
| `docs/gameplay/empires-and-seats.md` | The seat cap is now a thing applicants run into, not only inviters. |

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| a seatless keyed peer can apply, and the empire's members hear it | `application.test.ts` — `onApplication` fires on both seats of empire 1 and on neither seat of empire 2 |
| one endorsement seats on a single-seat empire | mirrors `amendment.test.ts:127-136` |
| two are needed on a three-seat empire | mirrors `amendment.test.ts:63-68` |
| **two members both calling `admit` seats the applicant** | the lead finding. Alice admits, Bob admits, applicant is seated. Fails today. |
| a member calling `admit` twice inside one proposal is refused, not silently dropped | `admit` returns false; `invitation(1, key)!.signatures` is unchanged |
| a member of empire 2 cannot admit an applicant to empire 1 | `admit(1, key)` from an empire-2 seat returns false and creates no amendment on empire 2 |
| an application does not move `amendCeiling` | `driver.ceiling` is `MAX_SAFE_INTEGER` with an application outstanding, and finite with an amendment outstanding — the control is the amendment, not a step count |
| an application whose endorsement comes long after seats at a fresh step | assert the built amendment's step is `sim.step + AMENDMENT_DELAY` regardless of `application.step`. A 5,000-step run proves the same thing at 5,000× the cost, and `run()` is up to 64 network passes a step (`harness.ts:246`) |
| a stale application is dropped rather than held | advance past the refresh window without pumping the applicant; `applications()` empties |
| a refreshed application survives arbitrarily long | pump the applicant; it does not |
| an applicant who leaves withdraws | stop pumping; the row goes |
| a forged application is dropped and not re-sent | `t.net.connect("mallory")` and a hand-built frame, as `forgery.test.ts:26-34` does |
| 40 applications from 40 keys leave the map at 32 and the game running | 40, not 200 — the cap is 32, and 200 keygens is five times the crypto for the same assertion |
| an opponent's flood does not evict our own empire's applicants | the per-empire scoping. This is the test that would have caught the body's global cap |
| an application to a full empire is refused at `apply()` | `maxSeats: 4`, four seats taken |
| an application to a dead empire is refused | `empire.alive` is false; `validate` would refuse the amendment anyway (`rules.ts:254`), so this is about telling the applicant |
| the mesh degrades rather than desyncing | a peer whose `handle` has no `FRAME.APPLICATION` case still agrees at the end of the run — `agreed(t)` |
| the amendment suite is untouched | `amendment.test.ts` unchanged, and this is the tripwire for the whole plan |
| the sim suite is untouched | `packages/sim` has no diff |

## What came out differently

Written after building it. The appendix was right about the lead finding — `admit`
dispatches, and a three-seat empire fails silently without it — and right about
all ten of its smaller ones. Four things the plan did not have.

**Finding 6 is correct and the body's sentence is worse than it knew.** "An
observer has no move available except saying so in chat" — `say` returns false
without a seat, and a `Message` carries `empire` and `member` fields there is
nothing to fill in. A peer with a key and no seat had **no channel to the game at
all**. That is the argument for the feature and it is now the sentence in
`docs/continuity/joining.md`.

**The refresh has to run from `pump`, not from `apply`.** Written the obvious way
— sign and broadcast once when the request is made, and again "on a timer" — the
request expires: the holder's floor advances with the step and nothing renews the
record. It belongs beside `announceReady` in the pump, rate-limited on the step
count, which is what "the driver holds no timer" means in practice. Caught by the
test that asks whether a request made 900 steps ago still seats.

**The accept side had to ship in the browser, or the feature is half of one.** The
plan makes `apps/bot --apply` the reachable path and leaves the UI to 0014, and
that leaves nobody able to say yes: a bot can ask, but the seats that answer are
in browsers. So `LobbyPanel` grew an **Asking for a seat on your empire** list
beside the invitations it already showed — one row per request, no tally, because
the count belongs to the amendment in flight and resets when that record expires,
exactly as the plan's UI contract says. The standings panel grew the other half:
an observer sees **Ask** beside an empire somebody is playing and **Take it**
beside one nobody has, which are the two doors into a running game, gated on the
same join-window line.

**0010 shipped a button nobody had wired.** The **Take it** row from the vacancy
plan was rendered and had no listener — found by adding its sibling, which is
what a second instance of a pattern is for. Both are delegated from `main.ts`
now rather than from `Controls`, which redraws several times a second and holds
no opinion about the mesh.

## What this plan does not settle

- **Who sees an application before 0014.** Steps 1–8 add a feature with no
  surface; step 9 gives it one in `apps/bot` and nowhere else. A web player
  cannot admit anyone until 0014 ships. That is acceptable and it should be
  stated in the plan rather than discovered — otherwise 0011 lands "complete"
  and nobody can use it.
- **Whether `onApplication` should fire on the applicant's own driver.** It
  wants to know its request is standing; it also cannot verify its own reach.
  Probably a separate local getter, not the hook.
- **The refresh interval.** Thirty seconds is a guess made against
  `READY_REPEAT_MS`. The real constraint is how long a member may be looking at
  a stale list, and nobody has measured that.
- **Whether a refused applicant should be told.** The body's answer — no record,
  refusal is absence — is right and should stay. But an applicant who is
  ignored and an applicant nobody can hear look identical from the outside, and
  that is a UI problem 0014 inherits.
- **The shared self-signed record shape with 0010.** Whoever lands second
  should factor it. Whoever lands first should not try to.
