# 0017 — The leaderboard: a table you can recompute

Status: planned
Depends on: 0016 (the corpus it is over)
Branch: `hosted-rankings`

## The problem

`rankArchives` opens by naming the thing it is trying not to be:

> A leaderboard is normally the least trustworthy thing a game has: a number a
> client reported, kept by a server nobody can audit, and true only if both
> behaved. Here it is neither reported nor kept. Every figure below is read out
> of hashed state after replaying a signed log — so the table is not a record
> of what happened, it is a *derivation* of it, and anyone holding the same
> files derives the same one.

This plan puts that derivation behind a URL, which is the one move most likely
to turn it back into the thing it was avoiding. A hosted table is a number kept
by a server. The whole design problem is making it *not* "a server nobody can
audit" — and the answer is not a promise, it is an endpoint.

**The table ships with its corpus.** `GET /rankings` returns the standings, the
list of game ids counted, the count of unfinished games, and every refusal with
its reasons. A reader who wants to check it fetches those ids from
`GET /archives/:gameId`, runs `rankArchives` locally, and gets the same table or
finds out why not. The service's claim is therefore falsifiable by anybody, and
a falsifiable claim is a different kind of object from a leaderboard.

## Scope is the honest part

`apps/web/src/view/Leaderboard.ts` already renders a sentence under any table
it draws:

> Over the archives this browser was given — not every game ever played.

with a comment saying why: *"The sentence that keeps the table from claiming
more than it is. There is no index of finished games, so this is over what this
browser was handed and nothing else."*

0016 builds an index, but not *the* index. It is an index of what was uploaded
to one service. So the hosted table gets its own version of that sentence —

> Over the archives this service holds — not every game ever played.

— and the plan should treat that line as a deliverable rather than copy. A
hosted leaderboard that quietly drops the qualifier is the failure mode, and it
fails silently: the table looks identical.

# Implementing it

## What ships

| File | What it is |
|---|---|
| `packages/net/src/rankings.ts` | split: verification and tallying become separable |
| `packages/net/src/test/rankings.test.ts` | the two paths agree |
| `apps/api/src/rank.ts` | the table, from the verdict cache |
| `apps/api/src/serve.ts` | `GET /rankings` |
| `apps/web/src/net/rankings.ts` | new: fetch a hosted table instead of replaying locally |
| `apps/web/src/view/Leaderboard.ts` | a mood for a table somebody else derived, and the scope sentence for it |
| `docs/trust-and-verification/leaderboard.md` | the hosted table, and how to check it |

## The split in `rankings.ts`

`rankArchives` does two things in one loop: it verifies each archive and
deduplicates, then it tallies the verdicts into standings. The server has
already done the first half at ingest — 0016 caches a `Verdict` per game —
and re-doing it would mean fetching every blob and replaying every game on
every request.

So the two halves come apart, with the client's behaviour unchanged:

```ts
/** One verified game, reduced to what the tally needs. Small enough to store:
 *  a summary and a seat list, no log and no state. */
export interface Counted {
  gameId: string;
  winner: number;
  summary: readonly EmpireSummary[];
  /** The seats somebody signed for, by `empire:member`. A SimBot holds no key
   *  and so is not here — the players are exactly the seats with one. */
  seats: ReadonlyArray<{ empire: number; member: number; key: MemberKey; kind: MemberKind }>;
}

/** The arithmetic, with the verification already done. Pure, synchronous, and
 *  the only opinion in it is the sort. */
export function standingsFrom(
  counted: Iterable<Counted>,
  refused?: Leaderboard["refused"],
): Leaderboard;

/** Unchanged: verify a pile of archives, then tally what survives. */
export async function rankArchives(games: Iterable<ArchivedGame>): Promise<Leaderboard>;
```

`rankArchives` becomes the verify-and-dedupe loop feeding `standingsFrom`, so
every existing caller — the web worker, `tessera-observe rank` — keeps its
exact behaviour and its exact output. The test that matters is that both roads
arrive at the same place:

```
rankArchives(games)  ≡  standingsFrom(games.map(countedOf))
```

byte-identical, over the fixtures `rankings.test.ts` already builds.

