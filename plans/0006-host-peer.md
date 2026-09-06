# 0006 — The host peer: doorman, relay, archiver

Status: draft
Depends on: 0004 (socket transport), 0005 (resume points it serves)
Branch: `host-peer`

## The problem

Multi-day games die with the tab that owns them. The room code is the host's
PeerJS id; when the tab closes, the door closes. What is missing is a peer
that stays: one process, connected to the room, holding the door open and the
game's paper trail, in *both* transports — which is what keeps the
decentralised model intact (WebRTC rooms get the same persistence as hosted
ones).

The design's load-bearing claim: **a host is a client with a job, never a
server-of-truth.** In the current code the host's authority ends at genesis —
it composes the record and broadcasts it, and "nothing after that point needs
a host at all" (`packages/net/src/lobby.ts:13`). The host peer's ongoing
role is therefore service, never control:

| Job | Existing piece it reuses |
|---|---|
| Doorman — re-sends the sealed genesis to late joiners | `Lobby.welcome`, `lobby.ts:161` |
| Snapshot source — answers `SNAPSHOT_REQUEST` | any seated or observer peer already does |
| Resume-point publisher — PUTs/holds the bundle from 0005 | `resumePoint()` from 0005 |
| Archiver — writes the log it verifies | `apps/observer`'s `export`/`verify` flow |
| Listings announcer — heartbeats its endpoints (0007) | the address-book client |

## The instance

New `apps/host` (sibling of `apps/bot`, `apps/observer`), thin because the
packages already know how to be a peer:

```
tessera-host [--plan <file>] [--ref <wss://… | tsr-…>] [--as <id>]
             [--transport wss|rtc] [--port 8080]
```

- Identity via `identityAt` (`packages/headless/src/identity.ts`) — same
  key file discipline as bot/observer.
- Joins as **observer**: no seat, no `onStart` seat, zero effect on
  consensus, no liveness/abandonment side effects. N host peers are
  explicitly supported — `rankArchives` already counts a game once however
  many observers archived it.
