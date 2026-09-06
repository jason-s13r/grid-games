# 0004 — The WSS transport: client, room-bus contract, tests

Status: draft
Depends on: 0003 (the `socket` branch of `ConnectionRef`)
Branch: `wss-transport`

## The problem

0003 left the socket branch of the lobby throwing. This plan builds the whole
socket path: a client transport in `packages/net`, the wire contract of the
server it talks to, and the tests that prove drivers converge across it. The
server itself ships with the host peer (0006); what ships here is the
*contract*, so any implementation — host peer, a stand-alone process, someone
else's — is interchangeable.

The precedent is already in the tree: `LoopbackNetwork` is a transport that is
not WebRTC, and the six-driver harness runs whole games over it. This is the
same shape with the in-memory switch replaced by a server process.

## The room-bus contract

A room server holds `room → set of connections` and routes bytes. It parses
**only** its own envelope — never a game frame:

```
client → server
  { op: "join", room: string, id?: string }        // id is a request, not a right
  { op: "frame", to?: string, d: string }          // d is the encoded frame text

server → client
  { op: "welcome", id: string, peers: string[] }   // id is assigned or granted
  { op: "frame", from: string, d: string }
  { op: "peers", ids: string[] }                   // roster gossip, replaces mesh.ts's k:"p"
  { op: "closed", reason?: string }
```

Properties the client relies on:

- **No self-echo.** A broadcast never comes back to its sender. (`LocalHub`
  adds loopback as an explicit special case; its absence is the norm every
  driver is written against.)
- **`from` is server-attested.** A client cannot spoof another's id; the
  server stamps the sender's connection id.
- Frames are the JSON text `encodeFrame` already produces — the same bytes
  PeerMesh would carry inside its `k:"f"` envelope. No second framing.
- No chunking. WebSockets carry large messages whole; PeerMesh's 15 kB
  slicing (`mesh.ts:82`) is a data-channel constraint, not a protocol one.
- Oversized-snapshot note: a 160×112 snapshot is ~170 kB base64; well inside
  what a `ws` message carries. A cap (~1 MB) with a clear error is worth
  having; slicing is not.

The server keeps no game state, parses no frames, and has no game
dependencies. Abuse surface: pushing bytes into fake rooms — bounded by a
per-connection rate limit, harming nobody but bandwidth. The relay can drop,
delay or reorder; it cannot forge (every move is signature-verified per peer)
— the same property the mesh header grants a TURN relay.

## The client

New `packages/net/src/socket.ts`, `SocketTransport implements Transport`
(plus `close()`), wired into `Lobby.open`'s `socket` branch:

- one WebSocket per room; `id` from `welcome`; `peers()` from the last
  `peers` roster; `broadcast` = `op:"frame"` with no `to`; `send` = with `to`;
  `listen` = incoming `op:"frame"` events.
- Reconnect with backoff, resending nothing: the lobby's watchdog and the
  driver's stall machinery are the recovery paths, and both already exist.
- `close()` closes the socket; the lobby's `Transport & { close(): void }`
  widening (0003) is what makes that callable.

## Verification

- `packages/net/src/test/socket.test.ts` — a pair of in-memory fake sockets
  wired through a reference room bus (~40 lines, lives beside the test)
  satisfies the contract: delivery, no self-echo, `from` attestation,
  roster gossip, a `to` that does not exist is dropped not crashed.
- The harness gains a socket-backed network option; the existing six-driver
  convergence suite runs over it unchanged. Frames deliberately reordered
  across senders still converge (`Sim.advance` sorts by `(empire, member,
  seq)`; `inputDelay` absorbs star-topology jitter).
- A relay that silently drops one seat's frames ends in the existing
  quorum-signed `Drop` — the recovery path is the same one a silenced seat
  already exercises. This test is the plan's core claim, stated as code.
- A snapshot frame larger than any data channel would allow crosses whole.

---

# Implementing it

## What ships, and the sentence in the body the code does not support

Four files, one of which is a test double and one of which the body puts in
the wrong place:

| File | What it is |
|---|---|
| `packages/net/src/socket.ts` | `SocketTransport`, the client |
| `packages/net/src/roombus.ts` | the contract as running code — see below |
| `packages/net/src/test/fakesocket.ts` | fake sockets with explicit delivery |
| four test files | the contract, the client, convergence, the gap |

Everything else is edits: `connect.ts` grows a socket branch, the harness
grows a transport option, and the docs grow a page.

The line that does not hold is this one:

> Reconnect with backoff, resending nothing: the lobby's watchdog and the
> driver's stall machinery are the recovery paths, and both already exist.

Both exist. Neither recovers a reconnecting peer.

The watchdog is gone by then: it is armed only for a joiner
(`lobby.ts:110-118`) and cleared by the first `welcome`, by `fail`, and by
`adopt` — so from the moment a game starts there is no watchdog at all. The
stall machinery does run, and what it does to a peer that has been silent for
`stallTimeout` is propose a quorum-signed `Drop` against its seat
(`lockstep.ts:808-822`). That is a recovery for *the game*. For the peer that
blinked it is an ejection.

Between those two is a worse case, and it is the reason this appendix exists.
It is worked through under **The gap** below. The short version: a socket that
drops mid-`submit` loses a `MOVE` while `repeatReady` faithfully re-sends the
`READY` that promised it, everyone else simulates the step without the move,
the sender simulates it with, and the sender is now the minority in a
disagreement it will never repair on its own.

So the plan needs one thing the body does not list — an outbound buffer held
across the gap — and one thing that is a pre-existing hole this plan is the
first to make routine: nothing outside `apps/web` ever calls
`requestSnapshot` in response to a desync.

## The envelope, with three fields the contract is missing

The body's four ops are right. What is missing is that this is a **wire
format about to be frozen**: 0006 implements a server against it, and after
that any change is a compatibility event. Three additions, all cheap now and
none cheap later.

```ts
/** The room-bus envelope. Bumped when a server and a client can no longer
 *  understand each other — which is a different question from whether two
 *  peers can play the same game (that is PROTOCOL_VERSION, 0001) and moves
 *  on a different clock. A room bus carries frames it does not parse, so it
 *  can outlive several game protocols without changing at all. */
export const BUS_VERSION = 1;

type Up =
  | { op: "join"; v: number; room: string; id?: string }
  | { op: "frame"; to?: string; d: string }
  | { op: "ping" };

type Down =
  | { op: "welcome"; id: string; peers: string[] }
  | { op: "frame"; from: string; d: string }
  | { op: "peers"; ids: string[] }
  | { op: "closed"; reason?: string }
  | { op: "pong" };
```

**`v` on the join.** Without it the first incompatible change is discovered as
frames that arrive and mean nothing. With it, a server that does not speak a
client's version answers `closed` with a sentence, which is the difference
between "the relay is broken" and "update your tab".

**`ping` / `pong`.** A WebSocket through a proxy dies silently after roughly
a minute of idle, and the client cannot tell a dead socket from a quiet room.
Seated peers are never quiet for long — `beat()` broadcasts a `HEARTBEAT`
move every 30 s — but an **observer sends nothing at all**, and an observer
that never notices its socket died is 0006's host peer failing to be a door.
A browser cannot send protocol-level WebSocket pings from JavaScript, so the
keepalive has to be in the envelope. Client sends `ping` after 25 s of
silence; no traffic at all for 60 s means the socket is dead, close it and
redial.

**The roster lists everyone, including the recipient.** The body leaves this
open, and it is exactly the kind of ambiguity two implementations resolve
differently. Fixing it as *the full room, self included* means `peers` is one
message broadcast to the room rather than one tailored per recipient, makes
it idempotent, and puts the filtering in the one place that knows which id it
holds. `welcome.peers` follows the same rule for the same reason.

## `packages/net/src/socket.ts`

