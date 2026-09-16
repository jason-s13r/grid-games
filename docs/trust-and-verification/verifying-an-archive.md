# Verifying an archive

[`verifyArchive(game)`](../../packages/net/src/archive.ts#L225) checks an
[archive](archive-format.md) the way a stranger would — **trusting nothing in the
file**.

## The four checks

1. **Re-hash the genesis.** [`inspectGenesis`](../protocol/genesis.md) confirms
   it is a game this build can play and that its `gameId` matches the record.
2. **Rebuild the roster** from the genesis, then apply the `amendments` — each
   [`verifyAmendment`](../protocol/signed-records.md)'d against the roster as it
   stood then. **Amendments first**, because a move signed by a substitute is
   only verifiable once the roster knows the seat that endorsement created.
3. **Check every signature.** Each `SignedMove` is
   [`verifyMove`](../moves/move-encoding.md)'d against the roster. A bare move is
   only allowed if it is a `ROSTER_AMEND` at a step an amendment named — anything
   else unsigned is somebody's addition after the fact. A valid signature from a
   seat that **did not exist yet** (`move.step < seatedAt`) is still a forgery:
   the key is real, the moment is not.
4. **Replay to the hash.** A fresh `Sim` is `fastForward`ed through the whole
   `moveLog` to `game.steps`, and its hash is compared to `game.hash`. This is
   the point — everything above says the inputs are genuine; this says they
   produce the world the archive claims.

## Verdict

```ts
interface Verdict {
  ok: boolean;
  hash: string;        // what THIS engine reached — the number really being claimed
  steps: number;
  moves: number;
  verified: number;    // moves that carried a signature this roster accepts
  problems: string[];  // everything wrong; empty when nothing is
  consent: ConsentVerdict; // whether the players are on record as agreeing to this world
  winner: number;      // read off the replay, not the archive
  summary: EmpireSummary[];
}
```

Four kinds of tampering are four distinct entries in `problems`: an **edited**
move (`bad signature at step N`), an **invented** move (`unsigned move at step
N`), a **removed** move (`hash mismatch`), and a **simply-asserted** outcome
(also `hash mismatch`).

### What consent adds

An archive could always prove **what happened**. It could not prove that anybody
**agreed to the rules it happened under** — which starts mattering the moment
there is a [leaderboard](leaderboard.md) and a disputed game.

`verdict.consent` has three states, and the third value is the point:

```
consent: 4 of 4 keyed seats signed this world   // checked
consent: not stated                             // absent
consent: claimed, and it does not check out     // failed
```

An unverified consent list is worse than none, because it looks like proof. A
reader that cannot tell *checked* from *absent* would read every archive written
before [co-signed genesis](../mesh/the-lobby.md) as an accusation, and every
forged one as a fact.

`absent` is deliberately **not** a problem: a record that claims nothing fails
nothing. `failed` is one, and arrives through `problems` as `genesis: consent`
by the ordinary `inspectGenesis` route — so this field adds the two verdicts
that are not faults, and nothing else.

## Fragments

A `from` archive still runs every signature check — the signatures on a fragment
are as real as any others, and knowing who played is worth having. But the replay
is meaningless (the moves that built the starting state are missing), and
`verifyArchive` says so in `problems` rather than in the mismatch it is about to
produce.

## As a command

`tessera-observe verify <dir | file.json>` ([observer](../clients/observer.md))
prints `VERIFIED` / `REFUSED` and exits `1` on refusal. The browser hands you the
same file: **Save log**.

[`archive.test.ts`](../../packages/net/src/test/archive.test.ts): "a doctored
archive is caught — edited / invented / removed move, asserted outcome, wrong
game id".
