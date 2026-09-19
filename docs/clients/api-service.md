# The API service

`apps/api` — `tessera-api`. A board of rows nobody has to believe, and a store
of files nobody is trusted to have written.

Two of the three URLs the web client asks for pointed at software that did not
exist. This process answers both, and they are separate features of one
deployment: `--archives` turns the store on, and without it only the board runs.

Neither is a default. `settings().board` stays empty until somebody types a URL,
because a board shipped in the client would be the single piece of
centralisation this design has avoided. Running a service and shipping its
address are two decisions, and only the first is made by standing this up.

The two halves share a discipline and it is the reason the pages below are mostly
lists of refusals. **Nothing here is an authority.** The board stores what it is
given and checks one signature — not to decide whether a game is real, but to
stop anyone clearing somebody else's row. The store replays what it is sent and
keeps what passes — the same check a stranger would run, which is why it needs to
know nothing about who sent it.

# The board

## Running one

```
docker compose -f apps/api/compose.yaml up --build
```

which answers at `http://127.0.0.1:8081/games` — the string to paste into the
web client's **Settings**, with the path, because `Directory`'s base *is* the
games collection.

Or directly:

```
tessera-api --bind 127.0.0.1 --port 8081 --database postgres://…
```

`--database` is optional and rows live in memory without it, which is useful for
a development board and useless for anything else; the process says so on
startup rather than letting an operator find out at the first restart.

`--archives <dir>` turns the store on and the archive routes 404 without it. A
board on its own is a whole deployment, and an operator who wants one should not
be made to find a disk for archives.

