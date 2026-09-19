# The leaderboard

[`rankArchives(games)`](../../packages/net/src/rankings.ts#L112) is a
**derivation, not a record**. Every figure is read out of hashed state after
[replaying a verified log](verifying-an-archive.md) — so the table is not a record
of what happened, it is a *recomputation* of it, and anyone holding the same
files computes the same table.

## Standing

Keyed by [`MemberKey`](../protocol/identity.md) — a key is the only identity this
game has (seat numbers are per-game; there are no accounts).

```ts
interface Standing {
  key: MemberKey;
  kind: MemberKind;   // BOT only if EVERY seat this key held was a bot seat
  games: number;
  wins: number;
  moves: number;
  popSpent: number;
  tilesTaken: number;
  bestMove: number;    // most tiles taken by one claim — the one "moment" figure
  bestCascade: number; // largest cascade, in tiles
  peakTiles: number;   // largest the key's empire grew, shared with teammates
}
```

## Ordering

`wins`, then `tilesTaken`, then `bestMove`, then the key itself (so two identical
records come out in the same order on every machine). **Nothing is weighted or
tuned** — every column is a count from hashed state, and the sort is the only
opinion in the file. A rating nobody can explain is a table nobody can check,
which would give back exactly what the signatures were for.

## Refusal is the interesting part

`rankArchives` takes *every* archive you have and:

- runs [`verifyArchive`](verifying-an-archive.md) on each — a failure lands in
  `refused` with its `problems` and its `index` (its position in the input, so a
  caller can name the *file*, since two archives of one game share a game id);
- **counts a game once** — `seen` is keyed on `gameId`, and two observers on one
  game is the *normal* way to keep an archive safe, not a corner case;
- refuses a **fragment** (`from > 0`) — the stats depend on the part it is
  missing;
- refuses a game with an **unsigned move**;
- credits **only seats somebody signs for** — a [SimBot](../gameplay/bots.md)
  holds no key, so there is nobody to credit.

```ts
interface Leaderboard {
  standings: Standing[];
  counted: string[];      // game ids counted, in order
  unfinished: number;     // counted games with no winner — stats but no wins
  refused: Array<{ index: number; game: string; problems: string[] }>;
}
```

## Hosted: two tables, audited differently

Putting this derivation behind a URL is the one move most likely to turn it back
into the thing the page opens by refusing to be — a number kept by a server
nobody can audit. The answer is not a promise, it is an endpoint: **the table
ships with its corpus.**

```
GET /rankings?window=held        the recomputable one (default)
GET /rankings?window=all         everything ever applied
GET /rankings/applied?cursor=    the all-time corpus, paged
```

`Leaderboard`'s shape, plus the three fields only a hosted table needs: how many
games went into it, when it was derived, and the sentence that bounds it.

| | **Window** | **All-time** |
|---|---|---|
| over | the archives still held | every game ever applied |
| derived by | folding contributions from files still here | folding contributions |
| a stranger can | recompute it entirely | check any game they hold a copy of |
| bounded by | the store's retention | nothing |

### How to check a hosted window table

Fetch `GET /rankings`. Take the ids in `counted`. Fetch each from
`GET /archives/:gameId`. Run `rankArchives` over them. You get the same table or
you find out why not — and a falsifiable claim is a different kind of object from
a leaderboard.

### Why an accumulated total is exact rather than approximate

This is the whole of the fold:

```ts
row.games++;
if (winner === empire.id) row.wins++;
row.moves      += member.moves;
row.popSpent   += member.popSpent;
row.tilesTaken += member.tilesTaken;
row.bestMove    = Math.max(row.bestMove,    member.bestSingleMove);
row.bestCascade = Math.max(row.bestCascade, member.largestCascade.tiles);
row.peakTiles   = Math.max(row.peakTiles,   empire.peakTiles);
```

Five sums and three maxima. Both operations are associative and commutative with
an identity, so the order games arrive in cannot change the answer, and a total
folded one game at a time equals the same total folded all at once. `kind` is a
sticky flag — *ever held a non-bot seat* — which is a logical OR and a monoid
too.

So an all-time table is **equal** to what a recompute would produce, not an
approximation of it. Nothing is estimated, nothing decays, and no figure is a
sample. "Running total" reads like a compromise and this one is not.

The dedupe key is **`gameId`, never a hash of the uploaded file.** Two observers
archiving one game produce two different files that both verify and describe the
same game; keyed on bytes they are two rows and every key in that game is counted
twice.

Two honest archives of one game can also cover different amounts of it — one
observer closed its laptop at step 40,000 and another ran to 120,000 — so a later
archive with **more steps** supersedes rather than duplicating. First-wins is
harmless for a table recomputed from a pile of files and not harmless at all
baked into a permanent total.

### What it costs, said plainly

Accuracy costs nothing. Auditability costs something.

While a game's archive is held, anyone can fetch it and check that the service
applied it correctly. Once it has been evicted, that game's contribution is **the
service's own word**. Three things narrow that:

1. **The applied-set is published.** `GET /rankings/applied` lists every game id
   ever counted with its contribution, so the totals are a pure function of a
   list anybody can fetch — an arithmetic error is visible without holding a
   single archive.
2. **Anyone who kept a copy can audit their own game.** A player who saved the
   log, or a second observer who archived the same session, can replay it and
   compare. Two observers on one game is the normal arrangement, not a
   hypothetical.
3. **`gameId` is still a hash.** A fabricated entry needs a genesis that hashes
   to it and a contribution consistent with a game that record could produce.

What remains: **an evicted game's existence is unfalsifiable by a stranger who
never held it.** That is a real reduction from the window table, and it is the
price of an all-time figure in a system with no index of finished games.

### The two scope sentences are deliverables

> Over the archives this service holds — not every game ever played.

> Over every game applied here since &lt;date&gt;. Archives for older games are no
> longer held, so those figures can be checked against the published list of what
> was counted, but not replayed from here.

A hosted leaderboard that quietly drops either qualifier is the failure mode, and
it fails silently: the table looks identical. The web client renders the service's
own sentence with the host named in front of it, so a reader can see whose claim
they are looking at.

### Identity, and the authority not taken

`Standing.key` is a `MemberKey` and that is the only identity Tessera has. A
hosted table shows `fingerprint(key)` and nothing else. It does not join keys
into people, does not offer a profile, does not let anybody claim a key and does
not accept a display name.

This is the real temptation and it is worth naming. A service holding every
archive and every key is one small feature away from being an accounts system,
and an accounts system *is* an authority: it decides which keys are the same
person, and every figure downstream of that decision is a number only the server
can compute. If profiles are ever wanted they are a plan of their own — most
likely a self-signed record binding several keys, verifiable by a reader, which
is the shape every other identity claim in this system already takes. What must
not happen is a `users` table arriving as an implementation detail of a
leaderboard.

Ordering stays untuned for the same reason. No Elo, no decay, no seasons, no
weighting by game length: each is a formula, and a formula is a claim the corpus
cannot settle.

## As a command

`tessera-observe rank <dir>` ([observer](../clients/observer.md)) prints the
table **and the refusals** — a leaderboard that silently drops what it could not
check is one nobody can audit.

[`rankings.test.ts`](../../packages/net/src/test/rankings.test.ts): "a row per
signed-for seat and no others"; "figures read from the replay, not the archive";
"counted once however many observers"; "refuses an edited archive / a fragment
and goes on counting the rest".
