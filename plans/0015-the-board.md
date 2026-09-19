# 0015 — The board: a service for rows nobody has to believe

Status: built
Depends on: 0007 (the client, and the row it reads)
Branch: `hosted-board`

## The problem

`packages/net/src/directory.ts` has spoken to a board since 0007. Nothing
answers it.

There is a client that lists games, fetches one by id, announces a door and
withdraws it. There is a host peer with `--announce <url>` that posts a row
every ninety seconds and takes it down on `SIGTERM`. There is a browser tab
that does the same for a WebRTC room it is hosting. There is a settings field
that validates the URL you type into it. What there is not, anywhere in this
repository or outside it, is a URL that any of them can be pointed at.

The `GAMES` card in the web client says so, in the one sentence it can:

> Games other people are running show up here. Put an address book in
> **Settings** below to see them — there is no default one, because a board is
> a URL somebody sends you the way a room code used to be.

That sentence is 0007's decision and it is the right one: a default board
shipped in the client would be the single piece of centralisation this design
has avoided. But "there is no default one" is a different statement from "there
is no such thing", and today both are true.

This plan builds one. It is deliberately the smallest of the three, because a
board is the smallest thing in this system that has a URL: it stores what it is
given, expires what is not refreshed, and checks exactly one signature — not to
decide whether a game is real, but to stop anyone clearing somebody else's row.

## What a board is not

Worth saying first, because every instinct a person has about writing a
directory service is wrong here.

A board does not verify a game. It does not recompute a game id. It does not
decide which games are joinable. It does not merge two announcers' rows into
one. It does not reorder refs, drop witnesses it cannot check, or normalise a
genesis it does not understand. Every one of those is a helpful thing to do and
every one of them breaks a client that is already written to do it itself.

`docs/trust-and-verification/trust-model.md` puts the board's powers in a
paragraph, and it is a short one:

> It can flicker rows (bounded by the TTL — the next heartbeat restores them),
> show fiction (returned, and marked as carrying no proof), refuse to answer,
> and learn which games a reader asks about. What it cannot do is forge a game
> […] Its worst honest power is to waste your time.

The service in this plan is built to have exactly those powers and no others.
Not because a hostile operator is expected, but because a board that *could*
decide something would become a board that *does*, and the client would
eventually be simplified to trust it.

## The one rule

From the same page:

> The write rule is access control and not adjudication: a row is owned by the
> key that announced it, so `present` and `withdraw` need that key's signature.
> The signature says who posted a row, never that the row is true.

And `directory.ts:169` has already written the check, with an instruction
attached:

```ts
/** Whether a write was signed by the key it claims. Exported for whoever
 *  implements a board: the rule is one `verify` call and it should not be
 *  reimplemented from the paragraph above. */
export async function verifyWrite(
  write: SignedListing | SignedWithdrawal,
): Promise<boolean>
```

This plan is that whoever. `verifyWrite` is imported and called; the signing
bytes are not re-derived, the canonical JSON is not re-implemented, and the
`v: 1` in `writeBytes` is not hard-coded into a second place that can drift
from the first.

# Implementing it

## What ships

| File | What it is |
|---|---|
| `apps/api/package.json`, `tsconfig.json` | the new app, in `apps/host`'s shape |
| `apps/api/src/main.ts` | CLI, wiring, shutdown |
| `apps/api/src/serve.ts` | the `node:http` router, CORS, the preflight |
| `apps/api/src/board.ts` | rows: upsert, withdraw, list, get, sweep |
| `apps/api/src/db.ts` | Postgres, and the one table this plan needs |
| `apps/api/src/test/board.test.ts` | the real `Directory`, against the real server |
| `apps/api/Dockerfile`, `compose.yaml` | the first deployment config in this repo |
| `docs/clients/api-service.md` | new |

## The four endpoints, and nothing else

`Directory`'s constructor takes one URL and strips trailing slashes. That base
*is* the games collection — the settings placeholder is
`https://board.example/games`, with a path — and every other path is derived
from it:

| # | Method | Path | Body | The client's cap |
|---|---|---|---|---|
| 1 | GET | `{base}?limit={n}` | — | `CAPS.list` = 1,000,000 B |
| 2 | GET | `{base}/{gameId}` | — | `CAPS.get` = 64,000 B |
| 3 | POST | `{base}` | `SignedListing` | — |
| 4 | POST | `{base}/withdraw` | `SignedWithdrawal` | — |

There is no fifth. `present` is not an endpoint — `directory.ts:245` is
`async present(...) { await this.announce(identity, listing); }`, and the
service cannot tell a first announcement from a heartbeat, which is the point:
both are an upsert.

`limit` defaults to 100 (`DEFAULT_LIMIT`). The client truncates locally as well
(`rows.slice(0, limit)`), so a board that ignores the parameter is merely
wasteful rather than broken — but it will exceed the 1 MB cap somewhere around
three hundred rows and the client will cut it off mid-stream, so honouring it
is not optional in practice.

### The answer envelope

`asRows` is generous on purpose:

```ts
function asRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["games", "listings", "rows"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return record.gameId !== undefined ? [body] : [];
}
```

Four shapes are legal. This service answers `{"games": [...]}` for both GETs —
an object rather than a bare array, so a field can be added later without
changing the type of the response, and `games` because it is the word the
client tries first.

A body that is not one of the four yields **zero rows and no error**. That is a
client decision and this plan does not get to change it, but it does mean a
service bug that returns `{"data": [...]}` looks exactly like an empty board.
The tests below therefore assert on rows read back through `Directory`, never
on the JSON this service emits.

## Rows are keyed `(gameId, ref)`

0007 §"The row, corrected" settles this and it is the most consequential line
in the plan:

> Rows are keyed by **(gameId, ref)**: one row per door, one TTL per door, so a
> host dying removes its own door and not the game.

A `Listing` carries `refs: string[]`, so one POST may create several rows. Both
shipped announcers post exactly one ref — the web tab a single `rtc` room, the
host peer a single `door` — but the type permits more and the service must
handle it rather than assume.

```sql
create table rows (
  game_id     text        not null,
  ref         text        not null,
  owner       text        not null,   -- MemberKey, base64url of the P-256 point
  listing     jsonb       not null,   -- the Listing verbatim, as posted
  expires_at  timestamptz not null,
  updated_at  timestamptz not null,
  primary key (game_id, ref)
);
create index rows_expiry on rows (expires_at);
```

`listing` is stored **whole and unaltered**. Not normalised into columns, not
re-serialised through a schema, not stripped of fields this build does not
recognise. A row posted by a newer client carrying a field 0015 never heard of
is a row that must survive to reach a reader who has. Storing the document and
indexing beside it is the only shape that has that property.

Three columns are lifted out because the service genuinely needs them: the
primary key to upsert on, the owner to check a write against, and the expiry to
sweep on.

### Fanning out a multi-ref post

One POST, N refs, N rows — all sharing that post's `expiresAt` and `owner`, and
each holding the same `listing` document. A reader gets N rows for one game and
merges them back into one `GameListing`; `merge()` unions the refs, so the
round trip is lossless.

The alternative — one row holding the whole `refs` array — breaks the property
the keying exists for. Two hosts announcing two doors into one game would
overwrite each other, and 0006 §"Two hosts, one door" is explicit that
redundancy for the door is the address book's job.

## The write path

```ts
// POST {base}
async function announce(write: unknown): Promise<Answer> {
  if (!plausible(write)) return { status: 400, body: { error: "not a listing" } };
  if (!(await verifyWrite(write as SignedListing))) {
    return { status: 403, body: { error: "that was not signed by the key it claims" } };
  }
  ...
}
```

Three checks, in this order, and the plan should resist every temptation to add
a fourth:

1. **Shape.** `listing` is an object, `listing.gameId` a non-empty string,
   `listing.refs` an array of strings, `by` and `sig` strings. Nothing about
   the genesis: a row whose genesis is nonsense is a row the *reader* drops,
   and a board that pre-filtered them would be adjudicating.
