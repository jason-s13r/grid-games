# 0016 — The archive store: a file nobody is trusted to have written

Status: planned
Depends on: 0015 (the app), 0006 (the host peer that writes archives)
Branch: `archive-store`

## The problem

An archive today lives wherever the process that wrote it happens to be.

`apps/host` serves `GET /room/:code/archive` for the games *that process is a
peer in* — `options.rooms.get(code)` misses and the answer is 404 for anything
else. `apps/observer` writes directories on somebody's laptop. A browser tab
offers **Save log** and hands the player a file. All three produce the same
artifact and none of them is a place anyone else can fetch it from a week
later.

The web client's `Archive URLs` setting is the workaround, and the setting's
own help text admits what it is:

> One per line. A host peer serves the log of a game it kept at
> `/room/<room>/archive`, and the leaderboard above is built out of whichever of
> those you list, plus any file you open. There is no index of finished games
> anywhere, so a table here is over what you have and says so.

"There is no index of finished games anywhere" is the gap. This plan builds
one — but the interesting half is not the storage, it is the refusal.

## The property that makes this safe to build

An archive is **self-proving**. `verifyArchive` (`packages/net/src/archive.ts:315`)
re-hashes the genesis, rebuilds the roster from it, walks every amendment and
claim, checks every signature against the roster as it stood, replays the whole
log and compares the result to the hash the file claims. A file that survives
that was produced by the game it says it was, and a file that does not is
refused with a list of reasons.

So the store does not need to know who uploaded anything. It does not need
accounts, API keys, or a trusted set of host peers. It runs the same check a
stranger would run, and stores only what passes. That is the only design here
that does not quietly introduce an authority — and it is available precisely
because 0005 and 0006 did the work of making an archive checkable by somebody
who was not there.

`genesis.gameId` is a SHA-256 over the canonical record. **The content address
is the key.** A second upload of a game already held is a no-op rather than a
duplicate, and the store cannot hold two different files under one id without
one of them failing verification. Content addressing hands this plan its
storage design for free, and it should be said out loud rather than discovered.

# Implementing it

## What ships

| File | What it is |
|---|---|
| `packages/headless/src/store.ts` | **a fix** — `readArchive` loses claims and lies about its format |
| `packages/headless/src/test/store.test.ts` | new: the round trip that fails today |
| `apps/api/src/store.ts` | blobs, S3-compatible |
| `apps/api/src/ingest.ts` | the queue, and `verifyArchive` on the way in |
| `apps/api/src/db.ts` | the `archives` table and the verdict cache |
| `apps/api/src/serve.ts` | three more routes |
| `apps/api/src/test/archives.test.ts` | `fetchArchive` — the web client's own function — against the service |
| `docs/trust-and-verification/archive-format.md` | the store, and what it does not promise |

## Step 1: `readArchive` drops claims, and says it is format 1

This is a live bug in shipped code, it is the reason this plan cannot start
anywhere else, and it is worth stating at length because the failure it
produces names the wrong thing.

`Archive.record` writes a claim line (`packages/net/src/archive.ts:214`):

```ts
this.record({ k: "claim", claim });
```

`readArchive` (`packages/headless/src/store.ts:253`) does not read it back:

```ts
const game: ArchivedGame & { from: number } = {
  format: 1,                                  // ← the writer is at ARCHIVE_FORMAT = 2
  ...
};
...
if (record.k === "move") game.moveLog.push(record.entry);
else if (record.k === "amend") game.amendments.push(record.amendment);
else if (record.k === "chat") game.messages.push(record.message);
//   ← no branch for { k: "claim" }
```

So for any game where somebody claimed a vacancy — which is the entire point of
0010 — a round trip through disk silently discards the claims.

The compounding part is that `verifyArchive` has a guard written for exactly
this file, and the guard cannot fire:

```ts
if ((game.format ?? 0) < 2 && (game.claims?.length ?? 0) > 0) {
  // A v1 archive that carries claims is a file whose own header says its
  // reader will get the roster wrong.
  problems.push("archive claims to be format 1 but carries claimed empires");
}
```

`readArchive` stamps `format: 1` *and* discards the claims, so `claims.length`
is 0 and the check passes. The file then proceeds to have its roster rebuilt
without the claimed seat, and every move that seat ever made fails
`verifyMove`. The reported problem is `bad signature at step 412 from 2:1`
followed by a hash mismatch — which reads as a tampered archive rather than a
reader that threw away a record.

`tessera-observe verify` and `tessera-observe rank` are wrong about these files
today. So is `tessera-host import`. The fix is four lines:

```ts
format: ARCHIVE_FORMAT,
...
else if (record.k === "claim") (game.claims ??= []).push(record.claim);
```

and the test is a round trip: seat a vacancy by claim, write through
`FileArchive`, read back with `readArchive`, `verifyArchive` clean. It fails on
today's tree, which is the only reason to trust it.

