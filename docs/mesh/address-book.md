# The address book

A room code is shared out of band and dies with its holder. The address book is
how a game becomes findable without anything in this system becoming a server:
**the board is dumb, the announcers are peers, and every reader verifies what it
reads.**

[`Directory`](../../packages/net/src/directory.ts) is the client and the only
shared artifact. It lives in `packages/net` so a browser and a
[headless peer](../clients/headless-peers.md) use one implementation.

This page is the mechanism. For the same thing from a player's side — what a row
says, which half of it you can believe, and what pressing Join actually does —
see [finding a game](../clients/finding-a-game.md).

## What a board is

A bulletin board of connection parameters. It stores what is posted, expires what
is not re-posted, and verifies nothing about games. Any implementation qualifies:

- a static JSON file behind any HTTP server, for a friends-only book;
- a small service with a rate limiter, for a public one;
- a [host peer](../clients/host-peer.md) serving its own row.

There is no board shipped with this client, and no default URL. A board is a URL
that arrives the way a room code used to.

## A row is a door

Rows are keyed by **(gameId, ref)** — one row per door, one TTL per door — so a
host dying removes its own door and not the game. `Directory.list()` groups them,
and a caller sees one `GameListing` per game with the doors merged.

| Field | Status |
|---|---|
| `gameId` | claimed — re-derived with `gameIdOf(genesis)`; a row that disagrees is dropped |
| `genesis` | the sealed record. Everything below is derived from it, or is a claim |
| `refs: string[]` | claimed. [Parsed per entry](connection-refs.md); an unparsable one is reported and the row survives |
| `resume` | claimed — where a [resume point](../continuity/resume-points.md) can be fetched |
| `witnesses`, `amendments`, `drops` | **checkable, and the only part a spammer cannot fake** |
| `step`, `hash` | what the witnesses are claimed to be about |
| `seatsUsed` | a claim, permanently — see below |
| `expiresAt` | the board's TTL, advisory, compared against the reader's own clock |

Refs are strings on the wire — what [`formatRef`](connection-refs.md) produces —
rather than parsed values, so a row carrying a ref this build cannot read is
still a row. `GameListing.unreadable` keeps those, because a client that dropped
them would report fewer ways in than the game has.

## What is derived, and therefore cannot be lied about

`GameListing` computes from the record: the seat totals (`seats.total` and
`seats.keyed`, whose difference is the seats that came empty), `endsAt` and
`joinableUntil` from `startedAt` and the [duration rules](../gameplay/durations.md),
`playable` from the [supported protocol set](../protocol/genesis.md), and the
[shelf-life notice](../protocol/genesis.md) for a superseded version.

A game this build cannot play is **returned and marked unplayable**, never
hidden. A lobby that silently omits the game a player is in is the worst possible
answer.

`seatsUsed` — live occupancy — is derivable from nothing. It moves by amendment
and by drop and the board sees neither, so it stays a claim, is rendered as one,
and **nothing filters on it**: a `joinable: true` filter that trusted it would be
a hostile board deciding which games a player is shown.

## Proof of life

The obvious claim — "a hostile board cannot forge a game" — is true and much
weaker than it sounds, because nobody has to forge one. A spammer composes ten
thousand real genesis records with real keys it holds, and every one of them
passes `gameIdOf` and `inspectGenesis`, because those check that a record is well
formed and not that a game exists. The verification filters malformed junk; it
does not filter well-formed fiction, and fiction is what a public board fills
with.

There is exactly one thing on a row a stranger cannot manufacture, and
[resume points](../continuity/resume-points.md) already built it: a signed
checkpoint says *(step, hash)* under a seat's key, bound to the gameId. A
majority of a game's seats signing the same one is a statement only that game's
players could have produced, and it costs about 150 bytes each.

So a row carries the witnesses **without the snapshot**, and the same function
counts them:

```ts
type ResumeClaim = Omit<ResumePoint, "data">;
verifyResumePoint(genesis, claim): Promise<ResumeTally>   // never read `data`
```

`GameListing.proof` is that tally plus the step. **Endorsed by 3 of 4 seats at
step 41,200** is a game; a row with no witnesses is a rumour. Both are returned
and marked, because hiding the unproven rows would hide every game composed in
the last five minutes — and those are the games a board is most needed for.

Two honest limits:

- Witnesses prove a game *reached* a step. They say nothing about whether
  anybody is still there, which is what the TTL and a dial are for.
- They can be replayed from a real board onto a hostile one. That costs the
  attacker nothing and gains them nothing: the row still points wherever its
  refs point, and `expect` catches the arrival.

## Arriving: `expect`

A ref from a person needs no expectation — they were just told what was behind
it. A ref from a board **names a game**, and that is a new way to be wrong.

Post a row for somebody's real gameId, with their real sealed genesis, and refs
pointing at a relay you control. Every check a reader can make passes. They dial,
meet a room you own, and are handed whatever record you like — composed
correctly, so `inspectGenesis` is clean on that one too. They are now playing a
different game under a ref they looked up for another one.

So [`Lobby.open`](the-lobby.md) takes `expect`, and `adopt` refuses a record
whose id is not the one that was asked for. Unset for every caller whose ref came
from a person; `resolve` always sets it.

## resolve

[`resolve(directory, gameId)`](../../packages/net/src/resolve.ts) turns an id
into something to do about it, and stops there — building a driver would be a
third implementation of the join sequence.

```ts
type Route =
  | { kind: "dial"; ref: ConnectionRef; listing: GameListing }
  | { kind: "resume"; point: ResumePoint; tally: ResumeTally; listing: GameListing }
  | { kind: "gone"; problems: string[]; listing?: GameListing };
```

