# Resume points

A **resume point** is a snapshot with evidence attached: the bytes, plus signed
checkpoints from a majority of the seats that could still sign, all asserting that
this step had this hash.

```ts
interface ResumePoint {
  step: number;
  hash: number;
  data: string;                    // base64url, as the SNAPSHOT frame carries it
  amendments: SignedAmendment[];
  drops: SignedDrop[];
  witnesses: SignedCheckpoint[];   // (step, hash) signed by seats
}
```

[`resumePoint()`](../../packages/net/src/lockstep.ts) produces one;
[`verifyResumePoint`](../../packages/net/src/resume.ts) checks one;
`Lockstep.resume(point)` is the only thing that does both, in the only order that
is safe.

## Why a hash was not enough

[`adopt`](resume.md) restores a snapshot, hashes it, and puts the old state back if
the number disagrees. That proves the bundle is internally consistent. It does not
prove the state is the game's, and the reason is arithmetic rather than
carelessness: the hash is [FNV-1a](../concepts/the-one-invariant.md) over the
snapshot bytes, 32 bits, and multiplication by the prime is invertible mod 2^32. So
producing bytes with a **chosen** hash is not a search — meet in the middle over
five free bytes and any target falls out in milliseconds. `restore()` checks a magic
number and a layout version and reads every other field raw, so five free bytes in
any stat slot is a generous requirement.

This was never a live-mesh hole, and it is worth being exact about why. A peer that
adopts a forged state signs a checkpoint five seconds later, disagrees with
everybody, and [rebuilds](desync.md). The property held because of *everyone else's
signatures*, not because of the hash. Content addressing was doing none of the work
the phrase suggested.

The hole is a game with nobody left to disagree: everyone left on Tuesday, and on
Thursday a peer comes back to whatever a [host peer](../clients/headless-peers.md)
kept. There the forged state stands for the rest of the game.

## The electorate

`needed` is a strict majority of the seats that could still sign — the roster at
that step, **less** the seats that were dropped.

Both halves of that matter, and both are regressions waiting to happen:

- **our own checkpoint counts.** A peer keeps its own signed envelope on the way
  past `broadcast`. Without it the witnesses are other peers' only, so in a
  two-seat game the electorate is 2, a majority is 2, and the best a peer could
  ever hold is 1 — no two-player game could produce a resume point at all;
- **dropped seats are subtracted.** A four-seat game that has lost two would
  otherwise need three signatures from two available signers, so resume points
  would stop existing exactly when a long game most needs them. Every drop in the
  bundle is re-verified, because otherwise the cheapest attack is not forging a
  witness: it is claiming everybody else left, so that one signature is a majority.

An **observer holds no seat, so it signs no checkpoints and can never be a
witness.** A host peer is therefore the ideal keeper of resume points and is
structurally incapable of vouching for one — which is exactly what makes serving
them safe.

## The tally, and the two numbers not to round off

```ts
interface ResumeTally { ok: boolean; endorsed: number; needed: number; problems: string[] }
```

`endorsed` and `needed` are the product; `ok` is the convenience. Three cases a UI
has to be able to say out loud:

| Tally | What to say |
|---|---|
| 3 of 4 | "Endorsed by 3 of 4 seats." Not "verified" — a witnessed point is a statement by *those players*, not by mathematics |
| 1 of 1 | A solo game against SimBots has one keyed seat, so its resume point is self-attested. `ok` is true and means exactly as much as the one player's word |
| 0 of 3 | Nobody vouched for this: an old build, a fabricated bundle, or a step nobody checkpointed. A bare `false` cannot tell this from 2 of 3 |

## Both halves have to run

`verifyResumePoint` answers "did a majority sign for this (step, hash)?" and says
**nothing** about the bytes in `data`. `adopt` answers "are these bytes that state?"
and says nothing about whether the state is the game's. A client wants the tally
*before* it commits, and a keeper wants to check a point it is only storing, which
is why they are separate functions — and why `resume()` is the one place that runs
the roster catch-up, the drops, the tally and the adoption in order.

## A cold-start artifact, and why that is the whole scope

A live peer answers a snapshot request from **now** — deliberately: a peer
rebuilding from a desync wants a correct state rather than an old one. `now` is
almost never a snapshot step, so it has no witnesses and never will. Answering from
a stored step instead would mean shipping the moves between that step and the
present, and `drain()` deletes each step's moves as it applies them.

So a witnessed point answers "there is nobody to ask". In that case there are no
moves after the point, so a peer restores it and simulates forward correctly. It
does not answer "I am a latecomer to a running game", because for that the present
state plus its re-sent pending moves is both the existing answer and the right one.

## What a witnessed point still does not prove

A forger holding a genuine witnessed `(step, hash)` can still produce bytes that
hash to it. What the witnesses remove is the freedom to choose the **pair**: the
step and the hash have to be ones the game really reached, signed by seats that
really held them, against this game's id.

- **In a live game**: nothing remains. The peer that adopted a forgery disagrees
  within one checkpoint interval and rebuilds.
- **In a dormant game**: a forger can substitute an arbitrary state for the real
  one at a step the game genuinely reached. This is narrowed, not closed — from
  "anyone can hand you any state" to "anyone can hand you a different state at a
  step this game really had".
- **The fix, if it is taken**: a wider digest of the snapshot bytes inside the
  signed `Checkpoint`. That changes `encodeCheckpoint`, invalidates every existing
  signature, and is a protocol bump — so it belongs to whichever plan next has
  cause to move `PROTOCOL_VERSION`. Archives written before it stay verifiable,
  because a checkpoint is not part of the archive format.

## Not an archive

A resume point is not an archive and must never become one. An
[archive](../trust-and-verification/archive-format.md) is a move log replayed from
the start; a game whose history begins at a resume point is `ArchivedGame.from`,
which `verifyArchive` refuses to replay. That is correct, and the
[leaderboard](../trust-and-verification/verifying-an-archive.md) is unaffected.
