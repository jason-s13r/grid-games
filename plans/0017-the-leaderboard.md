# 0017 — The leaderboard: one table you can recompute, one you can audit

Status: built
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

That works while the archives are there. 0016 does not keep them forever — a
store that did would grow without bound for no one's benefit — so there are
**two tables, and they are audited differently**:

| | **Window** | **All-time** |
|---|---|---|
| over | the archives still held | every game ever applied |
| derived by | replaying them | folding contributions already computed |
| a stranger can | recompute it entirely | check any game they hold a copy of |
| bounded by | 0016's retention | nothing |

The window is the one in the paragraph above and nothing about it changes. The
all-time table is new, and the rest of this plan is mostly about what it costs
to have one.

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
| `apps/api/src/rank.ts` | the window table, and the all-time accumulator |
| `apps/api/src/serve.ts` | `GET /rankings`, `GET /rankings/applied` |
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

## The two tables

```
GET /rankings?window=held            the recomputable one (default)
GET /rankings?window=all             everything ever applied
  → {
      standings:  Standing[],
      counted:    string[] | null,   the corpus — a list for `held`, null for `all`
      games:      number,            how many went into it
      unfinished: number,
      refused:    [ { index, game, problems } ],
      derivedAt:  <iso8601>,
      scope:      "<the sentence that bounds this table>"
    }

GET /rankings/applied?cursor=        the all-time corpus, paged
  → { applied: [ { gameId, steps, appliedAt } ], next? }
```

The shape is `Leaderboard` from `packages/net/src/rankings.ts`, unchanged, plus
three fields only a *hosted* table needs: how many games, when it was derived,
and the sentence that bounds it.

`counted` is a list of ids for the window and `null` for all-time, because an
all-time corpus is unbounded and shipping it inline would eventually be the
largest response the service has. `GET /rankings/applied` is the paged form, and
it is the thing that keeps the all-time table auditable at all.

### Every column is a monoid, so accumulation is exact

The window table is recomputed. The all-time table is accumulated — a running
total, added to when a new archive is applied, never rebuilt from the games it
is over, because after 0016's retention most of those games are gone.

That normally trades accuracy for cost. **Here it does not**, and the reason is
worth checking rather than asserting. This is the whole of the fold
(`rankings.ts:145`):

```ts
row.games++;
if (verdict.winner === empire.id) row.wins++;
row.moves      += member.moves;
row.popSpent   += member.popSpent;
row.tilesTaken += member.tilesTaken;
row.bestMove    = Math.max(row.bestMove,    member.bestSingleMove);
row.bestCascade = Math.max(row.bestCascade, member.largestCascade.tiles);
row.peakTiles   = Math.max(row.peakTiles,   empire.peakTiles);
```

Five sums and three maxima. Both operations are associative and commutative
with an identity — 0 and 0 — so the order games arrive in cannot change the
answer, and a total folded one game at a time equals the same total folded all
at once. `kind` is the only field that is not arithmetic, and it is a sticky
flag rather than a value: `if (seat.kind !== MEMBER.BOT) row.kind = seat.kind`
means *ever held a non-bot seat*, which is a logical OR and a monoid too.

So an accumulated all-time table is **equal** to the table a recompute would
produce, not an approximation of it. Nothing is estimated, nothing decays, and
no figure is a sample. That is the licence for the design and it should be
stated in the docs page, because "running total" reads like a compromise and
this one is not.

The sort is unaffected: it runs over the folded rows at the end, exactly as it
does today.

### The dedupe key is the game id, not the archive's bytes

This is the one thing that would silently break the accumulator, so it comes
before the schema.

An idempotent accumulator needs to know what it has already applied. The
obvious key is a hash of the uploaded file. **It is the wrong one.** Two
observers archiving one game produce two different files — different message
sets, different `steps`, different byte counts — that both verify and describe
the same game. Keyed on file bytes they are two rows; keyed on `gameId` they
are one.

`gameId` is a SHA-256 over the canonical genesis, so it identifies the *game*
and is exactly what `rankArchives` already dedupes on (`seen.has(id)` at
`rankings.ts:136`, with the comment that two observers on one game is the
normal way to keep an archive safe). The applied-set is keyed the same way, and
`docs/trust-and-verification/leaderboard.md` already says why.

### Two honest archives of one game can disagree

They cannot disagree about anything they both cover — the hash is over the
replay — but one may stop earlier. An observer that closed its laptop at step
40,000 and one that ran to 120,000 both produce a verifiable archive of the
same game with different `steps` and different totals, and neither is wrong.

`rankArchives` resolves this by first-wins, and for a table recomputed from a
pile of files that is harmless. Baked into a permanent accumulator it is not:
whichever copy happened to be uploaded first becomes the game's contribution
forever.

So the applied-set stores the contribution, not just the fact:

```sql
create table applied (
  game_id      text        primary key,   -- the game, not the file
  steps        bigint      not null,       -- how far this copy got
  contribution jsonb       not null,       -- the Counted rows this game added
  applied_at   timestamptz not null
);
```

and a later archive of a game already applied, with a **greater `steps`**,
subtracts the old contribution and adds the new. Sums subtract cleanly. Maxima
do not — a max cannot be un-maxed without the values behind it — so those three
columns are recomputed for the affected keys from their stored contributions,
which is a query over that key's rows rather than a replay of anything.

`contribution` is small: a handful of seats, ten numbers each. A few hundred
bytes per game against megabytes of archive, which is the trade that makes all
of this work — **0016 evicts the blob and keeps the row.**

### What this costs, said plainly

Accuracy costs nothing. Auditability costs something, and the plan should not
pretend otherwise.

