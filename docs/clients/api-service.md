# The API service

`apps/api` — `tessera-api`. A board: rows nobody has to believe.

Two of the three URLs the web client asks for pointed at software that did not
exist. This is the first of them. It stores what it is given, expires what is not
refreshed, and checks exactly one signature — not to decide whether a game is
real, but to stop anyone clearing somebody else's row.

It is not a default. `settings().board` stays empty until somebody types a URL,
because a board shipped in the client would be the single piece of
centralisation this design has avoided. Running a board and shipping its address
are two decisions, and only the first is made by standing this up.

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
