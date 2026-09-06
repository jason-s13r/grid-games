# 0007 — The address book: listings and the rejoin flow

Status: draft
Depends on: 0003 (refs), 0006 (the host peers that announce)
Branch: `address-book`

## The problem

There is no way to find a game. A room code is shared out of band and dies
with its holder. An earlier draft of this plan solved it with a Worker, D1 and
R2; the design moved since: **the board is dumb, the announcers are headless
peers**, and every reader verifies what it reads.

## What the board is

A bulletin board of connection parameters, nothing more. A row is:

```ts
interface Listing {
  gameId: string;              // claimed; every reader re-derives it
  genesis?: string;            // sealed record, so the reader can
  refs: ConnectionRef[];       // one or both transports (0003)
  endStep?: number;            // claimed; readers derive it from the record
  seatsUsed: number; seatsTotal: number;
  joinableUntil?: number;      // claimed; derived from the record by readers
  expiresAt: number;           // TTL; refreshed by heartbeat
}
```

The board stores what is posted and expires what is not re-posted. It
verifies nothing — the Worker draft's one durable rule, kept: junk rows are discarded by readers and bounded by a rate limiter.

Any implementation qualifies: a static JSON file behind any HTTP server for a
friends-only book; a tiny D1/SQLite-backed service for a public one; even the
host peer itself serving its own listing. The client (below) is the only
shared artifact, and it lives in `packages/net` so browser and headless peers
share one implementation.

## The client

New `packages/net/src/directory.ts`:

```ts
export class Directory {
  constructor(url: string, options?: { fetch?: typeof fetch });
  list(filter?: { open?: boolean; joinable?: boolean }): Promise<GameListing[]>;
  get(ref: string): Promise<GameListing | undefined>;
  announce(listing: Listing): Promise<void>;     // POST, host peers call this
  present(listing: Listing): Promise<void>;      // TTL'd heartbeat, same
  withdraw(gameId: string, ref: ConnectionRef): Promise<void>;
}
```

`list()` and `get()` **verify before returning**: `gameIdOf(genesis)` must
equal the claimed id and `inspectGenesis` must be clean; a row that fails is
dropped, not surfaced. `endsAt` and `joinableUntil` are derived from
`startedAt` + the rules, never read from the board.

Exposure of a hostile board: it can flicker rows (bounded by the TTL — the
next heartbeat restores them) or show junk (readers drop it). It cannot
forge a game: the binding `refs → gameId` is only as good as the genesis the
reader hashes, and that is recomputed on arrival every time.

## The rejoin flow

```ts
export async function rejoin(directory, gameId, identity, identityRef?): Promise<Join>;
// 1. get(gameId); dial each live ref in turn (0003's parseRef tells the lobby what it is)
// 2. none answer -> GET the newest resume point from any holder (0006 serves it)
// 3. verifyResumePoint(0005); if clean, resume() into a driver as an observer
// 4. announce ourselves as a ref (0006's heartbeat) so the door keeps existing
```

This is the flow that makes "disconnect and rejoin anytime" true rather than
aspirational, and it works identically over both transports because it is
built from refs.

## Verification

- `packages/net/src/test/directory.test.ts`:
  - `list()` drops a row whose genesis does not hash to its claimed id, and
    one `inspectGenesis` refuses;
  - a row whose `refs` are unparsable is surfaced as degraded, not fatal
    (other refs may still work);
  - expired rows are absent;
  - `rejoin` against a fake board + the 0004 fake bus: dial → join, and
    dial-all-fail → resume-from-point, end to end with real signatures.
- A hostile board test: every row tampered (ids swapped, junk genesis) —
  `list()` returns nothing rather than something.

---

# Implementing it

## What ships, and the sentence the code does not enforce

| File | What it is |
|---|---|
| `packages/net/src/directory.ts` | `Listing`, `Directory`, the verification |
| `packages/net/src/resolve.ts` | gameId → a route: dial this, or resume from this |
| `packages/net/src/lobby.ts` | `expect`: refuse a game that is not the one asked for |
| `packages/net/src/resume.ts` | 0005's file: `verifyResumePoint` takes a claim without bytes |
| `packages/net/src/test/directory.test.ts` | the board is hostile, and the rows are fiction |
| `apps/host` | 0006's host peer announces and heartbeats |