2. **Signature**, via `verifyWrite`. The bytes are
   `canonicalJson({ v: 1, kind, gameId, refs: [...refs].sort(), expiresAt })`,
   and note that refs are **sorted before signing** — so ref *membership* is
   covered and ref *order* is not. The service must not reorder refs on the way
   out anyway, because the client dials them in announced order.
3. **Ownership.** For each `(gameId, ref)` that already exists, the stored
   `owner` must equal `write.by`. Otherwise `403`. A key may take over a row
   only after it has expired and been swept.

`expiresAt` is the client's, not the service's. The web announcer sets
`now + TTL_MS` with `TTL_MS = 180_000`; the host sets `Date.now() + ttl * 1000`
with `--ttl` defaulting to 180. Both heartbeat at half that — the host at
`max(ttl / 2, 15)` seconds. The service stores what it is given, clamped to a
ceiling (below), and never issues a lease of its own: a client that had to ask
for one would need a round trip before it could hold a game open.

### Withdrawal

`POST {base}/withdraw` with a `SignedWithdrawal` — `{ gameId, refs, expiresAt: 0, by, sig }`.
Delete the `(gameId, ref)` rows named, **where `owner = by`**. Rows the caller
does not own are left standing and the response is still `200`: a withdrawal is
not a query, and telling a stranger which of the refs they named exist is
information the board has no reason to hand out.

A crash withdraws nothing. That is what the TTL is, and 0007 says so:

> A host peer that dies withdraws nothing; the row stands until its TTL. This
> is what the TTL is, and it means a board's freshest possible answer is still
> "as of one heartbeat ago" — which is why `resolve` dials rather than
> believing.

## The read path

Two queries, and neither of them filters on anything a row *claims*.

```ts
// GET {base}?limit=n
select listing from rows
where expires_at > now()
order by updated_at desc
limit $1;
```

Expired rows are excluded from reads as well as swept on a timer, because a
sweeper that runs every thirty seconds is a sweeper that serves a dead door for
up to thirty seconds. The client checks `expiresAt` against its own clock too
(`read()` step 2) — belt and braces, deliberately, because the two clocks are
not the same clock.

`GET {base}/{gameId}` is the same query narrowed to one id. The client then
does `merged.find((one) => one.gameId === gameId)` — it refuses a board that
answers the wrong game — so there is no point in being clever here.

**There is no `joinable` filter, no `open` filter and no ordering the client
can request.** `Directory.list` derives joinability from the record's join
window against the reader's own clock, and 0007 gives the reason:

> whether anybody is still in a room is not something a board can know, and
> `resolve` answers it by dialling.

`seatsUsed` is forwarded verbatim if a row carries it and is never read by this
service. It is a claim, permanently — it moves by amendment and by drop and the
board sees neither — and a `joinable` filter that trusted it would be a hostile
board deciding which games a player sees.

## What the client makes impossible

This deserves its own section, because it forecloses things a reasonable person
will propose later.

`readJson` sends:

```ts
const response = await this.send(url, {
  method: "GET",
  // There is nothing to authenticate with and nothing to send. Reading a
  // board should say what you want, not who you are — no identity, no key,
  // no fingerprint, and no custom header to fingerprint the client by.
  credentials: "omit",
  ...extra,
});
```

and `directory.test.ts` pins it: `expect(seen[0]!.headers).toBeUndefined()`.

So on the read path there is **no header at all** — not an API key, not a
bearer token, not even `Accept` — and no cookie, because `credentials: "omit"`.
Any authentication scheme for reads would require a client change and an
argument about why a board should know who is asking. This service must be
usable, fully, by a client that sends a bare `GET` and nothing else.

The write path does carry `Content-Type: application/json`, which is the only
header the client ever sends, and which is *not* a CORS-simple type. That has a
consequence.

## CORS, which is not optional

The web client is served from GitHub Pages and the board is somewhere else, so
every request is cross-origin. Without the headers the browser fails opaquely —
and `fetchArchive`'s error sentence exists precisely because a CORS failure and
a dead host are indistinguishable from inside a page.