`ArchiveHead.format` is hard-coded to `1` at `store.ts:184` as well, and moves
with it.

**Nothing on disk is migrated.** An archive already written is missing nothing
— the claim lines are in `log.jsonl`, they were only being skipped on the way
out — so fixing the reader fixes the existing files. This is unlike
`archives-on-disk-have-wrong-from`, where the data itself was wrong.

## The ingest path

```
POST /archives
  body: an ArchivedGame, as JSON
  →  202 { gameId, status: "checking" }        queued
  →  200 { gameId, status: "held" }            already have it
  →  413                                        over the cap
  →  422 { gameId, problems: [ ... ] }          verifyArchive refused it
```

Open to anyone. The uploader is not identified, not signed, and not recorded,
because nothing about who they are changes what the file proves.

Four gates, cheapest first:

1. **Size.** A cap on the body, streamed and cut off rather than buffered — the
   discipline `Directory.readJson` already uses against a hostile board, from
   the other side. `ARCHIVE_CAP = 64_000_000` is what the web client will
   accept on the way out, so it is the natural ceiling here too.
2. **Shape.** `isArchive`-style: an object with a `genesis` and an array
   `moveLog`. Deliberately not verification — the web client keeps these
   separate for the same reason, so that "this is not a saved game" and "this
   saved game does not check out" are different sentences.
3. **Do we have it?** `gameIdOf(genesis)` recomputed — never the `gameId` field
   as posted — and looked up. A hit returns 200 and stops. This is the cheap
   path and it is the common one, because two observers on one game is the
   normal way to keep an archive safe rather than a corner case.
4. **`verifyArchive`**, on a queue.

### Why verification is queued

`verifyArchive` replays the game. `Sim.fastForward(game.steps, moves)` advances
once per step over the whole map, and `STEPS_PER_SECOND` is 12, so a ten-day
game is on the order of ten million steps — plus one ECDSA verify per move and
per message. The web client's worker comment says it plainly: *"five three-day
games is five full replays"*, and `main.ts` speaks of "a two-minute ranking".

That cannot run on a request thread. The upload is accepted to a staging blob,
a row is written `status = 'checking'`, and a worker picks it up. `202` with
the game id lets the caller poll `GET /archives/:gameId`.

A refusal keeps the `problems` and **deletes the blob**. The store holds
verified games; a file that failed is a row saying so, which is what makes the
refusal auditable without making the store a dump.

### The verdict cache

`rankArchives` verifies *before* it dedupes (`rankings.ts:129`, then the `seen`
check at 130), so N copies of one game cost N full replays. There is no caching
hook anywhere in the repo and no incremental mode.

0017 cannot afford to re-derive a table from scratch across a growing corpus,
so the cache is built here, at the moment the verdict is already in hand:

```sql
create table archives (
  game_id      text        primary key,   -- the content address
  content_hash text        not null,      -- sha-256 of the stored bytes
  format       integer     not null,
  steps        bigint      not null,
  state_hash   text        not null,      -- the archive's own claimed hash
  winner       integer,                   -- null when unfinished
  verdict      jsonb       not null,      -- the full Verdict, summary included
  bytes        bigint      not null,
  status       text        not null,      -- checking | held | refused
  problems     jsonb       not null default '[]',
  checked_at   timestamptz
);
```

`verdict` holds the `summary` that `rankArchives` joins to seats, so 0017 can
build a table from this one table without touching a blob. That is the whole
point of doing it here.

## The read path

### `GET /archives/:gameId`

Must satisfy `fetchArchive` in `apps/web/src/net/archives.ts`, which is the
client's own function and the one the tests will use:

```ts
http(url, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(timeoutMs),   // 30 s
})
```

So: `Content-Type: application/json`, `Access-Control-Allow-Origin: *`, a body
under `ARCHIVE_CAP`, and an answer inside thirty seconds. No conditional
request arrives — the client sends no `If-None-Match` — but an `ETag` is worth
serving anyway for anything else that fetches this.

**The ETag is the archive's own hash, not a live step.** `apps/host` tags on
`room.status().step`:

```ts
const tag = `"${status.step}"`;
```

which is the *driver's* current step, moving twelve times a second. For a
running game that tag never repeats, so the cache in front of it never hits and
every request re-reads the directory and re-stringifies megabytes. Here the
stored archive is immutable once verified, so `content_hash` is a tag that is
correct forever. Worth a note in `docs/clients/host-peer.md` as a defect in the
host peer rather than a difference in design.

### `GET /archives` — the corpus

```
GET /archives?limit=&cursor=&status=
  → { archives: [ { gameId, steps, winner, bytes, checkedAt, status } ], next? }
```

This is what makes 0017's table recomputable by a stranger: the list of what
the service holds, so anyone can fetch the same files and derive the same
numbers. It is a plain index and it makes no claim about completeness — there
is no index of finished games anywhere, and this one is over what was uploaded
to it.