The claim to test first is the one the plan's safety argument rests on:

> It cannot forge a game: the binding `refs → gameId` is only as good as the
> genesis the reader hashes, and that is recomputed on arrival every time.

Nothing recomputes it on arrival. `Lobby.adopt` runs `inspectGenesis`
(`lobby.ts:292`), which checks that a record hashes to *its own* claimed id —
self-consistency, and nothing about which game was asked for. There is no
expectation anywhere in the lobby, because until this plan a ref only ever
arrived from a human being who had just been told what it was.

So: I post a row for somebody's real gameId, with their real sealed genesis,
and `refs: ["wss://mine/room"]`. Every check in `list()` passes — the record
is genuine, it hashes to the id it claims, `inspectGenesis` is clean. A
reader dials my relay, meets a room I control, and is handed whatever genesis
I like. `inspectGenesis` passes on that one too, because I composed it
correctly. The reader is now playing a different game under a ref it looked
up for another one, and the only thing that would have caught it is a
comparison nobody makes.

The fix is small and belongs here, in the plan that first makes a ref arrive
from a stranger:

```ts
// Lobby.open's options
/** The game we came here for. A ref from an address book names a game, and
 *  arriving in a different one is the failure that ref lookup introduces —
 *  the record checks out, it is simply not the record we were promised. */
expect?: string;
```

and in `adopt`, before the seat search:

```ts
if (this.expect && genesis.gameId !== this.expect) {
  this.fail(`that room is running a different game.`);
  return;
}
```

Unset for every existing caller, which is every caller that got its ref from
a person. `resolve()` below always sets it.

## The row, corrected

The body gives two names to one type — `interface Listing` in **What the
board is**, `Promise<GameListing[]>` in **The client** — and the type it
gives cannot express the behaviour its own verification section asks for. Two
concrete conflicts:

- `refs: ConnectionRef[]` is the parsed form, so a row with one unparsable
  ref cannot be represented at all. The verification section wants exactly
  that row "surfaced as degraded, not fatal". On the wire refs are the
  strings `formatRef` produces (0003) and the client parses them.
- `get(ref: string)` takes a ref; the rejoin flow calls `get(gameId)`.

What is on the board, and what a reader may do with each field:

| Field | Status |
|---|---|
| `gameId` | claimed — re-derived with `gameIdOf(genesis)`; a row that disagrees is dropped |
| `genesis` | the sealed record, canonical JSON. Everything below is derived from it or is a claim |
| `refs: string[]` | claimed. Parsed per entry; an unparsable one is dropped and the row survives |
| `resume?: string` | claimed — where a resume point can be fetched (0006's `/room/:code/resume`) |
| `witnesses?` | **checkable, and the only field a spammer cannot fake** — see below |
| `amendments?`, `drops?` | needed to check the witnesses; each is re-verified anyway |
| `expiresAt` | the board's, advisory. Compared against the reader's own clock |
| `seatsUsed`, `seatsTotal` | see below |

`seatsTotal` is derivable: it is the sum of `empire.members.length` over the
genesis. So is the count of seats that came filled — `Roster.fromGenesis`
skips a member with no key (`roster.ts:38`), so `roster.all().length` is the
keyed seats and the difference is the vacancies 0010 will create. Neither
number needs to be on the board and both should be computed, because a
derived number cannot be lied about.

`seatsUsed` — live occupancy — is derivable from nothing. It moves by
amendment and by drop, and the board sees neither. It stays on the row as a
claim, it is rendered as one, and the client never filters on it: a
`joinable: true` filter that trusts `seatsUsed` is a hostile board deciding
which games a player is shown.

Two rows, or one? The body's shape is one row per game holding several refs,
which means two host peers announcing the same game overwrite each other —
and the second one's `announce` silently deletes the first one's door. Rows
are keyed by **(gameId, ref)**: one row per door, one TTL per door, so a host
dying removes its own door and not the game. `withdraw(gameId, ref)` already
takes both, which is the API telling us what the type should have been.
`Directory.list()` groups them, so a `GameListing` — one per game, refs
merged, the union of what several announcers claimed — is what a caller sees.

## `packages/net/src/directory.ts`

```ts
// Finding a game, from a board that is allowed to lie.
//
// The board holds connection parameters and nothing else. It is not asked to
// be honest, only to be reachable: every row it hands back is re-derived
// from the sealed genesis record inside it, and a row that does not survive
// that is dropped without being shown. What survives is still only a claim
// that a game is *reachable* — see the witnesses below for the one part of a
// row a reader can believe without dialling it.
//
// This is the first HTTP client in the repository, which is why the fetch
// discipline below is spelled out rather than assumed.

/** One door, as it sits on the board. */
export interface Listing {
  gameId: string;
  /** The sealed record. Required: without it there is nothing to verify and
   *  the row is a string somebody typed. */
  genesis: Genesis;
  /** `formatRef` output, one per entry. Strings, so a row carrying a ref
   *  this build cannot parse is still a row. */
  refs: string[];
  resume?: string;
  witnesses?: SignedCheckpoint[];
  amendments?: SignedAmendment[];
  drops?: SignedDrop[];
  step?: number;
  hash?: number;
  seatsUsed?: number;
  expiresAt?: number;
}

/** A game, as a caller sees it: rows merged, everything derivable derived. */
export interface GameListing {
  gameId: string;
  genesis: Genesis;
  /** Parsed, deduplicated, in the order they were announced. */
  refs: ConnectionRef[];
  /** Refs that were on the board and this build could not read. Kept so a
   *  client can say "one of its doors needs a newer version" rather than
   *  quietly showing fewer ways in than exist. */
  unreadable: string[];
  resume: string[];
  /** Derived from the record, never read from the board. */
  seats: { total: number; keyed: number };
  endsAt?: number;
  joinableUntil?: number;
  /** Whether this build can play it at all, and until when it is worth
   *  offering: `playsProtocol` and `shelfLife` from 0001. A game this build
   *  cannot join is *shown as unplayable*, not hidden — a lobby that silently
   *  omits a game the player is in is the worst possible answer. */
  playable: boolean;
  sunset?: { version: number; until: string };
  /** Absent when the row carried no witnesses. `ok` means a majority of this
   *  game's seats signed that it reached `step`. */
  proof?: ResumeTally & { step: number };
}
```

`list()` and `get()` run the same pipeline per row, and the order matters:

```ts
async function read(row: unknown): Promise<GameListing | undefined> {
  if (!plausible(row)) return undefined;            // shape only
  if (row.gameId !== (await gameIdOf(row.genesis))) return undefined;
  const problems = await inspectGenesis(row.genesis);
  // "protocol" is not a reason to hide a game — it is a reason to say so.
  if (problems.some((p) => p !== "protocol")) return undefined;
  …
}
```

Splitting `"protocol"` out of the refusals is the whole of the 0001 tie-in
and it is two lines. `inspectGenesis` returns tags rather than sentences
(`genesis.ts:56-62`), so the client keeps the tag and lets the caller phrase
it; a `GenesisProblem` rendered raw in a lobby is not a message.

## Proof of life, which is the only thing on a board worth believing

The body says a hostile board "cannot forge a game". True, and much weaker
than it sounds, because **nobody has to forge one**. A spammer composes ten
thousand real genesis records with real keys it holds, and every one of them
passes `gameIdOf` and `inspectGenesis`, because those check that a record is
well formed and not that a game exists. `list()`'s verification filters
malformed junk; it does not filter well-formed fiction, and fiction is what a
public board fills with.

There is exactly one thing on a row a stranger cannot manufacture, and 0005
already built it. A signed checkpoint says *(step, hash)* under a seat's key,
bound to the gameId. A majority of a game's seats signing the same one is a
statement only that game's players could have produced — and it costs about
150 bytes each.

So a listing carries the witnesses, without the snapshot:

```ts
/** 0005's tally, over a claim that has no bytes attached. verifyResumePoint
 *  never reads `point.data` — it checks the roster, subtracts verified
 *  drops, and counts agreeing signatures — so the same function answers
 *  "should I believe this row" and "should I adopt this state", and the
 *  second question is Lockstep.resume's alone. */
export type ResumeClaim = Omit<ResumePoint, "data">;
export function verifyResumePoint(
  genesis: Genesis,
  point: ResumeClaim,
): Promise<ResumeTally>;
```

That is a one-line widening of 0005's signature and no change to its body.
What it buys here is a row a reader can rank by without dialling anything:
**endorsed by 3 of 4 seats at step 41,200** is a game; a row with no
witnesses is a rumour. The client returns both and marks which is which,
because hiding the unproven rows would make a new game — one that has not
reached its first snapshot — invisible on the board it most needs to be on.

Two honest limits, both worth the sentence:

- Witnesses prove a game *reached* a step. They say nothing about whether
  anybody is still there, which is what the TTL and a dial are for.
- They can be replayed from a real board onto a hostile one. That costs the
  attacker nothing and gains them nothing: the row still points wherever
  its `refs` point, and `expect` catches the arrival.

## Fetching from a server you do not trust

Nothing in this repository has ever made an HTTP request — `grep fetch(`
across `packages/*/src` and `apps/*/src` returns nothing — so the discipline
is worth writing down once, here, where it will be copied.

| Rule | Why |
|---|---|
| `AbortSignal.timeout(8_000)` on every request | `fetch` has no default timeout; a board that accepts a connection and never answers hangs a lobby screen forever |
| read through a byte cap (1 MB `list`, 64 kB `get`) | a hostile board can stream indefinitely, and `await response.json()` will happily buffer all of it |
| `credentials: "omit"`, no custom headers | there is nothing to authenticate with and nothing to send; a board is a stranger |
| never send the identity, the key, or a fingerprint | reading a board should say what you want, not who you are |
| `cache: "no-store"` on `get` | a stale cached row is a dead door presented as a live one |
| every parse defensive | rows are `unknown` until `read()` says otherwise, exactly as `decodeFrame` treats the wire |

`options.fetch` in the body's constructor stays, and is the whole of the test
seam: `directory.test.ts` hands in a function and never opens a socket.

CORS is the board operator's problem and the client's risk: a browser cannot
read a board that does not send `Access-Control-Allow-Origin`, and the
failure is opaque by design. The client turns it into a sentence — "that
board did not allow this page to read it" — because the alternative is a
`TypeError: Failed to fetch` in a lobby.

## The board's one rule

`announce`, `present` and `withdraw` are unauthenticated in the body, which
means anyone can withdraw every game on a public board, and there is no way
for the board to tell a heartbeat from a hijack. The board still verifies
nothing about *games*; it verifies one thing about *writes*:

> A row is owned by the key that first announced it. `present` and `withdraw`
> are accepted only when signed by that key.

The announcer already holds an identity — 0006's host peer loads one with
`identityAt` before it does anything else — so this is a signature over
`(gameId, ref, expiresAt)` and a `verify` on the board. It is access control,
not adjudication: the board is still not deciding whether a game is real.

Three consequences to state rather than discover:

- **A static-file board is read-only.** That is fine and is what "a static
  JSON file behind any HTTP server for a friends-only book" always meant;
  its rows are edited by hand. `Directory.announce` against one fails with
  the server's own status, and the CLI says so.
- **The signature does not make the row true.** It says who posted it, and
  the poster can be anyone. It is not an input to `read()`.
- **A row signed by a key that is in the game's roster is worth marking**,
  and it is a check the reader can do for free with the genesis it already
  hashed. Host peers hold no seat (0006), so most rows will not qualify —
  which is exactly why it is a mark and not a filter.

## `resolve`, not `rejoin`

```ts
export async function rejoin(directory, gameId, identity, identityRef?): Promise<Join>;
```

Three problems. `Join` is not a type in the repository; `identityRef` is
never mentioned again; and building a driver inside `packages/net` would be
the *third* implementation of the join sequence, after
`headless/src/peer.ts:66-149` and whatever `apps/web` does — each of which
has real reasons for its own version (WebRTC installation and a pump timer in
one, a render loop in the other).

So the shared artifact resolves and stops:

```ts
export type Route =
  | { kind: "dial"; ref: ConnectionRef; listing: GameListing }
  | { kind: "resume"; point: ResumePoint; tally: ResumeTally; listing: GameListing }
  | { kind: "gone"; problems: string[] };

/** Turn a game id into something to do about it. Dials nothing and builds
 *  nothing: the caller has a join sequence already, and what it lacked was
 *  an answer to "where is this game, and if nowhere, what state is it in". */
export async function resolve(
  directory: Directory,
  gameId: string,
  options?: {
    probe?: (ref: ConnectionRef) => Promise<boolean>;
    now?: () => number;
  },
): Promise<Route>;
```

The body's four steps map onto it, with the two that were doing more than
they said made explicit:

1. `get(gameId)`, refs in announced order. `probe` opens each and closes it —
   default is `openConnection` with a short deadline — and the first that
   answers is the route. **The caller passes `expect: gameId` to
   `Lobby.open`**, which is the arrival check above and the reason this
   function returns a ref rather than a connection.
2. No ref answers: fetch each `resume` URL, run `verifyResumePoint`, keep the
   newest point whose tally is `ok`. A point that fails is a problem on the
   route, not a silent skip — "the resume point for this game was endorsed by
   1 of 4 seats" is something a player should read before deciding.
3. `Lockstep.resume(point)` is the caller's, because only the caller has a
   driver. `resolve` hands over the verified point and the tally.
4. Announcing yourself as a door is **not** part of this flow, and the body's
   step 4 quietly assumes it is. A peer can be a door only if something can
   dial it: over WebRTC that is true of any peer, including a browser tab,
   which can host a room and announce `{kind:"rtc", code}`. Over a socket it
   is true only of a process running a room bus — a host peer (0006), never a
   browser. So the step belongs to `apps/host`, and a browser that resumed a
   dormant game is holding a state, not holding a door.

The fork this creates is real and is worth naming here rather than
discovering in 0010. Two peers can each resume the same dormant point and
each announce a door. They stay identical while nobody acts — the simulation
is deterministic and neither has any input — and diverge the moment one of
them plays. When the two rooms meet, `compare` catches it and the minority
rebuilds; while they do not meet, the board shows two doors into one gameId
and a joiner takes whichever it dialled first. That is a property of resuming
without a quorum, not a bug in the board, and the mitigation is the one the
body already has: rows are merged per game, so a client shows *one* game with
two doors rather than two games.

## Sizes, with numbers

A row carries a genesis, so the board's payload is the question the plan does
not cost. Canonicalised, with a real key per seat:

| Game | genesis |
|---|---|
| solo vs three SimBots | 1,770 B |
| four players, one seat each | 1,152 B |
| four empires of three | 1,656 B |
| six empires of four, two SimBots | 3,054 B |

SimBot empires are the expensive ones: a `BotProfile` is inlined per empire
(`specs.ts:129-132`), six phases each. Add four witnesses and their
amendments and a row lands around 2–4 kB, so **200 games is roughly 500 kB
and 400 SHA-256 hashes of two kilobytes each** — a fraction of one snapshot,
and a few milliseconds of verification. Affordable, and linear: a board with
ten thousand rows is twenty megabytes, so `list()` takes a `limit` (default
100), sends it as a query parameter for a board that understands one, and
truncates locally for a board that does not. A static file that has grown to
twenty megabytes is a static file that needed a service.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `resume.ts`: `ResumeClaim`, the widened signature | yes — no body change |
| 2 | `lobby.ts`: `expect`, and the refusal in `adopt` | yes — unset everywhere |
| 3 | `directory.ts`: types, `read()`, `list`, `get` | yes |
| 4 | `directory.ts`: `announce`, `present`, `withdraw`, and the signature | yes |
| 5 | `resolve.ts` + `Route` | yes |
| 6 | `test/directory.test.ts`: the hostile board and the fictional one | yes |
| 7 | `apps/host`: `--announce <url>`, heartbeat, withdraw on SIGTERM | yes |
| 8 | Docs | yes |

Step 2 is the one to review rather than write: it is a new way for a join to
fail, and the sentence a player sees when it does is the whole value of it.

## Docs

| File | Change |
|---|---|
| `docs/mesh/address-book.md` | new: what a board is, what a row means, what the client checks and what it cannot |
| `docs/mesh/README.md` | a link, and the sentence that a board is a directory and never a server |
| `docs/mesh/the-lobby.md` | `expect`: a ref from a board names a game, and arriving elsewhere is a refusal |
| `docs/mesh/connection-refs.md` | one charset, two refs, one row — 0003 promised this and this is where it is used |
| `docs/continuity/resume.md` | witnesses without bytes are a proof of life; the same tally answers both questions |
| `docs/clients/host-peer.md` | 0006's page: announcing, the heartbeat, and withdrawing on the way out |
| `docs/trust-and-verification/trust-model.md` | a row of the board: what a hostile directory can do, ending at "waste your time" |

The trust-model row is the one that needs care. A board's power is real and
small: flicker rows, show fiction, learn who asks about what. It cannot forge
a game, and after step 2 it cannot misroute one either.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| a row whose genesis does not hash to its id is dropped | `test/directory.test.ts` |
| a row `inspectGenesis` refuses for anything but protocol is dropped | the same file |
| a row this build cannot play is **returned, marked unplayable** | the same file — the 0001 tie-in, and the opposite of the body's "dropped" |
| a row with one unparsable ref keeps its other refs and reports the bad one | the same file |
| an expired row is absent, against an injected clock | the same file |
| two rows for one game merge into one listing with two refs | the same file |
| **a fabricated but well-formed row is returned, and carries no proof** | the same file — the limit the body does not state |
| **a row whose witnesses reach quorum is marked proven; one witness short is not** | the same file, with real signatures over a real roster |
| a witness for another game's id does not count | the same file |
| a board that never responds fails in 8 s, not never | the same file, with a `fetch` that hangs |
| a board that streams forever is cut off at the cap | the same file |
| **arriving in a different game than the ref promised is refused** | `test/lobby.test.ts` — it succeeds on today's tree, which is why it is written |
| `resolve` dials, and falls through to a verified resume point when nothing answers | `test/resolve.test.ts`, over 0004's fake bus |
| `resolve` reports the tally when the only resume point is short of quorum | the same file |
| every row tampered: `list()` returns nothing | the body's hostile-board test, kept |
| nothing moved the hash | `pnpm test`; `packages/sim` is not in the diff |

The three bold rows are the ones that change what this plan claims. The first
two replace "the board cannot lie" with the true and more useful "the board
can say anything, and here is the one field that costs a stranger a quorum of
somebody else's keys". The third closes the gap that made the first two worth
having.

## What this plan does not settle

**Discovery of boards.** A board is a URL that arrives the way a room code
used to. Nothing here bootstraps one, and a default board shipped in the
client would be the one piece of centralisation this design has avoided —
worth deciding deliberately in 0008 rather than by accident here.

**Spam, past the proof.** Witnesses make a *played* game distinguishable from
a fabricated one. They do nothing about a thousand rows for real games nobody
is in, and a public board will need a rate limiter and probably a cost. That
is an operator's problem and the client is deliberately built to be useful
against a board that has not solved it.

**Withdrawal on a crash.** A host peer that dies withdraws nothing; the row
stands until its TTL. This is what the TTL is, and it means a board's freshest
possible answer is still "as of one heartbeat ago" — which is why `resolve`
dials rather than believing.

**The vacancies that make a listing worth reading.** `seatsUsed` is a claim
until 0010 puts vacancies in the genesis, at which point the interesting
number — how many seats came empty — becomes derivable from the record like
everything else, and the claim can be dropped rather than rendered.
