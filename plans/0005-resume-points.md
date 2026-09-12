# 0005 — Resume points a stranger can check

Status: built
Depends on: nothing (pays off with 0006, which serves them)
Branch: `resume-points`

## The problem

A returning peer's recovery is snapshot-or-rebuild, and the snapshot path has
a hole that hosting makes wide: `adopt()` proves a snapshot is *internally*
consistent — its bytes hash to the number it claims — but a fabricated state
with a correct self-hash passes it. In a live mesh that is fine; other peers
broadcast signed `CHECKPOINT` frames and a minority peer rebuilds into the
majority (`packages/net/src/lockstep.ts`, the desync path).

But the moment the snapshot's source is a **stranger** — a relay-served room,
a host peer, a latecomer whose only neighbour is someone they have never
played with — that cross-check is gone. `onCheckpoint` currently verifies the
signature and keeps only the hash, so a resumed peer has no way to ask
"which (step, hash) did a quorum of seats actually assert?" This plan makes
the answer travel with the snapshot.

## What ships

### Lockstep retains checkpoint envelopes

At `onCheckpoint` (`lockstep.ts:719`), after `verifyCheckpoint` passes, keep
the whole signed envelope, not just the hash — in a `witnesses` map populated
only at snapshot steps, capped at 8 to match `SnapshotStore`'s tail
(`snapshotInterval` (360) is a multiple of `checkpointInterval` (60), so every
snapshot step is already a checkpoint step and witnesses exist for it).

```ts
resumePoint(): ResumePoint | undefined;         // newest snapshot step with a quorum of witnesses
resume(point: ResumePoint): Promise<boolean>;   // catchUpRoster → catchUpDrops → adopt (existing path, lockstep.ts:1164-1168)
```

### The bundle

New `packages/net/src/resume.ts`:

```ts
export interface ResumePoint {
  step: number; hash: number; data: string;      // as the SNAPSHOT frame
  amendments: SignedAmendment[]; drops: SignedDrop[];
  witnesses: SignedCheckpoint[];                 // (step, hash) signed by seated members
}
export async function verifyResumePoint(genesis, point):
  Promise<{ ok: boolean; endorsed: number; needed: number; problems: string[] }>;
```