```ts
// A room on a relay: the other thing a ConnectionRef can name.
//
// The relay is fanout and nothing else. It holds room -> sockets, stamps the
// sender's id on what it forwards, and never parses a game frame — the frame
// crosses as the JSON text encodeFrame already produced, carried as a string
// inside the envelope rather than nested as an object, so that parsing the
// envelope cannot become parsing the game. On a snapshot, which is base64url
// and therefore escapes to itself, that costs about a dozen bytes.
//
// It holds no authority, exactly as a TURN relay holds none: every move is
// signed and every state is hash-verified, so a relay can drop, delay and
// reorder and cannot forge or alter. What it can do that a TURN relay cannot
// is silence one seat while carrying the rest — see the plan body, and the
// test that proves where that ends up.

/** Just enough WebSocket to talk to one. Named rather than imported so a
 *  test can pass a fake, which is the same reason mesh.ts names
 *  PeerConstructor rather than importing Peer. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type SocketConstructor = new (url: string) => SocketLike;

const OPEN = 1;

/** Six times the largest thing the game sends. A 160x112 snapshot is around
 *  170 kB of base64 (`mesh.ts:80`), and a WebSocket carries it whole — the
 *  15 kB slicing in the mesh is a data-channel limit, not a protocol one. */
const MAX_MESSAGE = 1_000_000;

/** Frames written while the socket was down. Bounded, and an overflow is a
 *  failure rather than a truncation: dropping the oldest held frame is
 *  precisely the reordering this buffer exists to prevent. */
const MAX_HELD = 2_000_000;

const IDLE_PING_MS = 25_000;
const DEAD_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export class SocketTransport implements Connection {
  /** Resolves on the first `welcome`, rejects if none arrives — the same
   *  contract `createMesh` has with the broker, for the same reason: until
   *  the server has named us there is no id to be a peer under. */
  readonly opening: Promise<string>;

  private socket?: SocketLike;
  private assigned = "";
  /** Everyone else in the room. Empty while the socket is down, which is the
   *  truth and is what stops `resuming()` asking nobody for a snapshot. */
  private roster: string[] = [];
  private readonly handlers: FrameHandler[] = [];
  private readonly backlog: Array<{ from: string; frame: Frame }> = [];
  private held: string[] = [];
  private heldBytes = 0;
  private shut = false;
  private attempt = 0;

  get id(): string {
    return this.assigned;
  }

  peers(): readonly string[] {
    return this.live ? this.roster : [];
  }

  broadcast(frame: Frame): void {
    this.write({ op: "frame", d: encodeFrame(frame) });
  }

  send(to: string, frame: Frame): void {
    this.write({ op: "frame", to, d: encodeFrame(frame) });
  }

  // listen() and the backlog are PeerMesh's, verbatim in shape and for the
  // same reason: the connection is open before the lobby exists, and the
  // genesis record arrives on the same channel as everything after it.

  close(): void {
    this.shut = true;   // before the socket, so onclose does not redial
    this.stopTimers();
    this.socket?.close();
  }

  private write(message: Up): void {
    const text = JSON.stringify(message);
    if (text.length > MAX_MESSAGE) {
      this.options.onError?.(new Error("that frame is too large to send."));
      return;
    }
    if (this.live) {
      this.socket!.send(text);
      return;
    }
    this.held.push(text);
    this.heldBytes += text.length;
    if (this.heldBytes > MAX_HELD) {
      this.giveUp("the connection has been down too long.");
    }
  }
```

`dial` and `receive` are the rest of it:

```ts
  private dial(): void {
    if (this.shut) return;
    const Socket =
      this.options.socket ?? (globalThis.WebSocket as unknown as SocketConstructor);
    const socket = (this.socket = new Socket(this.ref.url));

    socket.onopen = () => {
      // The id we already hold, not the one we were configured with: coming
      // back as ourselves means the room sees a reconnection rather than a
      // departure and a stranger, and the held frames land under the name
      // that promised them.
      const want = this.assigned || this.options.id;
      socket.send(
        JSON.stringify({
          op: "join",
          v: BUS_VERSION,
          room: this.ref.room,
          ...(want ? { id: want } : {}),
        } satisfies Up),
      );
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.redial();
    socket.onerror = () => {};   // a close always follows; one report is enough
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: Down;
    try {
      message = JSON.parse(data) as Down;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    this.lastHeard = this.now();

    switch (message.op) {
      case "welcome": {
        if (typeof message.id !== "string") return;
        const first = this.assigned === "";
        // Whatever we asked for, this is what we got. A requested id is a
        // request on both transports and a right on neither.
        this.assigned = message.id;
        this.attempt = 0;
        this.setRoster(message.peers);
        this.flushHeld();
        if (first) this.opened(message.id);
        else this.options.onReconnect?.();
        return;
      }
      case "peers":
        return this.setRoster(message.ids);
      case "frame": {
        const { from, d } = message;
        if (typeof from !== "string" || typeof d !== "string") return;
        const frame = decodeFrame(d);
        if (frame) this.deliver(from, frame);
        return;
      }
      case "closed":
        // Deliberate, so it is not redialled. A server that means "go away"
        // and a socket that merely fell over are different events.
        this.giveUp(said(message.reason));
        return;
      case "pong":
        return;
    }
  }

  /** Joins and departures, derived rather than announced. A room bus tells
   *  everyone who is in the room; the mesh's onJoin/onLeave are what the
   *  lobby is written against, so the difference between two rosters is
   *  where they come from. It is also self-healing: a roster arriving after
   *  an outage produces exactly the joins and leaves that happened during
   *  it, without the server having to remember what we missed. */
  private setRoster(ids: unknown): void {
    if (!Array.isArray(ids)) return;
    const next = ids.filter(
      (id): id is string => typeof id === "string" && id !== this.assigned,
    );
    const before = new Set(this.roster);
    this.roster = next;
    for (const id of next) if (!before.delete(id)) this.options.onJoin?.(id);
    for (const id of before) this.options.onLeave?.(id);
  }
```

`redial` is exponential backoff with jitter, capped at `MAX_BACKOFF_MS`, and
returns immediately when `shut`. The keepalive timer is one repeating
`setTimeout` chain rather than a `setInterval`, unref'd where `unref` exists,
so a headless peer's process is not held open by its own heartbeat.

`ConnectOptions` (0003) gains one field:

```ts
/** The socket came back. Never fired by the rtc branch — a data channel
 *  does not reconnect, the peer is simply gone. */
onReconnect?: () => void;
```

## The gap: what a socket has that a data channel never did

A data channel is reliable and ordered, and when it stops being either it is
gone and so is the peer. A WebSocket has a third state — *back, having missed
things* — and every one of the driver's recovery paths was written when that
state did not exist. Worked through, because the conclusion is not obvious:

1. A seat submits. `submit` holds `readyCeiling` below the move's slot, signs,
   stashes the move locally, broadcasts it, and in the `finally` announces
   readiness up to the slot (`lockstep.ts:461-491`).
2. The socket is down for 900 ms across that broadcast. Both writes go
   nowhere: a `WebSocket` in `CLOSING` or `CLOSED` discards silently.
3. Everyone else blocks — each peer waits on every seat's readiness, so the
   whole game freezes rather than moving on. This is the part that saves it,
   and it is why an outage shorter than `stallTimeout` (15 s) costs nothing
   *if the frames survive it*.
4. The socket comes back. The peer is blocked, so `repeatReady` re-sends the
   standing promise (`lockstep.ts:567-572`) — but nothing re-sends a move.
   `announceReady` will not re-announce a promise it has already made, and
   `repeatReady` is deliberately the one thing that repeats.
5. So the room now has the promise without the move. Everyone unblocks and
   simulates the slot without it; the sender simulates it with. One
   divergence, permanent.
6. At the next checkpoint (5 s) the sender is the minority of one. It does
   not accuse — `compare` is deliberately asymmetric (`lockstep.ts:735-770`)
   — and the majority starts counting. At three disagreeing checkpoints plus
   proposer rank, roughly 20 s, its seat is dropped by quorum.