While a game's archive is held, anyone can fetch it and check that the service
applied it correctly. Once 0016 has evicted the blob, that game's contribution
is **the service's own word**. Nobody can re-derive it from nothing, and a
service that fabricated a row for a game that never existed could not be caught
by arithmetic.

Three things narrow that, and together they are most of the way back:

1. **The applied-set is published.** `GET /rankings/applied` lists every
   `gameId` ever counted, with its `steps` and its contribution. The fold is
   therefore checkable by anybody: the totals are a pure function of a list the
   service publishes, and an arithmetic error is visible without holding a
   single archive.
2. **Anyone who kept a copy can audit their own game.** A player who saved the
   log, or a second observer who archived the same session, can replay it and
   compare their `Counted` to the published contribution. That is not a
   theoretical audience — two observers on one game is the normal arrangement.
3. **`gameId` is still a hash.** A fabricated entry needs a genesis that hashes
   to it, and the contribution must be consistent with a game that record could
   produce. It is not free fiction; it is fiction that has to survive anyone
   who bothers to ask for the archive back.

What remains, and what the scope sentence has to carry: **an evicted game's
existence is unfalsifiable by a stranger who never held it.** That is a real
reduction from the window table, and it is the price of an all-time figure in a
system with no index of finished games.

### The two scope sentences

The window keeps the one the web client already uses, because it is still true:

> Over the archives this service holds — not every game ever played.

All-time needs its own, and it has to say the quiet part:

> Over every game applied here since <date>. Archives for older games are no
> longer held, so those figures can be checked against the published list of
> what was counted, but not replayed from here.

A hosted leaderboard that quietly drops either qualifier is the failure mode,
and it fails silently — the table looks identical.

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
| 3 | `rank.ts`: the window table, folded from held archives on a timer | yes |
| 4 | `GET /rankings?window=held` | yes |
| 5 | the `applied` table, and the accumulator: apply, supersede, never double | yes |
| 6 | `GET /rankings?window=all` and `GET /rankings/applied` | yes |
| 7 | `apps/web/src/net/rankings.ts`: fetch a hosted table | yes |
| 8 | `Leaderboard.ts`: the mood, the two windows, the sentence that names the host | yes |
| 9 | the agreement tests (below) | yes |
| 10 | docs | yes |

Steps 1 and 5 are the two to review rather than write. Step 1 touches a file
two shipped callers depend on, and the only thing between "a refactor" and "a
change in what the table says" is step 2. Step 5 is the only place in this
service where a number is kept rather than derived, and step 9 is what keeps it
honest — build an all-time table by accumulation and a window table by
recomputation over the *same* games, and require them to be identical.

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
| **the window table equals a local `rankArchives` over the same corpus** | `apps/api/src/test/rankings.test.ts` |
| **an accumulated all-time table equals a recomputed one over the same games** | the same file — the monoid claim, checked rather than argued |
| the order games are applied in does not change the all-time table | the same file, applying the same set in three orders |
| a refused archive is absent from `counted` and present in `refused` | the same file |
| a second copy of one game does not double a key's `games` | the same file |
| a second copy keyed on different *bytes* still does not double it | the same file — the dedupe key is the game id |
| a longer archive of an applied game supersedes it, sums and maxima both | the same file |
| a SimBot seat contributes no row | the same file |
| evicting an archive leaves the all-time table unchanged | the same file |
| evicting an archive removes it from the window table entirely | the same file |
| the applied-set is complete enough to re-derive the all-time table | the same file, folding `GET /rankings/applied` and comparing |
| the window response carries `counted`, so a reader can fetch and re-derive | the same file, by actually doing it |
| the web client renders the host's name in the scope line | `apps/web/src/test/leaderboard.test.ts` |
| the local path still works with no service configured | the same file |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The first two rows are the plan. If the window table and a table anyone can
compute from the service's own published corpus ever disagree, the endpoint is
a claim rather than a derivation and the argument for hosting it is gone. And
if accumulation and recomputation ever disagree over the same games, the monoid
argument is wrong somewhere and the all-time table is an estimate — which is a
different product, and not one worth shipping.

## What this plan does not settle

**Accounts, and names on the table.** Named above at length. A key is the
identity; binding several keys to one person is a signed record somebody can
check, not a row in this service's database, and it is not built here.

**Seasons, filters and slices.** `?since=`, `?size=`, `?length=` — each is a
new claim about which games were in a table, and each needs its own published
membership before it means anything. The shape exists (`counted` is the
corpus), so a slice is not hard; it is just four more things that can silently
mislead, and none of them is needed to put a table on screen.

**Completeness.** The service ranks what it holds and what it was given.
Nothing makes a host peer upload, nothing notices a game that ended and was
never archived, and no sentence in this plan claims otherwise. The two scope
lines are the whole answer and it is why they are deliverables.

**An all-time table cannot be repaired.** If a bug in the accumulator, or an
archive that should never have been applied, gets into the total, the only
honest fix is to refold the applied-set from the beginning — which works
exactly as long as `contribution` was stored correctly, and not at all if the
bug was in what was stored. The window table has no such failure mode, because
it is a pure function of files that still exist. Keeping the applied-set
forever is what makes the repair possible; nothing makes it certain.

**Cost at scale.** A fold over held archives is cheap and the accumulator is
cheaper; the ingest replays are not, and they do not get shorter as the corpus
grows. 0016's queue is the place that bites first, and a service that becomes
popular will need a different answer there before it needs one here.

**The `index` field.** It is a position in an input list, which is meaningful
to a local caller and not across a wire. It is kept so `Leaderboard` does not
fork into two types, and a hosted reader should use `game` instead.