- `--as <id>`: the stable id / requested room name ("the door back into a
  game", per the observer's own docs). One host claims the room name; a
  replacement host re-claims it once freed. This is the code that makes the
  room reachable by one string however many times its host is replaced.

## WSS mode: the relay in the same process

In socket mode the host runs the 0004 room bus in-process, so the room's
"server" is the host itself — no separate deployment. Node's `ws` does the
upgrade; the fanout logic is the reference bus from 0004's tests, unchanged.
On the same port it serves, over plain HTTP:

```
GET /room/:code/resume       -> the newest resume point it holds (0005 shape)
GET /room/:code/archive      -> the archive it is writing
```

Both are read-only and verified by whoever reads them (witness quorum;
`verifyArchive`). Serving them is a few lines once the socket upgrade is
already being handled. **Browsers require `wss://`** — a publicly listed host
needs a cert (Caddy/nginx in front, or Let's Encrypt); `ws://` is fine for
headless peers, LAN and Tailscale.

## RTC mode: the same peer, the other transport

Same binary, `--transport rtc`: joins via PeerJS exactly as the observer does
today, with `--as` claiming the room code. Provides the same four jobs. The
transport is the only thing that differs — that is the whole point of the
`ConnectionRef` seam.

## Roster composition (the gap this plan fills)

`Lobby.host(plan)` needs a team picker; a headless host has none. Two modes,
both land here:

- **`--plan <file>`**: a fixed roster — empires of member keys, SimBot
  difficulties or custom profiles (0009), map size, duration (0002) and
  **vacancies** (0010) — handed to `Lobby.host(plan)` as-is. The genesis it
  seals is a fact of the game like any other. Vacancies are what make a
  headless-hosted game worth announcing: a room composed by a process at 09:00
  with four empty capitals is a game strangers can actually walk into.
- **`--auto`: seats joiners as they arrive** — `composeTeams` with one empire
  per joiner until `maxSeats`, then closes. Lower-risk default: a human tab
  can still do the fine-grained picking by hosting with the existing UI and
  letting the headless host join *after* genesis.

Once 0009 lands the host also broadcasts its plan as a draft while it waits, so
a headless-composed game is as legible before sealing as a tab-composed one.
Nothing about the seal changes: the host still composes, everyone else still
verifies and refuses.

Which one a room used is visible in the record it produced; nothing else has
to be agreed.

## Persistence & the managed factory

- The host keeps a `FileArchive` continuously (it is a full observer).
- The **creator's "create game" flow** may point at a managed service whose
  only job is a factory: spin up a host instance on demand, hand back its
  connection params, get out of the way. The game never depends on the
  factory mid-game — the host is the dependency, and hosts are replaceable
  (see below). A self-hosted host and a managed one are the same artifact.
- **Host replacement:** a rejoining replacement host fetches the newest
  resume point + archive from the old one (or the address book), fast-forwards,
  and takes over the door. gameId is stable; the room binding is re-posted
  (0007). No data migration, because the archive *is* the migration.

## Verification

- Two host peers, same game: both archive; `rankArchives` counts the game
  once. One dies; the other keeps the door (joins still answered) and the
  archive (log never gapped).
- A replacement host re-claims a room code and a late joiner finds it by the
  same string.
- `--plan` and `--auto` both end in an `inspectGenesis`-clean record that a
  normal browser join accepts.
- A host peer's presence in a game changes no hash and no roster: compare
  table state with and without it.
- Archive served over `GET /room/:code/archive` passes `verifyArchive`.

---

# Implementing it

## What ships, and the four minutes the plan does not survive

| File | What it is |
|---|---|
| `apps/host/` | new package: CLI, HTTP surface, `ws` upgrade |
| `packages/net/src/roombus.ts` | 0004's file gains `localPair()` |
| `packages/net/src/teams.ts` | `checkPlan` learns about a peer that is deliberately unseated |
| `packages/net/src/lobby.ts` | `HostPlan.watching`; `hosting` on `open` |
| `packages/net/src/archive.ts` | a gap in the log is recorded rather than implied |
| `packages/net/src/lockstep.ts` | `onAdopted` |
| `packages/headless/src/peer.ts` | `hostGame`; a `joinGame` that loads WebRTC only when it needs it |
| `packages/headless/src/store.ts` | `resume.json`; the head/log race |

The lead finding first, because it decides the shape of the app rather than a
detail inside it.

**A host peer stops being able to serve a resume point about four minutes
after the last player leaves.** `resumePoint()` (0005) walks the witnessed
steps and returns the newest one for which it still holds the *bytes*:

```ts
for (const step of [...this.witnesses.keys()].sort((a, b) => b - a)) {
  const stored = this.snapshots.get(step);
  if (!stored) continue;
```

`this.snapshots` is a `SnapshotStore` with `keep = 8` (`snapshots.ts:23`),
and `checkpoint()` calls `put` every `snapshotInterval` on **every** peer,
seat or not (`lockstep.ts:604-606` — the signing half above it is gated on a
seat, the `put` is not). So the store rolls forward at one entry per 30 s
whether or not anybody is playing. `witnesses` does not roll: it only gains
an entry when a CHECKPOINT arrives, and once the room is empty none do. Eight
snapshot intervals — four minutes — after the last seat disconnects, the two
maps are disjoint, `resumePoint()` returns `undefined`, and it never returns
anything again.

That is not an edge case for this plan, it is the plan: a host peer exists so
that a three-day game can be dormant overnight and re-enterable in the
morning. Serving `/resume` off a live driver serves it for four minutes.

So the host **persists** the resume point rather than deriving it on demand.
The bytes are already on disk — `FileArchive.writeSnapshot` (`store.ts:161`)
writes every checkpoint it sees into `snapshots/` and never deletes one. What
is missing is the envelope, so the host polls `driver.resumePoint()` on the
archive's own flush timer and keeps the newest one it has ever seen:

```ts
// packages/headless/src/store.ts, beside head.json and written the same way
async resume(point: ResumePoint): Promise<void> {
  if (point.step <= this.resumedAt) return;
  this.resumedAt = point.step;
  const path = join(this.dir, RESUME);
  await writeFile(`${path}.tmp`, `${JSON.stringify(point)}\n`);
  await rename(`${path}.tmp`, path);   // head.json's discipline, same reason
}
```

`readResumePoint(dir)` is its counterpart, and `GET /room/:code/resume` is
that file. Three things fall out that the plan needs anyway: the endpoint
survives a host restart, a replacement host fetches exactly the artifact its
predecessor wrote, and the host is never asked to hold a multi-day game's
worth of snapshots in memory to answer a request that arrives once a week.

## Six things the body assumes that the code does not do

**1. The lobby's watchdog kills a waiting socket host at fifteen seconds.**
`Lobby`'s constructor arms it whenever the lobby is a joiner
(`lobby.ts:110-118`), and it fires if the phase is still `waiting` with no
peers. A socket-mode host peer joins its own room — there is nobody else in
it by definition — so `--auto` and `--plan` both fail before the first player
arrives. The fix is not to change the watchdog. It is to notice that a host
peer running the bus **is hosting**, and 0003 already has the seam: `open`
takes a `connect?: Opener`, added as a test injection point, and it is what
lets the host supply an in-process connection. What it does not have is a way
to say "socket ref, but I created this room", because `join` is derived as
`!!ref` and `code` is derived from the ref. One field:

```ts
static async open(
  identity: Identity,
  ref?: ConnectionRef,
  options: ConnectOptions & { connect?: Opener; hosting?: boolean } = {},
): Promise<Lobby>
```

`hosting` defaults to `ref === undefined`, which is every existing call. It
means "nobody is going to send me a genesis record": no watchdog, phase
`hosting`, and the ref kept as given so `code` and `shareable` stay right.
0003's comment that `undefined` means "start a room here, which only WebRTC
can do" retires here, and it retires without `openConnection` learning
anything.

**2. `checkPlan` refuses every plan a headless host can compose.** `host()`
calls `checkPlan(plan, [this.identity.key, ...this.members.values()])`
(`lobby.ts:254`) and `checkPlan` refuses when anyone in that list is unseated
— `"somebody here has no seat"` (`teams.ts:82`). The host's own key is always
in the list and a host peer never seats itself. Every `--plan` and every
`--auto` composition fails this check, on the first try, in both transports.
0004 predicted this ("0006 hits it on its first day"); this is the plan that
pays for it.

The rule is worth keeping — it is the guard that stops a browser host sealing
a game with somebody's name missing from it — so it gains an exception rather
than losing the check:

```ts
export interface Plan {
  empires: MemberKey[][];
  simbots: readonly Difficulty[];
  /** Keys that are present and deliberately unseated. A host peer's own key
   *  is the whole of this list today: it composes the game and then watches
   *  it. Named rather than inferred, because "the composer is unseated" and
   *  "the composer forgot to seat themselves" are the same tree and only one
   *  of them is on purpose. */
  watching?: readonly MemberKey[];
}
```

`checkPlan` deletes them from `waiting` before the "somebody here has no
seat" test, and refuses a key that is both seated and watching. `HostPlan`
gains the same field and `Lobby.host` passes it through. 0010 will reach for
the same seam from the other side — a seat with nobody present — and it is
worth knowing now that the two are separate holes in the same check.

**3. `joinGame` always loads WebRTC, and cannot host.** `installWebRTC()` is
the first line of the function (`peer.ts:67`) and `shutdownWebRTC()` is in
`stop()`. A socket-mode host would load `node-datachannel`, bind nothing, and
carry a native dependency it never calls. And `joinGame` only ever joins: it
passes `options.code` to `Lobby.open`, so there is no path to `host(plan)` in
the package at all.

**4. `--as` is two different things on the two transports.** The body defines
it as "the stable id / requested room name", which is one thing on WebRTC
because a room code *is* a peer id, and two things on a socket, where the
room is a path on a relay and the id is what the bus stamps on `from`. Split
them: `--room <name>` is what the bus calls the room; `--as <id>` stays the
peer id, on both transports, matching `ConnectOptions.id` (0003) exactly. In
RTC mode `--as` still becomes the room code, because there it still is one.

**5. `--auto`'s cap is the wrong number, and it has no trigger.** "one empire
per joiner until `maxSeats`" — `MAX_SEATS` is seats *within* one empire
(`teams.ts:67`); the ceiling on empires is 255 (`genesis.ts:80`). And a room
that never reaches the cap never seals, so a game for four that three people
turn up to waits forever. Two flags, both explicit:

```
--auto <n>       seal as soon as n players are here, one empire each
--wait <secs>    seal early at this deadline with whoever is present (>= 2)
```

`--plan` needs no trigger of its own: it names the keys, so it seals when
every seated key is present. That is also the only reading of `--plan` that
`checkPlan` accepts, since a plan seating an absent key is "a stranger is
seated" until they arrive.

**6. Node has a WebSocket client and no WebSocket server.** 0004 needed no
dependency because both browsers and Node 22 ship a global `WebSocket`
client. The upgrade side is not in the platform, and this repository has
exactly two runtime dependencies today (`node-datachannel`, `peerjs`), so
adding one is a decision rather than a detail. `ws` is the answer: no
dependencies of its own, and the alternative is a hand-written handshake,
frame parser, masking, fragmentation and close protocol — a few hundred lines
of code whose bugs are security bugs. It lands in `apps/host` alone;
`packages/net` stays dependency-free, which is what keeps `RoomBus` written
against `BusSocket` worth the abstraction.

## The host's own seat at the bus: `localPair`

The host is both the relay and a peer in the room. Two ways to connect it to
itself, and the choice is not obvious.

Dialling `ws://127.0.0.1:port` exercises exactly the code every other client
runs, which is a real argument. Against it: the host would then be subject to
its own rate limit, its own room-peer cap and its own version check; it can
be `closed` by its own bus; and its liveness inside its own game would depend
on a TCP connection to itself surviving whatever the process is doing. That
is a lot of new failure modes for a peer whose entire job is not to go away.

So the host attaches in process, and `roombus.ts` grows the pair:

```ts
/** A client attached to a bus with no socket under it. The bus sees a
 *  BusSocket; the transport sees a SocketLike; neither learns that the other
 *  end is in the same process. Delivery is deferred by a microtask so that a
 *  handler cannot re-enter the bus from inside a send, which is the one way
 *  an in-process pair behaves differently from a real one. */
export function localPair(bus: RoomBus): SocketLike;
```

It is about thirty lines and it is `fakesocket.ts` minus the deliberate
queueing, which is worth saying because it means the shape is already proved
by 0004's tests before this plan writes a line of it.

The host then opens its lobby with an opener that returns a `SocketTransport`
over that pair:

```ts
const lobby = await Lobby.open(identity, ref, {
  hosting: true,
  connect: () => openSocketOn(localPair(bus), ref),
});
```

The cost is honest and belongs in the docs: **the host never exercises the
reconnect path**, so a bug in `SocketTransport`'s held buffer or redial shows
up in every player and not in the host. That is an argument for the socket
tests in 0004 covering a *client* reconnecting to a live `RoomBus`, which is
where they were going anyway.

## The archive it serves, and the two ways it stops verifying

The plan's last verification line is "Archive served over
`GET /room/:code/archive` passes `verifyArchive`". Two things in the current
tree stop that being true, and both become routine rather than rare the
moment an archive is a URL somebody polls.

**The head/log race.** `FileArchive.flush()` drains the pending lines, then
awaits a write per new snapshot, and only then reads `steps` and `hash` off
the live source (`store.ts:134-158`). Every `await` in between is a chance
for `pump()` to advance the simulation, so head can describe a step whose
moves are still in `pending`. `verifyArchive` replays the log to `game.steps`
and compares to `game.hash` (`archive.ts:302-311`), so the result is a hash
mismatch on an archive that is not wrong — it was only read at an awkward
moment. An observer meets this on a crash; a served endpoint meets it
whenever a fetch lands during a flush.

The fix is to take the head figures at the instant the log is cut, which is
the one place nothing can interleave:

```ts
private drain(): Promise<void> {
  // Before the splice and with no await between: whatever goes to disk on
  // this pass covers every step below `steps`, and `hash` is that state.
  this.mark = { steps: this.archive.steps, hash: hex(this.options.source.hash()) };
  if (this.pending.length === 0) return this.queue;
  const lines = this.pending.splice(0, this.pending.length);
  …
}
```

and `flush()` writes `this.mark` instead of re-reading. The mark is taken even
when nothing is pending, because a quiet game still advances: coins spawn and
territory decays whether or not anyone clicked.

`onApplied` fires *before* `sim.advance` (`lockstep.ts:444-445`), so a mark
taken here may sit one step behind a record already in the log. That is the
safe direction — `fastForward(steps, moves)` simply does not reach the extra
move, and the next flush covers it.

**The hole an adopted snapshot leaves.** `adopt()` moves the simulation
forward without `onApplied` firing for the steps it skipped
(`lockstep.ts:1219-1252`), so the log jumps and nothing records that it did.
`FileArchive.from` was fixed on the first record it ever wrote
(`store.ts:106-112`), so an archive that began at genesis still claims
`from: 0` and `verifyArchive` replays it into a mismatch it cannot account
for. This is not hypothetical for this peer: 0004's reconnect wiring
(`connection.onReconnect = () => driver.requestSnapshot()`) makes adoption
the *normal* response to a socket blink, and a host peer is the process that
runs for days across every blink there is.

`Lockstep` gains one hook, fired at the end of a successful `adopt`:

```ts
/** The simulation was moved to a state rather than advanced into it, so
 *  anything writing the inputs down has a hole between the step it last saw
 *  and this one. Nothing in the driver needs to know; an archive does. */
onAdopted?: (step: number) => void;
```

`Archive.attach` chains it like the other three, records
`{ k: "gap", to: step }`, and sets `from` to that step so **every existing
reader refuses correctly** — including one built before this change, which
sees a fragment and says so. `ArchivedGame` also gains `gaps?: number[]` so a
reader that cares can name where the hole is rather than only that the log
begins late. No `ARCHIVE_FORMAT` bump: an old reader that ignores `gaps`
still reads `from` and still refuses.

The consequence is worth stating plainly, because it turns one of the plan's
softer claims into a load-bearing one. A host that has adopted even once
holds a fragment, and `rankArchives` refuses fragments by design
(`rankings.ts:13`). Run two host peers and the game is still counted: they
share a game id, `rankArchives` counts a game once and names the duplicate
(`rankings.ts:128-132`), and the one that is refused is the one that was
disconnected. **N host peers is redundancy for replayability, not only for
the door.**

## `apps/host`

Thin, as the body says, and thin for the reason the observer is: everything
testable lives below it. `PeerBot` is in `packages/net`, not `apps/bot`, and
the same rule puts `localPair`, `watching` and `hostGame` in packages where
`vitest` already runs. The app is argument parsing, an HTTP server, and
wiring.

```
tessera-host [--plan <file> | --auto <n>] [--wait <secs>]
             [--transport wss|rtc] [--room <name>] [--as <id>]
             [--bind 127.0.0.1] [--port 8080] [--ref <wss://…|tsr-…>]
             [--dir ./archives] [--key <path>] [--ice <urls>] [--quiet]
```

| Flag | wss | rtc |
|---|---|---|
| `--room` | the bus room this host serves; minted if absent | ignored — `--as` is the room code |
| `--as` | the peer id inside the room | the PeerJS id, which is the room code |
| `--port` / `--bind` | the bus and the HTTP surface | HTTP surface only |
| `--ref` | join somebody else's relay instead of serving one | the room code to join |
| `--ice` | ignored, and says so | STUN/TURN, replacing PeerJS's own |

`--ref` and the serving flags are the two modes: with `--ref` the host is a
client of somebody else's room (a second archiver, a replacement waiting to
take over), without it the host serves. It prints what it is serving —
`ws://127.0.0.1:8080/tsr-abc234` and the note that a browser needs `wss://`
in front of it — because a ref nobody can copy is a room nobody can join.

RTC mode is nearly free and worth saying so: `Lobby.open(identity, undefined,
{ id })` is already hosting with no watchdog, `--as` already claims the code,
and `joinGame`'s WebRTC install is already what that mode wants. What RTC
mode does not have is a port, so `--port` there serves only HTTP, which is
correct: a game in a WebRTC mesh still wants a URL its resume point lives at.

## The HTTP surface, stated exactly

```
GET /room/:code/resume    -> resume.json, or 404 before the first snapshot
GET /room/:code/archive   -> the assembled ArchivedGame
GET /room/:code           -> { room, gameId, step, peers, ended }
```

Six things the body leaves open and two implementations would answer
differently:

- **`:code` never becomes a path.** It is looked up in the map of rooms this
  process is a peer in; the archive directory comes from the game id it finds
  there. The alternative — `join(dir, code)` — is a directory traversal in
  the one component of this system that takes a string from a stranger.
  0004's exported `isRoomName` rejects it before the lookup anyway, and both
  checks are worth having.
- **CORS.** `Access-Control-Allow-Origin: *` on all three, because 0008's web
  client fetches them from a page served somewhere else entirely, and because
  every byte here is public and self-verifying. Nothing accepts a POST, so
  there is nothing for a cross-origin write to reach.
- **Caching.** The archive is assembled from disk, and on a multi-day game
  that is megabytes of JSON parsing per request. It is rebuilt at most once
  per flush interval and cached; `ETag` is `steps:updatedAt` from the head,
  and a matching `If-None-Match` gets a 304. A poller costs nothing.
- **A closed relay by default.** `RoomBus` creates a room on first join,
  which would make any host peer an open relay for strangers' traffic. The
  bus is configured to accept joins only for rooms this process is a peer in,
  and answers anything else with `closed`, reason "no game is running here" —
  which is also the honest answer a joiner wants, instead of sitting in an
  empty room forever. `--open-relay` opts back in, knowingly.
- **What is not served.** No move submission, no snapshot upload, no
  identity, no write of any kind. The HTTP surface is three GETs, and the
  reason to enumerate them is that this is the first component in Tessera
  with a URL, and the first thing anyone will try to add to it is an endpoint
  that accepts something.
- **`ws://` stays legal.** Browsers require `wss://`; headless peers, LAN and
  Tailscale do not, and the host binds `127.0.0.1` by default so that putting
  a certificate in front of it is a deployment step rather than a fork.

## What a host peer can do, and what it still cannot

The body's claim is "a host is a client with a job, never a
server-of-truth", and it holds — but a host peer is two things at once and
the honest statement has to separate them.

*As a peer* it is exactly the observer that already exists: no seat, no
checkpoints of its own, no vote, no effect on the abandonment rule (which
counts empires by their silence — `victory.ts:61-63` — and a peer with no
empire is not in the sum) and no effect on the stall machinery (which waits
on seats). Its presence changes no hash. What its presence *does* change is
the room's membership, which is why `checkPlan` had to learn about it.

*As the relay* it inherits 0004's analysis whole, and 0004's one new
capability is sharper here because the relay is no longer a stranger's
server: it can carry every peer but one, and the seats it silences are
proposed for a `Drop` and ejected by quorum. A malicious host peer's power is
denial of play escalating to ejection — never authority, never a forged move,
and never invisible, because the ejection is a quorum-signed record in every
archive of that game.

One property makes serving resume points safe and it is worth the sentence
0005 already wrote: **an observer holds no seat, signs no checkpoints, and
can therefore never be a witness to its own resume point.** The host stores
and serves an artifact that only the players could have produced, and cannot
add itself to the tally at any price.

## Replacement, and what it actually costs

The body says "no data migration, because the archive *is* the migration".
Nearly — the archive is the migration and it needs one instruction, because
the two cases behave differently.

**A live game.** The replacement joins, any peer in the room sends it the
genesis (`lobby.ts:161` — every peer keeps `sealed`, not only the host), and
`start()` sees it more than `RESUME_BEHIND` behind and requests a snapshot
from the present (`lockstep.ts:361`). The resume point is not involved at
all: it describes a step that is minutes old, and 0005's `resume()` refuses a
point behind the simulation anyway. The replacement's own archive is a
fragment from the step it adopted, which is exactly the case the `gaps` work
above makes honest.

**A dormant game.** Nobody is in the room, so there is nothing to catch up
*to*. The replacement fetches `/resume` and `/archive` from the old host or
the address book, runs `verifyResumePoint`, and resumes from a cold start —
which is the case 0005 identified as the only one a witnessed resume point is
actually for.

`tessera-host import <url> <dir>` is the piece the plan needs and does not
name. It fetches the predecessor's archive, verifies it, and lays it out as
this host's own directory, so the successor *continues* one archive instead
of starting a second fragment. It continues it only when there is no hole: if
the fetched log ends at step S and the replacement resumes at step P, then
`S >= P` means `from` stays 0 and the archive still replays, and `S < P`
means the host is honest about the gap and says so on stdout. Silently
stitching across a hole would produce a file that claims to be replayable and
is not, which is the one archive failure this codebase has been careful never
to allow.

The claim the plan should stop making is that replacement is transparent. The
gameId is stable and the room name can be re-claimed, but the *URL changes*:
a room on a relay is `wss://host/room`, and a new host is a new host. Players
holding the old ref have to be told the new one, and the thing that tells
them is 0007. Until 0007 lands, replacement is a manual re-share, and that is
worth writing down rather than discovering.

## Limits and defaults

| Setting | Default | Why that |
|---|---|---|
| bind | `127.0.0.1` | a certificate goes in front; binding public by default is a decision, not a default |
| port | 8080 | one port for the bus and the three GETs |
| relay | closed to rooms this process plays in | an open relay is a different product, and `--open-relay` says so out loud |
| resume poll | the archive flush interval, 10 s (`store.ts:44`) | well inside the four-minute eviction window, and free — it is a `get` that usually returns the same step |
| archive cache | rebuilt at most once per flush | a multi-day log is megabytes of parsing per request otherwise |
| `--wait` | unset | a host that seals a game nobody asked it to seal is worse than one that waits |
| `--auto` | unset | there is no safe default number of players |

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `teams.ts`: `watching` in `Plan`/`HostPlan`, `checkPlan`, `Lobby.host` | yes |
| 2 | `lobby.ts`: `hosting` on `open` | yes — every existing call keeps its behaviour |
| 3 | `roombus.ts`: `localPair`, and the bus's closed-relay option | yes |
| 4 | `lockstep.ts`: `onAdopted`; `archive.ts`: the gap record, `gaps`, `from` | yes |
| 5 | `store.ts`: the head/log mark; `resume.json` and `readResumePoint` | yes |
| 6 | `headless`: `hostGame`, and `joinGame` installing WebRTC only for an rtc ref | yes |
| 7 | `apps/host`: CLI, `ws` upgrade, the three GETs, `--transport rtc` | yes |
| 8 | `tessera-host import` | yes |
| 9 | Docs | yes |

Steps 4 and 5 are the ones to review rather than the ones to write: both
change what an archive says about itself, and one of them changes an archive
from "counted" to "refused" for a peer that used to be counted wrongly.

## Docs

| File | Change |
|---|---|
| `docs/clients/host-peer.md` | new: the two transports, the three GETs, the two composition modes, what replacement costs |
| `docs/clients/README.md` | a fourth client beside the web client, bot and observer |
| `docs/clients/observer.md` | the observer and the host peer are the same peer with different jobs; when to run which |
| `docs/clients/headless-peers.md` | `hostGame` beside `joinGame`; WebRTC is loaded for an rtc ref and not otherwise |
| `docs/mesh/room-bus.md` | 0004's page: the closed-relay default, and `localPair` as the in-process client |
| `docs/mesh/the-lobby.md` | `hosting` — a socket room can be hosted, by the peer that is serving it |
| `docs/continuity/resume.md` | a resume point is served from a file, not from a driver, and why four minutes is the reason |
| `docs/trust-and-verification/archives.md` | `gaps`: an archive that adopted a snapshot is a fragment and says so; two hosts are how a game stays countable |
| `docs/trust-and-verification/trust-model.md` | the host peer row: relay plus peer, and the ejection power that combination has |

The archives page is the one that changes a verdict rather than adding a
paragraph. Until now "an observer's archive verifies" has been true because
observers rarely adopted anything; on a socket, over days, they will.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| a plan whose composer is unseated is accepted; one that seats a stranger is not | `packages/net/src/test/teams.test.ts` |
| a key both seated and watching is refused | the same file |
| `hosting: true` arms no watchdog and leaves the ref alone | `packages/net/src/test/lobby.test.ts` |
| a `localPair` client joins, is stamped, and is routed to like any other | `packages/net/src/test/roombus.test.ts` |
| a join for a room the host does not play in is `closed`, not created | the same file |
| **head and log agree when the archive is read mid-flush** | `packages/headless/src/test/store.test.ts`: pump between flushes, read with `readArchive`, `verifyArchive` clean |
| **an archive whose driver adopted a snapshot reports a gap and is refused** | the same file — and it passes wrongly on today's tree, which is the point of writing it |
| two archives of one game, one gapped: the game is still counted once | `packages/net/src/test/rankings.test.ts` |
| a resume point survives four minutes of an empty room | `packages/headless/src/test/store.test.ts`: witness, flush, advance past eviction, `readResumePoint` still returns it |
| a persisted resume point passes `verifyResumePoint` against the genesis | the same file |
| a headless host composes a game a browser join accepts | a `hostGame` test with two loopback peers and `inspectGenesis` |
| `--auto` seals at n, `--wait` seals early with two, neither seals with one | the same file |
| a host peer's presence changes no hash and no roster | the harness: run the convergence suite with and without an extra seatless peer, compare `hash()` |
| the three GETs, including `:code` that is not a room name | `apps/host` smoke test over `localPair` and an ephemeral port |
| the archive served over HTTP passes `verifyArchive` | the same test, end to end |
| nothing moved the hash | `pnpm test`; `packages/sim` and `packages/protocol` are not in the diff |

The three bold rows are the ones that decide whether this plan is 1–2
sessions. Everything else is wiring an app around parts that exist; those are
the parts where the archive a host writes for three days is either checkable
by a stranger or quietly is not.

## What this plan does not settle

**Vacancies.** `--plan` with seats for keys that have not arrived is refused
by `checkPlan` as "a stranger is seated", so the composition mode the body
calls the reason a headless-hosted game is worth announcing does not exist
until 0010. What lands here is the `watching` seam, which is the same check
from the other side.

**The draft broadcast.** "Once 0009 lands the host also broadcasts its plan
as a draft while it waits" — nothing here does that, and a `--plan` host is
opaque until it seals.

**The managed factory.** Spinning up a host on demand is an operational
product; what this plan owes it is that a self-hosted host and a managed one
are the same artifact with the same flags, which they are.

**Discovery.** Nothing here tells anyone that a host peer exists. The ref is
printed on stdout and shared by hand. 0007.

**Two hosts, one door.** N host peers each serve their own URL, so redundancy
for the archive is automatic and redundancy for the *door* is not: a second
door is a second ref somebody has to hold. Making one name resolve to
whichever host is up is the address book's job, and it is the last thing
standing between "a game that survives its host" and "a game whose players do
not have to know that it did".