`seatsByIndex` is module-private today and becomes the thing that produces
`Counted.seats`. The seat list is what makes `Counted` self-sufficient: the
tally needs a key per `empire:member` and the verdict alone does not carry one.

## The table, from the cache

```
GET /rankings?limit=&kind=
  → {
      standings:  Standing[],
      counted:    string[],        the corpus this table is over
      unfinished: number,
      refused:    [ { index, game, problems } ],
      derivedAt:  <iso8601>,
      scope:      "Over the archives this service holds — not every game ever played."
    }
```

The shape is `Leaderboard` from `packages/net/src/rankings.ts`, unchanged, plus
two fields that only a *hosted* table needs: when it was derived, and the
sentence that bounds it.

### Recompute, never accumulate

Standings are rebuilt from the `archives` table's cached verdicts. They are not
incremented as uploads arrive.

This costs more and it is the right trade. An accumulated total is a number
only the server has ever held; a recomputed one is a pure function of the
corpus, which means removing a bad archive removes its contribution completely
and leaves no residue. It also means the service cannot drift from what a
reader computes, because there is nothing to drift — the same inputs go through
the same `standingsFrom`.

The recompute is cheap precisely because 0016 cached the verdicts: no blob is
read, no game is replayed, and the work is a fold over a few thousand rows. It
runs on a timer and on ingest, and the result is stored with its `derivedAt`.

### `refused` is served, not swallowed

`Leaderboard.refused` carries `{ index, game, problems }`. `index` is a
position in the input iterable, which is meaningful to a caller who knows the
order of the files it passed in — the web client maps it back to a filename —
and meaningless across a wire. The hosted response keeps `game` and `problems`,
which are the two fields that survive the trip, and keeps `index` only so the
type does not fork.

`docs/trust-and-verification/leaderboard.md` already has the argument:

> a leaderboard that silently drops what it could not check is one nobody can
> audit, and that is precisely the property the signatures were for.

A hosted one has more to hide and the same obligation.

## Identity, and the authority this plan does not take

`Standing.key` is a `MemberKey` — base64url of a 65-byte P-256 point. That is
the only identity Tessera has. Seat numbers are per game. There are no
accounts. `rankings.ts` says it in a comment and it is load-bearing here:

> Keyed by the member key rather than by a name, because a key is the only
> identity this game has: seat numbers are per game and there are no accounts.

Names exist as of 0012, and they are **not in `ArchivedGame`**. 0012 says why
and says it is deliberate:

> Nothing in `ArchivedGame` holds them today and adding a field is an
> `ARCHIVE_FORMAT` move — which is why it is not in this plan.

So the hosted table displays `fingerprint(key)` — the eight hex characters
`tessera-observe rank` already prints — and nothing else. It does not join keys
into people, does not offer a profile, does not let anybody claim a key, and
does not accept a display name.

**This is the plan's one real temptation and it should be named as such.** A
service that holds every archive and every key is one small feature away from
being an accounts system, and an accounts system is an authority: it decides
which keys are the same person, and every figure downstream of that decision is
a number only the server can compute. Nothing in this repository can check it.

If profiles are wanted later, they are a plan of their own with an argument in
it — most likely a self-signed record binding several keys, verifiable by a
reader, which is the shape every other identity claim in this system already
takes. What must not happen is a `users` table arriving as an implementation
detail of a leaderboard.

## Ordering stays untuned

`wins`, then `tilesTaken`, then `bestMove`, then the key itself. The doc page
gives the reason and the hosted table inherits it:

> **Nothing is weighted or tuned** — every column is a count from hashed state,
> and the sort is the only opinion in the file. A rating nobody can explain is
> a table nobody can check, which would give back exactly what the signatures
> were for.

No Elo, no decay, no seasons, no weighting by game length. Each of those is a
formula, and a formula is a claim the corpus cannot settle.

## The web client

Today `buildTable` fetches every archive URL in settings, one at a time, then
posts them to a worker that replays all of them. For a player with six hosts
listed that is six multi-megabyte downloads and six full replays, and it takes
minutes.

With a service configured, there is a second route: fetch the table. The client
already has the mood machine for it — `unset | idle | reading | checking |
table | problem` — and a hosted table skips straight to `table`.

The change is small and the honesty is the whole of it:

- a table the client derived keeps its sentence: *"Over the archives this
  browser was given"*;
- a table the service derived gets the service's: *"Over the archives
  `api.example` holds"*, with the host named, because a reader should be able
  to see whose claim they are looking at;
- and the refusals are rendered either way.

The local path is not removed. A player with a file on disk and no service
configured must still get a table, and the ability to check the hosted one by
replaying its corpus locally is the property the plan is built on — which means
the code that does it has to stay.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `rankings.ts`: `Counted`, `standingsFrom`, `rankArchives` rebuilt on it | yes — no caller changes |
| 2 | the equivalence test: both paths, byte-identical | yes |
| 3 | `rank.ts`: fold the verdict cache into a table, on a timer | yes |
| 4 | `GET /rankings`, with `counted`, `refused`, `scope`, `derivedAt` | yes |
| 5 | `apps/web/src/net/rankings.ts`: fetch a hosted table | yes |
| 6 | `Leaderboard.ts`: the mood, and the sentence that names the host | yes |
| 7 | the agreement test: the service's table against a local `rankArchives` | yes |
| 8 | docs | yes |

Step 1 is the one to review rather than write. It touches a file two shipped
callers depend on, and the only thing standing between "a refactor" and "a
change in what the table says" is step 2.

## Docs

| File | Change |
|---|---|
| `docs/trust-and-verification/leaderboard.md` | the hosted table: what it publishes, and the recipe for checking it |
| `docs/trust-and-verification/trust-model.md` | a row: a hosted leaderboard can show a table over a corpus it chose. It cannot alter a figure in it |
| `docs/clients/api-service.md` | `GET /rankings` |
| `docs/clients/web-client.md` | two ways to get a table, and which sentence goes under each |
| `docs/protocol/identity.md` | a line: a key is still the only identity, and the hosted table does not change that |

The trust-model row is narrow and should stay narrow. A hosted ranker's power
is **selection** — which archives it holds, which it refuses, and what it
chooses to leave out of its corpus. It has no power over the figures, because
every one of them is recomputed from a file whose hash the reader checks. The
defence is that the corpus is published, so selection is visible.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| `standingsFrom` and `rankArchives` produce identical tables | `packages/net/src/test/rankings.test.ts` |
| the existing rankings suite still passes unchanged | the same file — the refactor's real test |
| **the hosted table equals a local `rankArchives` over the same corpus** | `apps/api/src/test/rankings.test.ts` |
| a refused archive is absent from `counted` and present in `refused` | the same file |
| a second copy of one game does not double a key's `games` | the same file |
| a SimBot seat contributes no row | the same file |
| removing an archive from the corpus removes its contribution entirely | the same file — the argument for recomputing |
| the response carries `counted`, so a reader can fetch and re-derive | the same file, by actually doing it |
| the web client renders the host's name in the scope line | `apps/web/src/test/leaderboard.test.ts` |
| the local path still works with no service configured | the same file |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The third row is the plan. Everything else is machinery around it: if the
service's table and a table anyone can compute from the service's own published
corpus ever disagree, the endpoint is a claim rather than a derivation and the
whole argument for hosting it is gone.

## What this plan does not settle

**Accounts, and names on the table.** Named above at length. A key is the
identity; binding several keys to one person is a signed record somebody can
check, not a row in this service's database, and it is not built here.

**Seasons, filters and slices.** `?since=`, `?size=`, `?length=` — each is a
new claim about which games were in a table, and each needs its own published
membership before it means anything. The shape exists (`counted` is the
corpus), so a slice is not hard; it is just four more things that can silently
mislead, and none of them is needed to put a table on screen.

**Completeness.** The service ranks what it holds. Nothing makes a host peer
upload, nothing notices a game that ended and was never archived, and no
sentence in this plan claims otherwise. The scope line is the whole answer and
it is why it is a deliverable.

**Cost at scale.** A fold over cached verdicts is cheap; the ingest replays
that fill the cache are not, and the corpus only grows. 0016's queue is the
place that bites first, and a service that becomes popular will need a
different answer there before it needs one here.

**The `index` field.** It is a position in an input list, which is meaningful
to a local caller and not across a wire. It is kept so `Leaderboard` does not
fork into two types, and a hosted reader should use `game` instead.