Step 2 is the whole fault, and **the outbound buffer is the whole fix**: held
frames go out in order the moment `welcome` lands, before anything else is
written, and the game resumes as though it had merely been slow. Everything
after step 3 stops happening. This is why the buffer's overflow is a failure
rather than a drop-oldest — a truncated buffer reproduces exactly the bug it
was added to prevent, and does it silently.

There is a second half, which is not new but which this plan is the first to
make routine. Grep for what repairs a desync:

```
apps/web/src/game/Online.ts:36
  lockstep.onDesync = (step) => { …; lockstep.requestSnapshot(step); }
```

That is the only caller in the repository. `Lockstep` never asks for a
snapshot on a desync of its own accord — the paths at `lockstep.ts:964` and
`:1117` are a late amendment and a late ejection, and the one at `:361` runs
in `start()` alone. So:

- A **browser** peer repairs within a step or two, and the drop never
  carries. `docs/continuity/desync.md` names the client as the thing that
  calls `requestSnapshot`, which is exact. `docs/continuity/resume.md:28-29`
  pairs that with `eject`'s own call (`lockstep.ts:1117`) under one "both
  call `requestSnapshot()`", on a page about the driver — accurate about what
  happens, silent about only one of the two being the driver's.
- A **headless seat** (`packages/headless/src/peer.ts:112-119` sets no
  `onDesync`) never repairs, and is dropped on schedule.
- A **headless observer** never repairs *and is never dropped* — it holds no
  seat, so it broadcasts no checkpoints, so no peer can even see that it
  disagrees. It keeps archiving. Its archive is self-consistent, so
  `verifyArchive` replays it clean and returns `VERIFIED` for a game that did
  not happen. Nothing catches this except comparing it with another
  observer's, which `rankArchives` does not do — it counts a game once
  however many archives exist.

0006's host peer is precisely a headless observer on a socket, archiving for
days. So the third bullet is not hypothetical, it is the deliverable.

The fix is small and belongs here, in two lines each at the two places that
build a driver and already hold both objects:

```ts
// packages/headless/src/peer.ts, beside the existing hooks
driver.onDesync = (step) => driver.requestSnapshot(step);
connection.onReconnect = () => driver.requestSnapshot();
```

`requestSnapshot` is idempotent enough for this: a peer that is not behind
gets a snapshot it ignores (`onSnapshot` discards one that is not ahead
unless it asked and is still inside `snapshotWantedUntil`), and the request
is one small broadcast. The same two lines go in `apps/web/src/main.ts`
beside `Online.ts`'s existing handler, or `Online.ts` grows the reconnect
half.

The tempting alternative — move the `behind > RESUME_BEHIND` test out of
`start()` and into `pump()`, so any peer that finds itself two seconds behind
the world rebuilds — is the better fix and the wrong plan. It is consensus
code, every convergence test in the suite is downstream of it, and it would
be the only change in this series that touches how the driver decides
anything. Name it as a candidate for its own change and leave it.

## `packages/net/src/roombus.ts`, which is not a test file

The body puts the reference bus "beside the test (~40 lines)". 0006 then says
its in-process relay is "the fanout logic is the reference bus from 0004's
tests, unchanged". Those cannot both be true: `apps/host` cannot import a
file under `packages/net/src/test`.

It ships in the package, with `LoopbackNetwork` as the precedent — that is
also test infrastructure, it also lives in `src` rather than `src/test`, and
it is also exported, because a thing that defines a contract by implementing
it is part of the contract.

It is written against an abstract socket so that 0006 wraps `ws` around it
and the tests wrap a fake around it, and neither is the reference
implementation's business:

```ts
/** One connected client, from the bus's side. `ws` satisfies this; so does
 *  the test's fake. The bus never learns which. */
export interface BusSocket {
  send(text: string): void;
  close(): void;
}

export interface BusLimits {
  /** Sockets in one room. Observers are unlimited by design, so this is an
   *  abuse ceiling rather than a rule about who may watch. */
  peers?: number;      // 64
  rooms?: number;      // 1024
  message?: number;    // MAX_MESSAGE
  /** Envelopes per second, per socket, sustained. */
  rate?: number;       // 64, burst 256
}

export class RoomBus {
  /** One inbound message from a socket that has not been dropped. */
  deliver(socket: BusSocket, raw: string): void;
  /** That socket went away, for any reason. */
  gone(socket: BusSocket): void;
  /** For a host that wants to say what it is holding. */
  rooms(): ReadonlyMap<string, readonly string[]>;
}
```