`verifyResumePoint` rebuilds the roster from `genesis` + `amendments`
(`catchUpRoster`'s logic, outside the driver), verifies each witness with
`verifyCheckpoint` (already in `packages/protocol`), and requires a majority
of seated keys to have signed that exact `(step, hash)`. Kept outside
`Lockstep` so a client can show "endorsed by 3 of 4 seats" before committing.

### Why this is not a hosting feature

In a WebRTC mesh, a returning peer's only source may still be a stranger —
one other tab it has never played with. The witnesses fix the gap in both
transports; the host peer (0006) is merely what makes the fix *available*
reliably. Nothing here requires a server.

## Serving them

Any peer holding a resume point can serve it — the host peer over
`GET /room/:code/resume` (0006), a browser peer over a data channel it
already has. The reader verifies; the server's only job is retention, and
N holders of the same point cross-check each other the same way peers
already compare hashes.

## Verification

- `packages/net/src/test/resume.test.ts` extends the existing suite:
  - a resume point with a quorum of witnesses is adopted to the right
    (step, hash);
  - one with a correct self-hash but **no witnesses** is refused (the
    fabricated-state attack, now a named test);
  - one witnessed by keys outside the roster is refused;
  - a tampered snapshot (bytes changed, claimed hash unchanged) is rolled
    back — today's `adopt` rollback, re-proven through the bundle path;
  - `endorsed: 2, needed: 3` is reported, not just failed.
- Existing desync/resume suites pass untouched — the witnesses map is
  additive and bounded.

---

# Implementing it

## What ships, and the claim in the docs this plan retires

One new file, four additions to `Lockstep`, and two pages that explain why a
poisoned snapshot fails in terms that do not hold.

The premise is right, and it is stronger than the body states. `adopt()`
checks that the bytes hash to the claimed number, and the hash is FNV-1a over
the snapshot (`packages/sim/src/hash.ts:8`). FNV-1a is a multiply-and-xor
chain over 32 bits, and multiplication by `0x01000193` is invertible mod
2^32 — so producing bytes with a *chosen* hash is not a search, it is
arithmetic. Meet in the middle over five free bytes and any target falls out
in milliseconds:

```
target         bfe534e8
achieved       bfe534e8
suffix bytes   95,189,117,10,2
search time    15 ms
```

`restore()` checks a magic number and a layout version
(`packages/sim/src/state.ts:190-191`) and reads every other field raw, so
five free bytes is a generous requirement — an empire's coin counter or any
stat slot will do.

Two pages say otherwise and need fixing in this plan's diff:

- `docs/concepts/the-one-invariant.md:23-27`: "a peer that wanted to fake
  agreement would still have to produce a real snapshot that hashes to the
  claimed value, and the only way to do that is to run the real simulation."
  The first clause is true and the second is not.
- `docs/trust-and-verification/trust-model.md:16` lists "hand out a poisoned
  snapshot" under **what an attacker cannot do**, because the receiver
  re-hashes it and reverts. The mechanism is described accurately, and the
  verdict holds in a live mesh — but for a reason the row does not give
  (everyone else's signed checkpoints), and not at all once there is nobody
  left to disagree. The row needs its real reason; this plan is what supplies
  one for the second case.

None of this is an argument for widening the hash. The hash is the
compatibility contract; moving it breaks every archive and every peer, which
is 0001's whole subject. The argument is that "content-addressed" was
carrying weight it cannot carry, and that a *signature* is what has to carry
it instead.

## The four gaps between the body and the code

The body's change list is close to right. Four things it does not account
for, in ascending order of how much they change the plan:

**1. Our own checkpoint is signed, broadcast, and thrown away.**
`checkpoint()` at `lockstep.ts:594-599` does
`signCheckpoint(…).then((signed) => broadcast(signed))` and keeps nothing.
Witnesses gathered at `onCheckpoint` (`lockstep.ts:719`) are therefore *other
peers'* only. In a two-seat game the electorate is 2 and the best a peer can
ever hold is 1, which is not a majority: **no two-seat game could produce a
resume point at all**. The fix is to keep our own envelope in the same map on
the way past.

**2. The electorate has to subtract dropped seats.** `Roster` appends and
never removes (`roster.ts`: `amend`, with no counterpart), and ejection lives
in the driver's `ejected` map. A game that has dropped two of four seats
would otherwise need 3 signatures from 2 available signers — so resume points
would stop existing exactly when a long game most needs them. The bundle
already carries `drops`; `verifyResumePoint` must verify them and subtract
the seats they name, and `resumePoint()` must count the same way.
`verifyDrop` at `records.ts:371-386` is the precedent to copy: it builds an
electorate, excludes, and asks for a strict majority.

**3. Nothing makes a snapshot step a checkpoint step.** The body says
"`snapshotInterval` (360) is a multiple of `checkpointInterval` (60), so
every snapshot step is already a checkpoint step". True of the defaults
(`lockstep.ts:97-98`) and of the harness's 24 and 12 — and both are free
options a caller sets independently (`lockstep.ts:585, 604`). Set 100 and 60
and `resumePoint()` returns `undefined` forever, silently, with every other
part of the driver working perfectly. Assert the relationship in the
constructor, where the message can say what is wrong.

**4. `catchUpRoster`'s logic outside the driver is a second implementation of
it.** The body says the verifier rebuilds the roster using "`catchUpRoster`'s
logic, outside the driver". `catchUpRoster` (`lockstep.ts:1179-1197`) also
does driver work — `onSeated`, adopting our own seat, pushing to `applied` —
so it cannot simply be called. Extract `rosterAt(genesis, amendments)` into
the new file, leave the driver's method alone, and add the test that keeps
them honest: feed both the same amendment list and compare `roster.all()`.
Two implementations with a test that they agree is cheaper and safer here
than refactoring the one piece of code that decides who may act.

## The fifth gap, which changes what the plan is for

The body's "Why this is not a hosting feature" says the witnesses fix the
stranger-snapshot gap in a live WebRTC mesh. They cannot, and the reason is
three lines of a comment that is already right:

```ts
/** The step in the request is advisory. A peer rebuilding from a desync wants
 *  a correct state, not an old one — and this peer's newest is the most
 *  correct thing it has to offer. Rewinding it to an archived checkpoint would
 *  only oblige it to replay the very moves it may have applied wrongly. */
private onSnapshotRequest(from: string, _step: number): void {
  this.transport.send(from, {
    t: FRAME.SNAPSHOT,
    step: this.sim.step,        // the present, not a stored step
    …
```

(`lockstep.ts:1136-1141`.) The live mesh answers from **now**, and `now` is
almost never a snapshot step, so it has no witnesses and never will. Making
it witnessed would mean answering from a stored step instead, which means
shipping the moves between that step and the present — and the driver does
not keep them: `drain()` deletes each step's moves as it applies them
(`lockstep.ts:1286-1290`). Only `pending` survives, and `pending` is the
future.

So a witnessed resume point is a **cold-start artifact**, and the plan should
say so in those words. It answers "there is nobody to ask" — a game everyone
left on Tuesday, restarted on Thursday from whatever a host peer kept — and
in that case there are no moves after the point, so a peer restores it and
simulates forward through empty steps correctly. It does not answer "I am a
latecomer to a running game", because for that case the present-state
snapshot plus its re-sent pending moves is both the existing answer and the
right one.

That is not a smaller plan; it is a plan aimed at the case it actually fixes.
The live-mesh stranger gap is *narrowed* rather than closed, and by something
that already exists: a peer that adopts a forged state disagrees at its next
checkpoint, within one `checkpointInterval` (5 s), and rebuilds. The window
is five seconds of a wrong board in a game that has other peers in it. With
nobody else in it, the window is the rest of the game — which is precisely
the case this plan closes.

The body's paragraph should be rewritten to say: the witnesses are not a
hosting feature because a *dormant WebRTC game* needs them exactly as much as
a hosted one; 0006 is what makes them reliably available, not what makes them
necessary.

## `packages/net/src/resume.ts`

```ts
// A state a stranger can check.
//
// adopt() proves a snapshot is internally consistent — its bytes hash to the
// number it claims. That is a content address and not a proof: FNV-1a over
// the snapshot is 32 bits and invertible, so bytes with any chosen hash take
// milliseconds to produce. In a live mesh the gap costs one checkpoint
// interval, because a forged state disagrees with everyone's signed
// checkpoints and the peer that took it rebuilds. It costs the whole game
// when there is nobody left to disagree.
//
// So this file replaces "these bytes hash to this number" with "a majority
// of this game's seats signed that this step had this hash". The signatures
// were already being broadcast (CHECKPOINT, every five seconds, by every
// seat); all that was missing was keeping the envelopes and putting them in
// the same parcel as the bytes.

export interface ResumePoint {
  step: number;
  hash: number;
  /** base64url, exactly as the SNAPSHOT frame carries it. */
  data: string;
  amendments: SignedAmendment[];
  drops: SignedDrop[];
  /** (step, hash) signed by seats. The whole point of the file. */
  witnesses: SignedCheckpoint[];
}

/** Reported rather than reduced to a boolean, because "endorsed by 2 of 4"
 *  is something a player should be shown before they commit to a state, and
 *  "endorsed by 2 of 4, one of whom is not in this game" is a different
 *  situation wearing the same number. */
export interface ResumeTally {
  ok: boolean;
  endorsed: number;
  needed: number;
  problems: string[];
}

/** The roster as it stood at a resume point: the genesis, plus the
 *  amendments the point carries, each re-checked against the roster as it
 *  was when it was signed. In order, and stopping at the first that does not
 *  check out — the records after it were endorsed against a roster this walk
 *  is no longer reproducing, so continuing would be guessing. The driver's
 *  catchUpRoster does the same walk and also does driver work; resume.test
 *  asserts the two agree. */
export async function rosterAt(
  genesis: Genesis,
  amendments: readonly SignedAmendment[],
): Promise<Roster> {
  const roster = Roster.fromGenesis(genesis);
  const gameId = genesis.gameId ?? "";
  for (const record of amendments) {
    if (roster.has(record.amendment.key)) continue;
    if (!(await verifyAmendment(roster, gameId, record))) break;
    const { empire, key, kind, step } = record.amendment;
    roster.amend(empire, key, kind, step);
  }
  return roster;
}

export async function verifyResumePoint(
  genesis: Genesis,
  point: ResumePoint,
): Promise<ResumeTally> {
  const problems: string[] = [];
  const none: ResumeTally = { ok: false, endorsed: 0, needed: 0, problems };
  if (!point || !Array.isArray(point.witnesses) || !isStep(point.step)) {
    problems.push("not a resume point");
    return none;
  }
  const gameId = genesis.gameId ?? "";
  if (!gameId) {
    problems.push("the genesis is unsealed, so nothing can be signed against it");
    return none;
  }

  const roster = await rosterAt(genesis, point.amendments ?? []);

  // Seats that were dropped cannot sign, and counting them in the electorate
  // is what would make a long game unresumable: three signatures needed from
  // two remaining players. Each drop is re-verified here, so a fabricated one
  // cannot shrink the electorate to a majority of one.
  const gone = new Set<string>();
  for (const record of point.drops ?? []) {
    if (record.drop.atStep > point.step) continue;
    if (!(await verifyDrop(roster, gameId, record))) {
      problems.push(`a drop for ${seatName(record.drop)} lacks a quorum`);
      continue;
    }
    gone.add(seatName(record.drop));
  }

  const electorate = roster.all().filter((seat) => !gone.has(seatName(seat)));
  const needed = Math.floor(electorate.length / 2) + 1;
  if (electorate.length === 0) {
    problems.push("no seat is left to vouch for anything");
    return { ...none, needed };
  }

  const endorsed = new Set<string>();
  for (const signed of point.witnesses) {
    const { step, hash } = signed.checkpoint ?? {};
    // A witness for another step, or for a different state at this one, is
    // not evidence about these bytes. It is also not necessarily a forgery —
    // a peer that was desynced at this step signed honestly and was wrong.
    if (step !== point.step || hash !== point.hash) continue;
    const name = seatName(signed.checkpoint);
    if (gone.has(name) || endorsed.has(name)) continue;
    if (await verifyCheckpoint(roster, gameId, signed)) endorsed.add(name);
    else problems.push(`a witness from ${name} does not verify`);
  }

  if (endorsed.size < needed) {
    problems.push(`endorsed by ${endorsed.size} of ${electorate.length} seats`);
  }
  return { ok: endorsed.size >= needed, endorsed: endorsed.size, needed, problems };
}
```

**What `ok: true` means, exactly.** A majority of the seats that could still
sign asserted that this step had this hash. It says **nothing** about the
bytes in `data` — that is `adopt`'s question, and it is answered by
restoring, hashing, and rolling back. Both halves have to run, and the reason
they are separate functions is that a client wants to show the tally *before*
it commits to a state, and a host peer wants to check a point it is only
storing. `Lockstep.resume` is the only thing that runs both, in the only
order that is safe.

## Lockstep: four additions and one restructured line

```ts
/** Signed checkpoints kept whole, at snapshot steps only.
 *
 *  `claims` keeps hashes and is pruned to a forty-second horizon by `forget`
 *  (lockstep.ts:1319-1327), because that is all `compare` needs. A witness
 *  has to outlive the snapshot it vouches for, so it is a separate map with
 *  SnapshotStore's tail — eight — and no other retention rule. */
private readonly witnesses = new Map<number, Map<string, SignedCheckpoint>>();

private witness(signed: SignedCheckpoint): void {
  const interval = this.options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
  const { step } = signed.checkpoint;
  if (step % interval !== 0) return;   // no snapshot here to vouch for
  let at = this.witnesses.get(step);
  if (!at) this.witnesses.set(step, (at = new Map()));
  at.set(seatKey(signed.checkpoint), signed);
  while (this.witnesses.size > SNAPSHOT_TAIL) {
    this.witnesses.delete(Math.min(...this.witnesses.keys()));
  }
}
```

Two call sites. `onCheckpoint` (`lockstep.ts:719-732`) calls it after
`verifyCheckpoint` passes and before `compare`. And `checkpoint()`'s
broadcast becomes:

```ts
}).then((signed) => {
  this.witness(signed);            // ours counts, and a two-seat game needs it
  this.transport.broadcast({ t: FRAME.CHECKPOINT, signed });
});
```

```ts
/** The newest snapshot this peer holds that a majority of live seats signed
 *  for. Newest rather than best: an older point is not safer, only staler,
 *  and staleness costs a returning peer real steps to re-simulate. */
resumePoint(): ResumePoint | undefined {
  for (const step of [...this.witnesses.keys()].sort((a, b) => b - a)) {
    const stored = this.snapshots.get(step);
    if (!stored) continue;
    // Only the witnesses that agree with the bytes we are about to send.
    // A peer that was desynced at this step signed a different hash for it,
    // honestly, and it vouches for somebody else's state rather than ours.
    const agreeing = [...this.witnesses.get(step)!.values()].filter(
      (signed) => signed.checkpoint.hash === stored.hash,
    );
    if (agreeing.length < this.electorate() / 2 + 1) continue;
    return {
      step,
      hash: stored.hash,
      data: encodeSnapshot(stored.data),
      amendments: this.applied,
      drops: this.enforced,
      witnesses: agreeing,
    };
  }
  return undefined;
}

/** Seats that could still sign: the roster, less anyone ejected. */
private electorate(): number {
  const seats = this.roster.all();
  return seats.filter((seat) => !this.ejected.has(seatKey(seat))).length;
}
```

```ts
/** Take a resume point, having checked it. Returns the tally rather than the
 *  boolean the plan body asks for, because a caller that wants a boolean
 *  reads `.ok` and a caller that wants to tell a player why it refused
 *  cannot recover the reason from `false`. */
async resume(point: ResumePoint): Promise<ResumeTally> {
  const tally = await verifyResumePoint(this.options.genesis, point);
  if (!tally.ok) return tally;
  if (point.step < this.sim.step) {
    return { ...tally, ok: false, problems: ["that point is behind us"] };
  }
  const buffer = decodeSnapshot(point.data);
  if (!buffer) {
    return { ...tally, ok: false, problems: ["the snapshot will not decode"] };
  }
  // The roster first, for the reason onSnapshot gives at lockstep.ts:1163-1166:
  // a state whose seats cannot be attributed leaves this peer rejecting moves
  // everyone else accepts.
  await this.catchUpRoster(point.amendments ?? []);
  await this.catchUpDrops(point.drops ?? []);
  if (!this.adopt(buffer, point.hash)) {
    const wrong = "the bytes are not the state they claim";
    return { ...tally, ok: false, problems: [wrong] };
  }
  return tally;
}
```

`adopt` is unchanged and stays the thing that does the restoring, hashing and
rolling back (`lockstep.ts:1219-1252`). `resume` adds the question `adopt`
cannot ask.

And the constructor gains the assertion from gap 3:

```ts
const snap = options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
const check = options.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
if (snap % check !== 0) {
  throw new Error(
    `snapshotInterval (${snap}) must be a multiple of checkpointInterval ` +
      `(${check}), or no snapshot ever lands on a step anyone signed for`,
  );
}
```

## What the tally is for, and the two numbers a client must not round off

`endorsed` and `needed` are the product; `ok` is a convenience. Three cases
a UI has to be able to say out loud:

- **3 of 4.** Ordinary. "Endorsed by 3 of 4 seats" is the honest phrasing;
  "verified" is not, and the difference matters because a witnessed point is
  a statement by *those players*, not by mathematics.
- **1 of 1.** A solo game against SimBots has one keyed seat, so a resume
  point for it is self-attested. `ok` is true and it means exactly as much as
  the one player's word. Correct behaviour, and a UI that renders it the same
  as 3 of 4 is lying by omission.
- **0 of 3.** No witnesses at all — an old build, a fabricated bundle, or a
  point pulled from a step nobody checkpointed. This is the case the body
  calls "the fabricated-state attack, now a named test", and the tally makes
  it legible instead of a bare refusal.

One asymmetry worth naming because 0006 depends on it: **an observer holds no
seat, so it signs no checkpoints and can never be a witness.** A host peer is
therefore the ideal *keeper* of resume points and is structurally incapable
of vouching for one. That is the property that makes serving them safe, and
it should be in the docs in those words.

## What a witnessed resume point still does not prove

A forger with a genuine witnessed `(step, hash)` in hand can still produce
bytes that hash to it — that is the 15 ms above, and no amount of signing
changes it. What the witnesses remove is the freedom to choose the *pair*:
the step and hash have to be ones the game really reached, signed by seats
that really held them, against this game's id.

What remains, stated plainly:

- **In a live game**, nothing: the peer that adopted the forgery checkpoints
  within five seconds, disagrees with everyone, and rebuilds. The forgery
  costs one checkpoint interval of a wrong board on one screen.
- **In a dormant game**, the forger substitutes an arbitrary state for the
  real one at a step the game genuinely reached, and no peer is left to
  contradict it. This plan does not close that. It converts it from "anyone
  can hand you any state" into "anyone can hand you a different state at a
  step this game really had", which is a smaller lie needing a real game to
  hang it on, and it is the honest limit.
- **The fix, if it is ever taken**, is a wider digest of the snapshot bytes
  inside the signed `Checkpoint` record — which changes `encodeCheckpoint`
  (`records.ts:201-218`), invalidates every existing signature, and is a
  protocol bump. 0002 owns the series' only bump and it has already happened
  by the time this lands. So: not here. Record it as the change to make in
  whichever plan next has cause to move `PROTOCOL_VERSION`, and note that
  archives written before it stay verifiable because a checkpoint is not part
  of the archive format.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `resume.ts`: `ResumePoint`, `ResumeTally`, `rosterAt`, `verifyResumePoint`; exports | yes — nothing imports it |
| 2 | `resume.test.ts`: the verifier alone, against hand-built bundles | yes |
| 3 | `Lockstep`: the `witnesses` map, `witness()`, both call sites | yes — additive, nothing reads it |
| 4 | the constructor assertion (gap 3) | yes |
| 5 | `resumePoint()` and `electorate()` | yes |
| 6 | `resume()` | yes |
| 7 | `rosterAt` vs `catchUpRoster` agreement test | yes |
| 8 | Docs, including the two corrections | yes |

Step 3 is the one to watch: it is additive, but it touches `onCheckpoint`,
which is on the path every desync detection runs through. The test that
matters is that the existing `desync.test.ts` and `resume.test.ts` are
unchanged and still pass — the map is a side effect of a function whose
return value nothing new consumes.

## Docs

| File | Change |
|---|---|
| `docs/continuity/resume-points.md` | new: the bundle, the tally, the electorate, the cold-start scope, and what it does not prove |
| `docs/concepts/the-one-invariant.md:23-27` | correct: FNV-1a is not preimage-resistant, the hash is a content *address* and not a proof, and what carries the proof instead |
| `docs/trust-and-verification/trust-model.md:16` | the "poisoned snapshot" row keeps its verdict and changes its reason: signed checkpoints in a live mesh, witnesses for a cold start. Content addressing was never what defeated it |
| `docs/continuity/resume.md` | a third path beside "arrived late" and "rebuilt": cold-starting a dormant game from a witnessed point |
| `docs/continuity/README.md:16` | the resume row gains the new page |
| `docs/trust-and-verification/README.md` | link the new page from the verification side, since a resume point is the second checkable artifact after an archive |

The two corrections are the part of this plan worth doing even if nothing
else in it ships. Neither page misdescribes the code — both describe the
right mechanism — but both attribute a security property to it that the hash
function does not supply, and a documented property that does not hold is
worse than an undocumented one, because it is the reason nobody looks
again.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| a point with a quorum is adopted to the right (step, hash) | `resume.test.ts`, extending the existing suite |
| a correct self-hash with **no** witnesses is refused | the same file — the named fabricated-state test the body asks for |
| and the refusal reports `endorsed: 0, needed: 2` rather than `false` | the same test |
| witnesses from keys outside the roster are refused | the same file |
| witnesses for the right step but a different hash do not count | the same file — the honest-but-desynced signer |
| a tampered snapshot with an unchanged claimed hash is rolled back | the same file, through `resume()` rather than `adopt()` directly |
| **a two-seat game can produce a resume point at all** | the same file — the regression for gap 1, which fails without the `witness(signed)` in `checkpoint()` |
| **a game with two of four seats dropped can still reach a quorum** | the same file — the regression for gap 2 |
| a fabricated drop cannot shrink the electorate | the same file: an unsigned `Drop` in the bundle is ignored, and the tally is unchanged |
| `rosterAt` and `catchUpRoster` agree | the same file, on the harness's amendment fixtures |
| a mismatched interval pair fails loudly at construction | a one-line unit test |
| the witnesses map does not grow | assert `witnesses.size <= 8` after a long harness run |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The two bold rows are the ones that would otherwise ship broken and look
fine: both produce a plan that works in the harness's four-seat games and
fails on the two shapes real players actually have — a game of two, and a
long game that has lost people.

## What this plan does not settle

**Serving them.** `resumePoint()` produces one; nothing here stores or
transmits one. 0006 serves it over `GET /room/:code/resume`, and the archive
beside it is what supplies the moves for any point that is not the present.

**The live-mesh snapshot stays unwitnessed.** Making it witnessed needs the
driver to retain applied moves back to a stored snapshot step so it can
answer from there and catch the asker up. That is a real change with a real
memory cost, and it belongs to whichever plan wants it — not to this one, and
probably not to 0006, whose host peer already keeps the move log as an
archive.

**Choosing between two points.** Two hosts can offer different resume points
for the same game, both with quorums, at different steps. Take the newer;
they cannot disagree at the same step without one of them carrying witnesses
that do not verify. Worth a sentence in 0007 where a listing can name more
than one holder.

**The leaderboard is unaffected.** `rankArchives` reads archives, and an
archive is a move log replayed from the start. A resume point is not an
archive and must never become one: a game whose history begins at a resume
point is `ArchivedGame.from`, which `verifyArchive` already refuses to
replay (`archive.ts:244-250`). That is the correct behaviour and this plan
must not soften it.