`apps/host/src/serve.ts:89` is the precedent:

```ts
response.setHeader("Access-Control-Allow-Origin", "*");
```

set on every response before routing. This service does the same, and adds what
the host peer never needed because it accepts no writes:

```ts
if (request.method === "OPTIONS") {
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Max-Age", "86400");
  response.writeHead(204).end();
  return;
}
```

A missing `Access-Control-Allow-Headers: Content-Type` is the failure mode to
test for specifically: reads work, writes fail, and the browser console is the
only place that says why. The host peer's `OPTIONS` branch answers
`GET, OPTIONS` and would be wrong here if copied verbatim.

## The rate limiter 0007 deferred

0007 §"What this plan does not settle":

> **Spam, past the proof.** Witnesses make a *played* game distinguishable from
> a fabricated one. They do nothing about a thousand rows for real games nobody
> is in, and a public board will need a rate limiter and probably a cost. That
> is an operator's problem and the client is deliberately built to be useful
> against a board that has not solved it.

This plan is that operator. Four limits, all invisible to the client except as
a shorter list or a status code it reports verbatim:

| Limit | Value | Why |
|---|---|---|
| rows per owner key | 32 | a host runs one game per process; 32 is generous and finite |
| rows per `gameId` | 8 | 0006's redundancy is a handful of doors, not a thousand |
| writes per key per minute | 20 | heartbeats are every 90 s; 20 is two orders of headroom |
| `expiresAt` ceiling | 15 minutes | a row nobody refreshes should not outlive the process that posted it by much |

Over a limit, `429` with a prose body. `Directory.post` turns any non-2xx into
`that board answered ${status} — it may be read-only`, which is not the ideal
sentence for a rate limit but is honest, and changing it is a client change
this plan does not need.

The per-IP dimension is left to whatever sits in front of the process. A key is
free to mint, so a per-key limit alone bounds nothing; the plan should say that
plainly rather than imply the table above is a defence.

## The shape of the app

`apps/host` is the template, and the conventions are not negotiable because
nothing in this repo enforces them automatically — there is no linter, no
formatter config and no `CONTRIBUTING.md`. Node 22, ESM, `tsc` to `dist`,
relative imports with a `.js` extension, exact pinned dependency versions,
`node:util`'s `parseArgs` at module top level under a `const USAGE`, a `say`
that respects `--quiet`, and `SIGINT`/`SIGTERM` handlers that close cleanly.

```
tessera-api — the board, the archive store and the table derived from them

  --bind <addr>        default 127.0.0.1
  --port <n>           default 8081
  --database <url>     postgres://…
  --quiet
  --help
```

`serve(options): Server` takes its I/O injected, exactly as the host peer's
does — *"Injected so the HTTP layer has no opinion about the file format"* —
which is what lets the tests below run the router against an in-memory store
when they want to and against Postgres when they mean it.

Routing is hand-rolled string splitting, like `serve.ts`, because adding the
first framework to this tree for four endpoints would be a larger change than
the feature. `end(response, status, body)` and the lowercase-prose error bodies
(`{ error: "not a room" }`) are the existing house style and are kept.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `apps/api` skeleton: manifest, tsconfig, `main.ts`, `serve.ts` with a health route | yes |
| 2 | `db.ts` and the `rows` table; `compose.yaml` with Postgres | yes |
| 3 | `board.ts`: upsert, ownership, withdraw, sweep | yes |
| 4 | the two GETs, the envelope, the `limit` | yes |
| 5 | CORS and the `OPTIONS` preflight | yes |
| 6 | `test/board.test.ts` — the real `Directory` against the real server | yes |
| 7 | the rate limits | yes |
| 8 | `Dockerfile`, CI service containers | yes |
| 9 | docs, and the four registration chores | yes |

Step 6 is the one to write before step 7, not after: the limits are easy to get
subtly wrong in a way that only shows up as a client seeing fewer games than
exist, and the test that proves the happy path is the thing that catches it.

## Docs