A browser fetching this from a page served elsewhere needs `https://`, so a
public board wants a certificate and a reverse proxy in front of the process.
That proxy is also where per-IP limiting belongs — see [the
limits](#the-limits-and-what-they-do-not-bound).

## The four endpoints, and there is no fifth

| Method | Path | Body | Answers |
|---|---|---|---|
| GET | `{base}?limit={n}` | — | `{ "games": [ Listing, … ] }` |
| GET | `{base}/{gameId}` | — | `{ "games": [ Listing, … ] }` |
| POST | `{base}` | `SignedListing` | `200`, `400`, `403`, `413`, `429` |
| POST | `{base}/withdraw` | `SignedWithdrawal` | `200`, `400`, `403`, `429` |

`present` is not an endpoint. `Directory.present` is
`async present(...) { await this.announce(identity, listing); }`, and the service
cannot tell a first announcement from a heartbeat — which is the point. Both are
an upsert.

`limit` defaults to 100, matching `DEFAULT_LIMIT`. The client truncates locally
as well, so a board that ignored the parameter would merely be wasteful — until
it crossed `CAPS.list` (1 MB, around three hundred rows) and the client cut the
answer off mid-stream. Honouring it is not optional in practice.

Both GETs answer `{"games": […]}`: an object rather than a bare array, so a field
can be added later without changing the type of the response, and `games` because
it is the key `asRows` tries first. `asRows` accepts four shapes and answers
**zero rows and no error** for anything else, which means a service bug returning
`{"data": […]}` would look exactly like an empty board. That is why this app's
tests read rows back through `Directory` and never assert on the JSON emitted
here.

## A row is a door

Rows are keyed **`(gameId, ref)`** — one row per door, one TTL per door — so a
host dying removes its own door and not the game. A `Listing` carries
`refs: string[]`, so one POST may create several rows, all sharing that post's
`expiresAt` and owner and each holding the same document. A reader gets N rows
for one game and `merge()` unions them back into one `GameListing`, so the round
trip is lossless.

The alternative — one row holding the whole `refs` array — breaks the property
the keying exists for: two hosts announcing two doors into one game would
overwrite each other, and redundancy for the door is the address book's job.

The posted `listing` is stored **whole and unaltered**: not normalised into
columns, not re-serialised through a schema, not stripped of fields this build
does not recognise. A row posted by a newer client carrying a field this one
never heard of has to survive to reach a reader who understands it. Three columns
are lifted out beside the document because the service genuinely needs them — the
key to upsert on, the owner to check a write against, and the expiry to sweep on.

## The one rule

A row is owned by the key that announced it, so a refresh or a withdrawal needs
that key's signature. [`verifyWrite`](../../packages/net/src/directory.ts) is
that check and this service calls it rather than reimplementing it: the signing
bytes are not re-derived and the write version is not hard-coded into a second
place that can drift from the first.

Three checks on a write, in order, and there is deliberately no fourth:

1. **Shape** — an object with a `gameId`, string `refs`, a `by` and a `sig`.
   Nothing about the genesis: a row whose genesis is nonsense is a row the
   *reader* drops, and a board that pre-filtered them would be adjudicating.
2. **Signature**, via `verifyWrite`. Refs are sorted before signing, so ref
   *membership* is covered and ref *order* is not — and refs are not reordered on
   the way out either, because the client dials them in announced order.
3. **Ownership** — for each `(gameId, ref)` that already exists, the stored owner
   must equal `by`, or `403`. A key may take a row over only after it has
   expired.

A withdrawal deletes only the rows the caller owns and answers `200` either way.
A withdrawal is not a query, and telling a stranger which of the refs they named
exist is information the board has no reason to hand out.

`expiresAt` is the announcer's, never issued here: a client that had to ask for a
lease would need a round trip before it could hold a game open. It is clamped to
a ceiling, and the clamp is the service's own lease column — the stored document
still says what its announcer said.

A crash withdraws nothing. That is what the TTL is, and it means a board's
freshest possible answer is still "as of one heartbeat ago" — which is why
`resolve` dials rather than believing.

## What this service refuses to decide

Every instinct a person has about writing a directory service is wrong here, so
the list is worth enumerating rather than implying.

It does not verify a game. It does not recompute a game id. It does not decide
which games are joinable. It does not merge two announcers' rows into one. It
does not reorder refs, drop witnesses it cannot check, or normalise a genesis it
does not understand. Every one of those is a helpful thing to do and every one of
them breaks a client already written to do it itself.

In particular there is **no `joinable` filter, no `open` filter and no ordering a
caller can request**. `Directory.list` derives joinability from the record's join
window against the reader's own clock, and whether anybody is still in a room is
not something a board can know — `resolve` answers that by dialling. `seatsUsed`
is forwarded verbatim and never read here: it is a claim permanently, and a
filter that trusted it would be a hostile board deciding which games a player
sees.

This is a discipline rather than a property. A board that *could* decide
something would become a board that *does*, and the client would eventually be
simplified to trust it. See [the trust
model](../trust-and-verification/trust-model.md#the-board) for what that leaves a
board able to do, which is a short list ending in "waste your time".

## CORS, which is not optional

The web client is served from GitHub Pages and a board is somewhere else, so
every request is cross-origin. `Access-Control-Allow-Origin: *` is set on every
response before routing, as the host peer does it — and unlike the host peer,
which accepts no writes, the preflight has to name a header:

```
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

`Content-Type: application/json` is the only header the client ever sends and it
is not a CORS-simple type. A missing `Access-Control-Allow-Headers` is the
failure mode to watch for specifically: reads work, writes fail, and the browser
console is the only place that says why. The host peer's `OPTIONS` branch answers
`GET, OPTIONS` and would be wrong here if copied verbatim.

On the read path the client sends **no header at all** — not an API key, not a
bearer token, not even `Accept` — and `credentials: "omit"`, and
`directory.test.ts` pins it. So this service must be usable, fully, by a client
that sends a bare `GET` and nothing else, and any authentication scheme for reads
would need a client change first.

## The limits, and what they do not bound

| Limit | Value |
|---|---|
| rows per owner key | 32 |
| rows per `gameId` | 8 |
| writes per key per minute | 20 |
| longest lease | 15 minutes |

Over a limit, `429` with a prose body. `Directory.post` turns any non-2xx into
`that board answered ${status} — it may be read-only`, which is not the ideal
sentence for a rate limit but is honest.

The limit is on rows *held*, not on writes that mention them, so a heartbeat from
a key sitting at the ceiling is accepted — a host that could not refresh would
watch its own game fall off the board.

**A key is free to mint, so a per-key limit alone bounds nothing.** The table
above is not a defence and should not be read as one. What actually bounds a
public board is something in front of the process — a per-IP limiter, or a price
on a row — and neither is built here.

## What it does not settle

**Discovery.** Nothing bootstraps a board, and this service does not become a
default.

**Authentication.** There is none on the read path and there cannot be one
without a client change. A private board is a separate deployment behind whatever
already guards the network it is on, not a header this client cannot send.

**Per-IP limiting, and cost.** Above.

**One game per process.** `RoomBus` and the host peer's `serve()` are both
multi-room, but `apps/host/src/main.ts` hosts exactly one game, so N games means
N processes on N ports. The board is what makes that invisible to a player.

# The leaderboard

```
GET /rankings?window=held        the recomputable table (default)
GET /rankings?window=all         everything ever applied
GET /rankings/applied?cursor=    the all-time corpus, paged
```

Both tables are `Leaderboard`'s shape plus three fields only a hosted table
needs: `games`, `derivedAt`, and `scope` — the sentence that bounds it. `counted`
is the list of ids for the window and `null` for all-time, because an all-time
corpus is unbounded and shipping it inline would eventually be the largest
response this service has.

The window table ships its corpus so a reader can falsify it: fetch the ids in
`counted` from `GET /archives/:gameId`, run `rankArchives` over them, and get the
same table or find out why not. Refusals are served rather than swallowed.

Everything else about the two tables — why an accumulated total is exact rather
than approximate, why the dedupe key is the game id and not the file's bytes,
what auditability costs once a file has been evicted, and why there are no
accounts — is on [the leaderboard
page](../trust-and-verification/leaderboard.md#hosted-two-tables-audited-differently),
because it is an argument about the table rather than about this service.

# The archive store

An archive today lives wherever the process that wrote it happens to be. A host
peer serves `GET /room/:code/archive` for the games *it is a peer in* and 404s
everything else; an observer writes directories on somebody's laptop; a browser
tab offers **Save log** and hands the player a file. All three produce the same
artifact and none is a place anyone else can fetch it from a week later.

The web client's `Archive URLs` setting says so in its own help text — *"There is
no index of finished games anywhere, so a table here is over what you have and
says so."* This is an index. It is not *the* index, and the difference is the
whole of the next section.

## Why this is safe to build

An archive is **self-proving**. `verifyArchive` re-hashes the genesis, rebuilds
the roster from it, walks every amendment and claim, checks every signature
against the roster as it stood, replays the whole log and compares the result to
the hash the file claims. A file that survives that was produced by the game it
says it was.

So the store does not need to know who uploaded anything. No accounts, no API
keys, no trusted set of host peers: it runs the same check a stranger would run
and stores only what passes. That is the only design here that does not quietly
introduce an authority, and it is available because 0005 and 0006 did the work of
making an archive checkable by somebody who was not there.

`genesis.gameId` is a SHA-256 over the canonical record, so **the content address
is the key**. A second upload of a game already held is a no-op rather than a
duplicate, and the store cannot hold two different files under one id without one
of them failing verification.

## The routes

```
POST /archives            an ArchivedGame, as JSON
  → 202 { gameId, status: "checking" }     queued for replay
  → 200 { gameId, status: "held" }         already have it
  → 400                                    not a saved game
  → 413                                    over the cap
  → 422 { gameId, problems: [ … ] }        verifyArchive refused it

GET  /archives/:gameId    the file, exactly as it was posted
  → 200  with an ETag that is the archive's own content hash
  → 202  still being replayed
  → 410  { error: "no longer held", checkedAt }
  → 422  { status: "refused", problems }
  → 404  never seen here

GET  /archives?limit=&cursor=&status=      the corpus
  → { archives: [ { gameId, steps, winner, bytes, checkedAt, status, held } ], next? }
```

Uploading is open to anyone. The uploader is not identified, not signed and not
recorded, because nothing about who they are changes what the file proves.

Four gates, cheapest first: the size cap (64 MB, the client's own `ARCHIVE_CAP`,
cut off while the body is arriving rather than after); the shape check, which is
deliberately not verification, so that "this is not a saved game" and "this saved
game does not check out" stay different sentences; the dedupe, on the
**recomputed** id and never the `gameId` field as posted; and then the replay.

### Why the replay is queued

`fastForward` advances once per step over the whole map and `STEPS_PER_SECOND` is
12, so a ten-day game is on the order of ten million steps, plus one ECDSA verify
per move and per message. That cannot run on a request thread. The upload is
accepted, a row is written `status = checking`, and a worker picks it up; `202`
with the game id lets the caller poll.

A refusal keeps the `problems` and **deletes the file**. The store holds verified
games; a file that failed is a row saying so, which is what makes the refusal
auditable without making the store a dump. Refusals are listed under
`?status=refused` with their reasons, for the same reason a leaderboard must not
silently drop what it could not check.

## Retention: the file goes, the row does not

| | kept | size |
|---|---|---|
| the archive itself | the most recent `--keep` games, by when they were checked | megabytes |
| its row and verdict | forever | a few hundred bytes |

Eviction is by `checkedAt` rather than by the game's own `startedAt`: a game
uploaded late is new to this service whatever its age, and the store has no
business deciding a game is uninteresting because it was played last year.

An evicted game keeps its row, so `GET /archives/:gameId` answers `410` rather
than `404` — a different thing from a game never seen, and the distinction
matters to a reader deciding whether to look elsewhere for a copy — and the
corpus still lists it, marked `held: false`.

**Re-uploading an evicted game is a no-op, not a resurrection.** Restoring the
file would let anybody pin a game in the store forever by re-posting it, and the
retention would stop meaning anything. The one exception is a copy with *more*
steps: two honest archives of one game can cover different amounts of it — an
observer that closed its laptop at step 40,000 and one that ran to 120,000 both
produce a verifiable archive of the same game — and the longer one supersedes.

## What the store does not do

- **It does not rewrite an archive.** Bytes in, bytes out: not re-serialised, not
  key-sorted, not stripped of fields this build does not recognise. The `hash` in
  the file is over the replay rather than over the JSON, so re-serialising would
  not break verification — which is exactly why the discipline has to be stated
  rather than left to the implementation.
- **It does not merge two archives of one game.** They are the same game.
- **It does not decide a winner.** `verdict.winner` comes out of the replay.
- **It does not accept an amendment, a correction or a takedown.** The store is
  append-only from the outside. An operator can delete; nobody else can, and
  there is no endpoint for it.
- **It refuses a fragment** (`from > 0`) outright, because `verifyArchive` cannot
  replay it from the start.

## The ETag is the archive's hash, not a step

A stored archive is immutable once verified, so `content_hash` is a tag that is
correct forever. Worth contrasting with `apps/host`, which tags
`GET /room/:code/archive` on `room.status().step` — the driver's current step,
moving twelve times a second. For a running game that tag never repeats, so the
cache in front of it never hits and every request re-reads the directory and
re-stringifies megabytes. That is a defect in the host peer rather than a
difference in design.

## Where the bytes live

`Blobs` is three methods — put, get, remove — and the routes have no opinion
about what is under them. The shipped implementation is a directory, which
`compose.yaml` mounts as a volume; an S3-compatible backend is a fourth
implementation of the same interface and nothing above it changes.

## What the store does not settle

**Snapshots and resume points.** `FileArchive` writes `snapshots/` and
`resume.json` beside the log and this store takes neither. A resume point is
served by a host peer for a *live* game and belongs with the board row that
points at it; snapshots are a replay accelerator and their absence costs only
time.

**Compression.** Archives are JSON and they are megabytes. `Content-Encoding` is
a transport concern and nothing here specifies one, so a multi-day game is a
multi-megabyte download.

**Names.** `ArchivedGame` holds no names — adding them is an `ARCHIVE_FORMAT`
move — so a stored archive identifies its players by key and nothing here changes
that.

**Who may delete.** An operator, by hand, with no endpoint. Retention sweeps
files on a rule; deleting a *row* is a thing only a person can do, deliberately,
and it is not reversible.

**Completeness.** Nothing makes a host peer upload and nothing notices a game
that ended and was never archived. The corpus is over what was sent here.