What it enforces, each of which is a test:

| Rule | Because |
|---|---|
| `join` first, exactly once | a frame from a socket in no room has no `from` to stamp |
| `v` must equal `BUS_VERSION` | `closed`, with a sentence |
| `room` must match 0003's charset | a relay that accepts `../` or a newline as a room name has a path traversal in whatever it logs |
| requested `id` granted only if free | two sockets under one id is a driver addressing both and neither |
| an id that is taken is replaced, not refused | ids carry no authority, and `welcome.id` is already the truth; a refusal would be a failure path for nothing |
| `from` is stamped, never read from the client | the one property the client relies on |
| never echo to the sender | every driver is written against its absence |
| unknown `to` is dropped | a peer that left mid-frame is ordinary |
| over `message` bytes, or over `rate` | `closed`, and not redialled |

The last two rows are the whole abuse surface: bytes into rooms nobody is
listening to, bounded by the rate limit, harming nothing but bandwidth. There
is no game state to corrupt because the bus has none, and no frame to alter
because it never parses one.

## Two small amendments to 0003's `ref.ts`

The bus needs the charset 0003 defined and the id generator `mesh.ts` keeps
private. Both should be exported from `ref.ts` rather than duplicated:

```ts
export const isRoomName = (text: string): boolean => NAME.test(text);
/** The generator behind a room code. Moved here from mesh.ts:91 so the
 *  charset and the thing that draws from it are in one file. */
export function mintName(prefix = ""): string;
```

`mesh.ts:91-97` becomes a call to `mintName`, which is a strict subtraction.
This is the point at which 0003's "one charset for both transports" stops
being a claim in a document and becomes a shared constant.

## Wiring: `connect.ts`, and what the lobby does not need

0003 left one line:

```ts
if (ref?.kind === "socket") throw new Error("socket rooms are not built yet");
```

It becomes:

```ts
if (ref?.kind === "socket") return openSocket(ref, options);
```

and `openSocket` is `socket.ts`'s `createMesh` — construct, await `opening`,
close on rejection so a failed open does not leave a redial loop running.

The lobby needs **nothing**. Not a line. `Lobby.open` already takes a
`ConnectionRef`, already calls an `Opener`, already stores a `Connection`,
and its `onError` is already one sentence-forwarding line — 0003 did all of
that, and this is the plan that shows whether it was done right. The one
place to look afterwards is the watchdog message at `lobby.ts:113-116`, which
0003 changed to interpolate `this.shareable`: for a socket ref it now reads
"no answer from wss://relay.example/tessera/abc234", which is correct and is
the truth about an empty room.

Two behaviours are worth knowing rather than changing:

- A socket ref always produces `phase = "waiting"`, so a browser can join a
  socket room and never host one. That is 0003's stated shape and 0006's
  question, and it is also correct for this plan: there is nobody to compose
  a genesis in an empty socket room, and inventing one here would be
  inventing the host peer badly.
- A room with a persistent host peer in it has a member with no seat, and
  `checkPlan` refuses a plan where "somebody here has no seat"
  (`teams.ts:82`). Nothing in 0004 hits this, because 0004 never hosts over a
  socket. 0006 hits it on its first day.

## The harness, socket-backed

The body's claim — "the existing six-driver convergence suite runs over it
unchanged" — is worth honouring literally, because a socket suite that is a
separate hand-written scenario proves much less than the real one re-run.

`fakesocket.ts` is `fakepeer.ts`'s sibling and `LoopbackNetwork`'s in
discipline: **nothing arrives until `flush()`**. A `SocketWorld` owns a
`RoomBus`, hands out `FakeSocket`s that queue both directions, and delivers a
generation per flush, so the interleaving is a test's to control and never a
timer's. The real `SocketTransport` and the real `RoomBus` sit in the middle
of it; the only fake thing is the wire.