| File | Change |
|---|---|
| `docs/clients/api-service.md` | new: what the service is, the four endpoints, and the list of what it refuses to decide |
| `docs/clients/README.md` | a row |
| `docs/mesh/address-book.md` | the board section gains a real implementation, and a link |
| `docs/trust-and-verification/trust-model.md` | §"The board" gains a sentence: a hosted board is still a board, and the row above still bounds it |
| `README.md` | the Layout table — and `apps/host`, which is missing from it |
| `ARCHITECTURE.md` | the `## Layers` table — same, and `apps/host` is missing there too |
| `dispat.yaml` | `dependencies:` and `initials:` — `apps/host` is missing from both |

The trust-model change is the one to write carefully. It must not read as "the
board is now trustworthy because we run it". Nothing about operating a board
changes what a board can do, and the value of the page is that it is true for a
board run by a stranger.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| `Directory.list` reads rows this service wrote | `test/board.test.ts`, the real client against `serve()` on port 0 |
| `Directory.get` finds one game, and refuses a substituted one | the same file |
| `announce` then `present` is one row, not two | the same file |
| a second key cannot `present` or `withdraw` another's row | the same file |
| a row with a past `expiresAt` never appears in `list()` | the same file, posting one |
| a multi-ref post fans out, and `merge()` puts it back together | the same file |
| **a row carrying a field this build does not know survives the round trip** | the same file — the argument for storing the document whole |
| witnesses, amendments and drops come back verifiable | the same file, with `directory.test.ts`'s real-signature fixtures |
| `seatsUsed: 99` on a four-seat game is still 99 on the way out | the same file |
| an unsigned or tampered write is refused | the same file, mutating `listing.refs` after signing |
| the `OPTIONS` preflight allows `Content-Type` | the same file, as a raw request |
| a 100-row answer stays under `CAPS.list` | the same file, with generated rows |
| `limit` is honoured | the same file |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The fixtures are lifted from `packages/net/src/test/directory.test.ts` rather
than rewritten. That suite already builds a genuine genesis, a fabricated one,
rows with three-of-four witnesses and rows with two, and a row whose witnesses
are for another game. Posting those through this service and reading them back
through `Directory` proves the thing that actually matters — that the board is
transparent — in a way that asserting on the service's own JSON cannot.

This is also the first HTTP-level test in the repository. `apps/host`,
`apps/bot` and `apps/observer` all run `vitest run --passWithNoTests` and have
no `src/test` directory at all; `apps/host/src/serve.ts` has never been
executed by a test. A service whose entire contract is HTTP should not inherit
that, and the harness written here — `listen(0)`, fetch it, close it — is what
would let the host peer's server be tested later.

## What this plan does not settle

**Discovery of boards.** Still nothing bootstraps one, and this service does
not become a default. `settings().board` stays empty until somebody types a
URL, for the reason 0007 gave. Running a board and shipping its address in the
client are two decisions, and only the first is made here.

**Authentication.** There is none and there cannot be one on the read path
without a client change (§"What the client makes impossible"). If a private
board is ever wanted, the shape is a separate deployment behind whatever
already guards the network it is on — not a header this client cannot send.

**Per-IP limiting, and cost.** The table above bounds a key, and keys are free.
What actually bounds a public board is something in front of the process or a
price on a row, and 0007 said so first. Neither is built here.

**`Directory.list` and query strings.** The client builds
`` `${this.base}?limit=${limit}` `` with no regard for an existing query string,
so a board URL that already carries one produces a malformed second `?`. It
does not affect this service, which needs no query parameters of its own, and
it is a client fix that belongs wherever somebody first wants such a URL.

**One game per process.** `RoomBus` and `apps/host`'s `serve()` are both
multi-room — `byRoom: Map<string, Set<BusSocket>>`, `rooms: Map<string, Room>` —
but `apps/host/src/main.ts` calls `rooms.set` and `hostGame` exactly once, so N
games means N processes on N ports. The board is what makes that invisible to a
player, which is worth knowing here and is not a reason to change it.