1. `get(gameId)`, then knock on each door in announced order. No ranking between
   transports: every door leads to the same game, and preferring one would be
   the [fallback ladder refs refuse](connection-refs.md). The first that answers
   is the route, and the caller dials it with `expect: listing.gameId`.
2. Nothing answers: fetch each `resume` URL, verify it against the roster in the
   genesis the board supplied, and hand over the furthest point that reached a
   quorum. `Lockstep.resume` is the caller's — only the caller has a driver, and
   it is the half that checks the bytes.
3. A point short of a quorum is a **problem on the route, not a silent skip**.
   "This has 1 of the 2 signatures it needs" is something a player should read
   before concluding their game is gone.

Announcing yourself as a door afterwards is not part of this flow. Over WebRTC
any peer can be a door, including a browser tab — the
[web client](../clients/finding-a-game.md) announces one when the player ticks
the box that says so — but over a socket only a process running a
[room bus](room-bus.md) can, which is why the
[host peer](../clients/host-peer.md) is the one that announces those.

A browser that took up a dormant game announces nothing regardless. It is
holding a state rather than offering a door: nobody asked it to be the place
that game now lives, and a row under a TTL its tab keeps alive is a promise it
is in no position to make.

**Two peers can each resume the same dormant point and each announce a door.**
They stay identical while nobody acts — the simulation is deterministic and
neither has any input — and diverge the moment one of them plays. When the two
rooms meet, the [comparison](../continuity/desync.md) catches it and the minority
rebuilds. That is a property of resuming without a quorum, not a bug in the
board; rows are merged per game, so a client shows one game with two doors rather
than two games.

## Writes: the board's one rule

`announce`, `present` and `withdraw` are signed:

> A row is owned by the key that first announced it. `present` and `withdraw` are
> accepted only when signed by that key.

[`verifyWrite`](../../packages/net/src/directory.ts) is that check, exported for
whoever implements a board. It is access control, not adjudication — the board
is still not deciding whether a game is real. Three consequences:

- **A static-file board is read-only**, which is what "a JSON file behind any
  HTTP server" always meant; its rows are edited by hand, and `announce` against
  one fails with the server's own status.
- **The signature does not make the row true.** It says who posted it, the poster
  can be anyone, and it is not an input to the reader's checks.
- A row signed by a key that is **in the game's roster** is worth marking. Host
  peers hold no seat, so most rows will not qualify — which is why it is a mark
  and not a filter.

## Fetching from a server you do not trust

This is the first HTTP client in the repository, so the discipline is written
down once, here, where it will be copied.

| Rule | Why |
|---|---|
| `AbortSignal.timeout(8_000)` on every request | `fetch` has no default timeout; a board that accepts a connection and never answers hangs a lobby screen forever |
| read through a byte cap (1 MB `list`, 64 kB `get`, 8 MB a resume point) | a hostile board can stream indefinitely, and `response.json()` will buffer all of it |
| `credentials: "omit"`, no custom headers | there is nothing to authenticate with and nothing to send |
| never send the identity, the key, or a fingerprint | reading a board should say what you want, not who you are |
| `cache: "no-store"` on a single lookup | a stale cached row is a dead door presented as a live one |
| every parse defensive | rows are `unknown` until something has checked them, exactly as `decodeFrame` treats the wire |

The body is read through a stream reader rather than `json()`, because the cap
has to bite while the body is arriving and not after.

CORS is the board operator's problem and the client's risk: a browser cannot read
a board that does not send `Access-Control-Allow-Origin`, and the failure is
opaque by design. The client turns it into a sentence, because the alternative is
a `TypeError: Failed to fetch` in a lobby.

## Sizes

A row carries a genesis. Canonicalised, with a real key per seat: ~1.2 kB for
four players with a seat each, ~1.8 kB for a solo game against three SimBots,
~3 kB for six empires of four. SimBot empires are the expensive ones — a bot
profile is inlined per empire. With witnesses and amendments a row lands around
2–4 kB, so 200 games is roughly 500 kB and a few hundred SHA-256 hashes of two
kilobytes each: a fraction of one snapshot, and a few milliseconds of
verification.

It is linear, so `list()` takes a `limit` (default 100), sends it as a query
parameter for a board that understands one, and truncates locally for a board
that does not. A static file that has grown to twenty megabytes is a static file
that needed a service.

## What this does not settle

**Discovery of boards.** Nothing here bootstraps one, and a default board shipped
in the client would be the one piece of centralisation this design has avoided.

**Spam, past the proof.** Witnesses make a played game distinguishable from a
fabricated one. They do nothing about a thousand rows for real games nobody is
in; that is an operator's problem, and this client is deliberately built to be
useful against a board that has not solved it.

**Withdrawal on a crash.** A host that dies withdraws nothing and the row stands
until its TTL. This is what a TTL is, and it means a board's freshest possible
answer is "as of one heartbeat ago" — which is why `resolve` dials.

## Tested

[`directory.test.ts`](../../packages/net/src/test/directory.test.ts) — every row
is fiction of some kind: a genesis filed under someone else's id, a record
`inspectGenesis` refuses, an expired row, a ref this build cannot read, two rows
for one game, a witness for another game, a witness for another step, a board
that never answers, a board that streams forever, a fabrication that is returned
with no proof.
[`resolve.test.ts`](../../packages/net/src/test/resolve.test.ts) — dial, fall
through to a verified point, and report a tally short of quorum.
[`lobby.test.ts`](../../packages/net/src/test/lobby.test.ts) — arriving in a
different game than the one looked up is refused.