`harness.ts` changes in four places:

| Where | Change |
|---|---|
| `TableOptions` | `transport?: "loopback" \| "socket"` |
| `Table` | `bus?: SocketWorld` |
| `wire()` | returns a socket connection when asked; becomes async |
| `settleNetwork` | `idle = t.net.flush() + (t.bus?.flush() ?? 0) === 0 ? …` |

`wire` becoming async makes `build` async, which turns the two `forEach`
loops at the end of `table()` into `for…of` with an `await`. `Table.net`
stays a `LoopbackNetwork` and stays exactly as it is — flushing an empty
queue costs nothing, and the five test files that reach for
`t.net.connect(…)` (`resume`, `amendment`, `forgery`, `equivocation`,
`stalls`) keep compiling and keep running on loopback, which is what they are
about. No existing test file changes.

## What a relay can do, stated exactly

Unchanged from the mesh, and it is most of what matters: content-addressed
genesis, per-peer signature verification, hash-checked state. A relay cannot
forge a move, alter one, seat anybody, or read a team line. `mesh.ts`'s TURN
argument transfers whole.

One capability is genuinely new, and the body's own core test is where it
lands. A TURN relay carries one pair; a room bus carries everybody, and can
therefore **silence one seat while carrying the rest**. What happens next is
that the honest majority stops hearing that seat, the stall machinery
proposes a `Drop`, a quorum endorses it, and the player is out of the game.
So a hostile relay's power is denial of play escalating to ejection — never
authority, and never invisible: the ejection is a quorum-signed record in
every archive of that game, naming the step and the reason. The test the body
calls its core claim proves the recovery path; the honest reading of the same
test is that it also demonstrates the attack.

Two smaller ones, worth writing down where 0007 and 0008 will read them:

- A relay sees who talks to whom and when, for every peer in the room at
  once. The mesh's broker sees only introductions.
- The ref names a server of the sender's choosing, so opening one reveals an
  IP and a timing pattern to whoever runs it. 0003 already made the argument
  that a join box must show the full host; a room bus is why.

## Limits, with numbers

| Limit | Value | Why that |
|---|---|---|
| envelope | 1 MB | ~6x the largest snapshot the game sends (`mesh.ts:80`) |
| held while down | 2 MB | one snapshot answer plus a game's worth of moves |
| room name | 0003's `NAME` | 64 chars of `[A-Za-z0-9_-]`, already a safe path segment |
| peers per room | 64 | 24 seats is the game's ceiling; the rest is observers |
| rooms per bus | 1024 | a number a host peer operator can raise knowingly |
| rate | 64/s, burst 256 | a snapshot answer to three joiners at once must not trip it |
| keepalive | ping at 25 s idle, dead at 60 s | under every proxy idle timeout worth naming |
| backoff | 500 ms doubling to 30 s, jittered | a relay restarting must not be met by every client at once |

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `ref.ts`: export `isRoomName`, move `mintName` out of `mesh.ts` | yes |
| 2 | `roombus.ts` + `test/roombus.test.ts` | yes — nothing imports it yet |
| 3 | `test/fakesocket.ts` | with step 4 |
| 4 | `socket.ts` + `test/socket.test.ts` | yes |
| 5 | `connect.ts`: the socket branch replaces the throw | yes |
| 6 | `ConnectOptions.onReconnect`; the two `requestSnapshot` wirings | yes |
| 7 | `harness.ts` transport option + the socket convergence run | yes |
| 8 | `test/gap.test.ts` — the outage that used to cost a seat | yes |
| 9 | Docs | yes |

Step 6 is the one to review carefully rather than the one to write carefully:
it changes what a headless peer does when it disagrees, and that is a
behaviour nobody has been able to observe until now.

## Docs