Refused games are listed too, with their `problems`, under
`?status=refused`. A store that hid what it could not check would be making the
same mistake a leaderboard makes when it drops a row silently, and
`rankings.ts` has already argued that one.

## What the store does not do

- **It does not rewrite an archive.** Bytes in, bytes out. Not re-serialised,
  not key-sorted, not stripped of fields this build does not recognise. The
  `hash` in the file is over the replay, not over the JSON, so re-serialising
  would not break verification — which is exactly why the discipline has to be
  stated rather than left to the implementation.
- **It does not merge two archives of one game.** They are the same game and
  the first verified one is kept. A fragment (`from > 0`) is refused outright,
  because `verifyArchive` cannot replay it from the start and `rankArchives`
  will not count it.
- **It does not decide a winner.** `verdict.winner` comes out of the replay.
- **It does not accept an amendment, a correction or a takedown.** The store is
  append-only from the outside. An operator can delete; nobody else can, and
  there is no endpoint for it.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `readArchive`: the `claim` branch, `ARCHIVE_FORMAT`, and the failing round-trip test | yes — a fix, and the first test `packages/headless` has for it |
| 2 | `store.ts`: put, get, delete against an S3-compatible endpoint; MinIO in `compose.yaml` | yes |
| 3 | the `archives` table | yes |
| 4 | `POST /archives`: the cap, the shape check, the dedupe, the staging blob | yes |
| 5 | `ingest.ts`: the queue and `verifyArchive` | yes |
| 6 | `GET /archives/:gameId`, with the content ETag | yes |
| 7 | `GET /archives` — the corpus, and refusals | yes |
| 8 | `test/archives.test.ts` | yes |
| 9 | docs | yes |

Step 1 lands on its own and should be committed on its own: it fixes
`tessera-observe` for a class of game that exists today, and it is not
contingent on anything else in this plan.

## Docs

| File | Change |
|---|---|
| `docs/trust-and-verification/archive-format.md` | the store: the content address, what is refused, and that a refusal is published |
| `docs/trust-and-verification/verifying-an-archive.md` | a hosted store runs the same check a reader does — it is not an alternative to checking |
| `docs/trust-and-verification/trust-model.md` | a row: what an archive store can do. Withhold a file, serve an old one, learn who asks. It cannot alter one |
| `docs/clients/api-service.md` | 0015's page gains the archive routes |
| `docs/clients/host-peer.md` | the ETag note: tagging on a live step defeats the cache it is for |

The trust-model row is the one that needs care, and the honest answer is
narrow: an archive store can refuse to give you a file, and can give you
nothing at all. It cannot give you a *different* game, because the id is the
hash and you recompute it; and it cannot give you an altered one, because you
replay it. Its worst honest power, as with the board, is to waste your time.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| **a claimed-vacancy game round-trips through disk and verifies** | `packages/headless/src/test/store.test.ts` — fails on today's tree |
| `readArchive` reports the format it actually wrote | the same file |
| an upload is stored under the recomputed id, not the claimed one | `apps/api/src/test/archives.test.ts` |
| a second upload of a held game is a no-op | the same file |
| a tampered move is refused, and the `problems` come back verbatim | the same file |
| a fragment (`from > 0`) is refused | the same file |
| an archive too large is cut off rather than buffered | the same file |
| **`fetchArchive()` can read what the store serves** | the same file — the web client's own function, not a hand-written fetch |
| bytes out are bytes in | the same file, comparing the stored body to the posted one |
| a refused game appears in the corpus with its problems | the same file |
| the ETag is stable across requests for one game | the same file |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The first row is the one that justifies the plan's order. Everything else here
is new code failing in new ways; that one is existing code failing in a way
nobody has seen, and it will be the oldest bug this service inherits if it is
not fixed first.

## What this plan does not settle

**Retention.** Nothing here expires an archive, and a public store will
eventually need a policy. It is an operator's decision — the same category as
0007's rate limiter — and the honest version of it is a sentence in the corpus
response rather than a silent sweep.

**Snapshots and resume points.** `FileArchive` writes `snapshots/` and
`resume.json` beside the log, and this store takes neither. A resume point is
served by a host peer for a *live* game and belongs with the board row that
points at it; snapshots are a replay accelerator and their absence costs only
time. Worth revisiting if the hosted replay scrubber is ever wanted.

**Compression.** Archives are JSON and they are megabytes. `Content-Encoding`
is a transport concern and this plan does not specify one, which means the
default is none and a multi-day game is a multi-megabyte download.

**Names.** `ArchivedGame` holds no names — 0012 says adding them is an
`ARCHIVE_FORMAT` move and deliberately left it out — so a stored archive
identifies its players by key and nothing here changes that. 0017 inherits it.

**Who may delete.** An operator, by hand, with no endpoint. Fine for one
service and not a model for anything.