| File | Change |
|---|---|
| `docs/mesh/room-bus.md` | new: the envelope, the rules, the limits, what a relay can do. This is the page an independent server implementation is written from |
| `docs/mesh/socket-transport.md` | new, short: `SocketTransport`, the outbound buffer, the reconnect, the derived roster |
| `docs/mesh/transport-interface.md` | a fifth row in the implementations table |
| `docs/mesh/README.md` | two links, and the shape diagram gains the socket case beside the mesh |
| `docs/mesh/connection-refs.md` | 0003's page: the socket branch is no longer "not built yet" |
| `docs/continuity/desync.md` | it already names the client rather than the driver; say *which* clients, and that after this plan it is all of them |
| `docs/continuity/resume.md:28-29` | separate the two: `eject` is the driver's own call, the desync rebuild is the client's. Add reconnect as a third reason to rebuild |
| `docs/clients/observer.md` | a socket ref needs no `--ice` and loads no native WebRTC |
| `docs/README.md:4` | "form a WebRTC mesh with no authoritative server" — still true, now one of two shapes |

The resume edit is not bookkeeping. The page pairs a call the driver makes
with one only the web client makes, and the distinction has never mattered
because browsers were the only peers that ever desynced. After this plan they
are not.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| the bus routes, and never to the sender | `test/roombus.test.ts` |
| `from` is the server's, not the client's | the same file: a client sends `{op:"frame", from:"someone-else", d}` and every recipient sees its real id |
| roster gossip on join and on leave | the same file, both directions |
| an unknown `to` is dropped, not a crash | the same file |
| a bad version, a bad room name, an oversized envelope, a flood | the same file — four `closed` reasons, four sentences |
| a taken id is replaced and `welcome.id` says so | the same file |
| the client opens, ids itself, and lists peers minus itself | `test/socket.test.ts` |
| frames arriving before `listen` are replayed | the same file — PeerMesh's backlog property, re-proved |
| `close()` stops the redial loop; `closed` does not redial | the same file |
| six drivers converge over a socket | `harness` with `transport: "socket"`, running the existing convergence suite |
| a snapshot too large for a data channel crosses whole | the same run, with `snapshotInterval` forcing one |
| frames deliberately reordered across senders still converge | the same run — `Sim.advance` sorts by `(empire, member, seq)` |
| a relay that silences one seat ends in a quorum-signed `Drop` | `test/socket.test.ts` or its own file; the body's core claim |
| **an outage across a `submit` costs no seat** | `test/gap.test.ts`: drop the socket mid-submit, restore it, assert the table still `agreed()` and no ejection was recorded |
| **a headless peer that desyncs rebuilds** | the same file, with the step 6 wiring — and it fails on today's tree, which is the point of writing it |
| nothing moved the hash | `pnpm test` unchanged; `packages/sim` and `packages/protocol` are not in the diff |

The two bold rows are the ones that justify the plan being 1–2 sessions
rather than one. Everything above them is a transport; those two are the
reason a transport with gaps in it is safe to put a multi-day game on.

## What this plan does not settle

**Who composes a game in a socket room.** Unchanged from 0003's closing
section, and now reachable rather than theoretical: a browser with a socket
ref sits in `waiting` forever if nothing else is in the room. 0006.

**TLS.** Browsers require `wss://`, which requires a certificate, which is a
deployment question this plan deliberately does not have an opinion about
beyond leaving `ws://` legal for localhost and headless peers.

**Finding a relay.** Nothing here tells a player which relay to use; a ref
arrives by being pasted. 0007.

**Two version lines.** `BUS_VERSION` and `SUPPORTED_PROTOCOLS` (0001) now
both exist and are independent — a relay can carry games it could not
possibly understand, which is the point, and a client can meet a relay it
cannot speak to while playing a game it can. Neither should ever be checked
against the other.

**An archive nobody cross-checks.** The observer case under **The gap** is
mitigated here, not closed: a self-consistent divergent archive still
verifies clean, because `ArchivedGame` carries no checkpoints from anyone
else. 0005's resume points are a stranger-checkable statement about a game's
state, and are where this properly gets fixed.
