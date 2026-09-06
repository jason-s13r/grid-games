# 0003 — The connection reference: a transport chosen by the string you join with

Status: draft
Depends on: nothing
Branch: `transport-ref`

## The problem

Joining is hard-wired to PeerJS. `Lobby.open(identity, join?: string)` builds a
`PeerMesh` and nothing else (`packages/net/src/lobby.ts:124`); the room code is
the host's PeerJS id (`lobby.ts:105`). Before any other transport can exist,
the lobby has to stop caring which one it opens.

The decision should be data, not a settings screen: the string a player types
(or the listing row they click) already says what kind of connection it is.
This plan introduces that type and rewires the lobby's single construction
site. No second transport is built here — 0004 fills the socket branch in.

## The type

New `packages/net/src/ref.ts`, exported from `index.ts`:

```ts
export type ConnectionRef =
  | { kind: "socket"; url: string; room: string }   // wss://foo.example/tessera/<room>
  | { kind: "rtc"; code: string };                  // tsr-…  (a PeerJS room code)

export function parseRef(input: string): ConnectionRef;
```

Parsing rules, in order:

- starts with `ws://` or `wss://` → `socket`; the last path segment is the
  room, the rest is the URL. A URL with no path segments is an error.
- starts with `tsr-` → `rtc` with that code verbatim (never normalised: the
  broker minted it, and minting is the broker's job).
- anything else → an error naming what a valid reference looks like. The
  client shows it where the join box is; no silent guessing.

Two transports, one rule: **the ref is the toggle.** No `probeIce`, no runtime
fallback ladder, no `?transport=` parameter. A player who wants the other
transport joins the other string — which is also how a room advertises both
(a listing row can carry two refs).

## Lobby changes

`Lobby.open` gains a variant instead of a string:

```ts
static async open(identity: Identity, ref: ConnectionRef, options?): Promise<Lobby>;
```

- `rtc` → today's `createMesh` path unchanged (`lobby.ts:124-150`), including
  the `id` option (the observer's `--as` still mints its requested peer id).
- `socket` → `new SocketTransport(ref)` from 0004 (until then, `open` throws
  "socket transport not built yet" — the seam exists, the other side is a
  later plan).

What survives verbatim: the HELLO/WELCOME handshake, the backlog, the
watchdog, `baseTransport()` — all of it is already transport-neutral. The
`onJoin` / `onLeave` / `onError` wiring moves behind a small interface
(`{ onJoin, onLeave, onError, close }`) both transports satisfy, so the lobby
keeps one code path.

Two concrete widenings:

- `Lobby.mesh: PeerMesh` → `mesh: Transport & { close(): void }` (the field is
  only read for `id`/`peers()`/`send`/`broadcast` and closed).
- `OnlineGame` takes `mesh: PeerMesh` but calls only `peers().length`
  (`apps/web/src/game/Online.ts`) — widen to `Transport`.

`main.ts` passes `lobby.mesh` (`apps/web/src/main.ts:525`); that keeps
compiling under the wider type unchanged.

## Headless

`JoinOptions.code: string` (`packages/headless/src/peer.ts:35`) becomes
`ref: string` parsed with `parseRef`. `tessera-observe <code>` and
`tessera-bot <room-code>` take whatever `parseRef` accepts; in socket mode
they skip `installWebRTC()` entirely (and `node-datachannel` is never loaded —
it is only pulled in for the rtc path).

## Verification

- `packages/net/src/test/ref.test.ts` — the parse table: both forms, a URL
  with no room, a bare word, whitespace, a `tsr-` with nothing after it.
- The existing lobby and harness suites pass untouched — they exercise the
  `rtc` branch through the same `open` signature.
- Headless: `joinGame` accepts a `wss://` ref and fails with "socket transport
  not built yet" (placeholder until 0004 lands); a `tsr-` ref behaves exactly
  as today.

---

# Implementing it

## What ships, and the one line of the plan that cannot be written as stated

The body asks for a type, a parser and one rewired construction site. All three
are small. What the body does not say is that its own signature is impossible:

```ts
static async open(identity: Identity, ref: ConnectionRef, options?): Promise<Lobby>;
```

`main.ts:473` calls `begin()` with no code to host a game, and `begin(code)`
with one to join. `Lobby.open(identity, undefined)` is *hosting* — the whole
of it, at `lobby.ts:105-106` and `mesh.ts:149`, where an absent `join` is what
makes the mesh mint a room code instead of dialling one. A `ConnectionRef` has
no variant for "there is no room yet, make one here", and it should not grow
one: a ref is a string somebody typed, and nobody types "host".

So the signature is `ref?: ConnectionRef`, and **`undefined` means host**. That
reads oddly for about a minute and then stops, because it is the honest shape:
a ref is where to go, and a host is not going anywhere.

It also has a consequence worth naming now rather than in 0004. Over a socket
there is no host variant *either*, for the opposite reason — the room bus
creates a room on first `{op:"join"}`, so hosting is joining a room nobody is
in yet. `undefined` will therefore stay WebRTC-only forever, and the question
"who composes the genesis in a socket room" is 0006's, not this plan's. It is
in the closing section.

## Where the string is today, and every place it lands

Eight sites, and only two of them decide anything:

| Site | Today | After |
|---|---|---|
| `lobby.ts:124` `Lobby.open(identity, join?: string, …)` | builds `PeerMesh` | takes `ref?: ConnectionRef`, calls `openConnection` |
| `lobby.ts:105` `this.code = join ?? mesh.id` | the room token, shown and seeded | a getter over `this.ref` |
| `lobby.ts:106` `phase = join ? "waiting" : "hosting"` | WebRTC's shape | unchanged, and flagged as WebRTC's shape |
| `lobby.ts:102` `readonly mesh: PeerMesh` | the only field the type narrows | `readonly connection: Connection` |
| `lobby.ts:140-149` `onError` sniffs `error.type` | PeerJS vocabulary in the lobby | moves into the rtc branch of `openConnection` |
| `peer.ts:35` `JoinOptions.code: string` | passed straight through | `ref: string`, parsed at the top of `joinGame` |
| `peer.ts:67` `await installWebRTC()` | unconditional | rtc refs only |
| `main.ts:480`, `Online.ts:24`, `observer/main.ts:97` | `PeerMesh` | `Transport` / `Connection` |

Nothing else in the repository mentions `PeerMesh` outside its own tests
(`chunking.test.ts`, `ice.test.ts`), and those construct it directly rather
than through the lobby, so they are untouched.

## `packages/net/src/ref.ts`

```ts
// What kind of connection a string names.
//
// The player types one thing and it decides everything: a peer id is a WebRTC
// mesh introduced by a broker, a wss:// URL is a room on a relay. There is no
// settings screen, no probe and no fallback ladder, because a transport
// nobody chose is a transport nobody can debug — and the two failure modes it
// would be hiding (symmetric NAT, an unreachable relay) look identical from
// inside a ladder and completely different from outside one.
//
// A ref is an address and nothing more. It says where to go, never what will
// be found there or whether it can be believed: the genesis record answers
// the first question and every signature answers the second.

/** The characters a room name may use, on either transport.
 *
 *  One charset for both is what lets a listing offer the same room under two
 *  refs (0007). It is also why formatRef is a concatenation rather than an
 *  escaping problem: every legal name is already a safe URL path segment. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The prefix `openConnection` mints room codes under. Refs are not required
 *  to carry it — see below — but a code this build handed out always will. */
export const RTC_PREFIX = "tsr-";

export type ConnectionRef =
  | { kind: "socket"; url: string; room: string }
  | { kind: "rtc"; code: string };

const EXPECTED =
  'a room code like "tsr-abc234", or a room link like ' +
  '"wss://relay.example/tessera/abc234"';

export function parseRef(input: string): ConnectionRef {
  const text = input.trim();
  if (!text) throw new Error(`nothing to join — expected ${EXPECTED}`);
  if (/^wss?:\/\//i.test(text)) return socketRef(text);

  // Not a URL, so it is a peer id. Deliberately not a `tsr-` check: an
  // observer started with `--as nightwatch` is dialled at `nightwatch`, and
  // 0007 will hand out ids minted by peers this build never saw. The prefix
  // is a minting convention, not a wire format, and treating it as one would
  // break the durable peer that is the whole reason `--as` exists.
  if (!NAME.test(text)) {
    throw new Error(`"${text}" is not a room — expected ${EXPECTED}`);
  }
  return { kind: "rtc", code: text };
}

function socketRef(text: string): ConnectionRef {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${text}" is not a URL — expected ${EXPECTED}`);
  }
  // Refused rather than dropped: a ref has to survive being printed and typed
  // back in, and anything formatRef cannot reproduce would silently become a
  // different ref on the round trip.
  if (url.search || url.hash) {
    throw new Error("a room link carries no query or fragment");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const room = parts.pop();
  if (!room) throw new Error(`"${text}" names a server but no room`);
  if (!NAME.test(room)) throw new Error(`"${room}" is not a room name`);

  const path = parts.length > 0 ? `/${parts.join("/")}` : "";
  return { kind: "socket", url: `${url.protocol}//${url.host}${path}`, room };
}

/** The exact inverse. Everything that prints a ref — the panel's share line,
 *  a CLI's "joining …", the address book (0007) — goes through here, so
 *  "parse then format is the identity" is one property to test rather than
 *  four hand-written strings to keep in step with each other. */
export function formatRef(ref: ConnectionRef): string {
  return ref.kind === "rtc" ? ref.code : `${ref.url}/${ref.room}`;
}
```

Three decisions inside that are not obvious from the body:

**`new URL`, not string splitting.** The body says "the last path segment is
the room, the rest is the URL", which is right and is also four bugs: a port,
an IPv6 host in brackets, a percent-encoded segment, and a trailing slash.
`URL` handles all four and rejects the malformed rest for free. The cost is
that parsing is *normalising* — `WSS://Relay.Example/T/r` comes back as
`wss://relay.example/T/r`. So the round-trip property is `format(parse(s))`
is stable under reparsing, not that it equals `s`. Worth stating in the test
name, because the weaker claim is the true one.

**`ws://` stays legal and is nearly useless.** A page served over https cannot
open a plaintext WebSocket; the browser blocks it as mixed content, and it does
so before any of our code runs. It is kept for local development against a room
bus on `localhost`, which is exactly the case browsers exempt. Anyone who ships
a `ws://` ref to a real player has made a mistake this parser is the wrong place
to catch.

**The rtc branch accepts any legal id, not just `tsr-`.** This is the one place
where following the body literally would break something that works today.
`README.md:69` documents `--as tsr-nightwatch`, but nothing enforces the
prefix, `docs/clients/observer.md:17` and `docs/concepts/peers-and-roles.md:51`
both describe `--as` as claiming an arbitrary stable id, and the durable peer
is dialled at exactly that id. Rejecting `nightwatch` would make the observer's
headline feature unreachable from the join box.

The observer should meet it halfway: warn (not fail) when `--as` is given a
value outside `NAME`, since such an id can be claimed at the broker and then
never typed back in.

## One charset, so a listing row can honestly carry two refs

The body claims "a listing row can carry two refs". That is only true if the
same room name is expressible in both forms, which is what `NAME` buys: a
64-character `[A-Za-z0-9_-]` name is simultaneously a legal PeerJS id and a
URL path segment needing no escaping. `abc234` can be `tsr-abc234` and
`wss://relay.example/tessera/abc234`, and 0007 can print the pair without a
mapping table.

It is a constraint on the *room bus*, not just on us — 0004's contract should
say the server rejects a `room` outside this charset rather than routing it.
A relay that accepts `../` or a newline as a room name is a relay with a path
traversal in whatever it eventually logs to.

## `Connection`, and why `Transport` does not grow a `close`

```ts
// packages/net/src/connect.ts

/** A transport with a life: something the lobby opened, and must therefore
 *  be able to shut.
 *
 *  `Transport` stays four verbs and an id. Widening the interface that every
 *  driver, the hub and the whole test harness are written against, for the
 *  benefit of the two implementations the lobby happens to open, would be the
 *  wrong way round — a loopback switch and a hub port have nothing to close,
 *  and an optional `close?()` would put a `?.` at every call site to say so. */
export interface Connection extends Transport {
  close(): void;
}
```

`PeerMesh` already satisfies it structurally (`mesh.ts:129` implements
`Transport`, `mesh.ts:338` is `close()`), so this is a type and no code.

The body writes it as the inline intersection `Transport & { close(): void }`.
Naming it is worth the line: it appears on the lobby field, on
`openConnection`'s return, and on 0004's `SocketTransport` — and it pairs with
`ConnectionRef`, which is then plainly "a reference to a connection" rather
than a type whose noun appears nowhere else.

## `openConnection`, which is where the switch lives exactly once

```ts
export interface ConnectOptions {
  /** The id to claim rather than one assigned to us. A request on both
   *  transports and a right on neither: the broker refuses a taken id, and a
   *  room bus stamps `from` itself (0004). */
  id?: string;
  /** WebRTC only; ignored for a socket ref. Replaces PeerJS's own relays
   *  rather than adding to them — the trap `mesh.ts` documents at length. */
  iceServers?: RTCIceServer[];
  onJoin?: (peer: string) => void;
  onLeave?: (peer: string) => void;
  onError?: (error: Error) => void;
}

export type Opener = (
  ref: ConnectionRef | undefined,
  options: ConnectOptions,
) => Promise<Connection>;

/** Open the connection a ref names. `undefined` means "start a room here",
 *  which only WebRTC can do — over a socket the room bus creates a room on
 *  first join, so hosting is not a separate act. */
export const openConnection: Opener = async (ref, options = {}) => {
  if (ref?.kind === "socket") throw new Error("socket rooms are not built yet");

  return createMesh({
    ...(ref ? { join: ref.code } : {}),
    prefix: RTC_PREFIX,
    ...(options.iceServers ? { iceServers: options.iceServers } : {}),
    ...(options.id ? { id: options.id } : {}),
    onJoin: options.onJoin,
    onLeave: options.onLeave,
    onError: (error) => options.onError?.(translate(error, ref)),
  });
};

/** PeerJS tags its errors, and the two that matter to a player are being
 *  unable to reach the broker at all and naming a room that is not there.
 *  This lived in the lobby (`lobby.ts:140-149`), which meant the one file
 *  that is supposed to know nothing about transports was reading a PeerJS
 *  discriminator. Every transport owes the lobby a sentence, not a tag. */
function translate(error: Error, ref?: ConnectionRef): Error {
  const type = (error as Error & { type?: string }).type;
  const where = ref ? formatRef(ref) : "the broker";
  if (type === "peer-unavailable") {
    return new Error(`no game is running under ${where}.`);
  }
  if (type === "network" || type === "server-error") {
    return new Error("lost contact with the matchmaking broker.");
  }
  return error;
}
```

The `translate` move is the plan's one genuine tidy-up rather than a
rearrangement. Today `lobby.ts:144` reads
`(error as Error & { type?: string }).type` — a cast, in the file that is
supposed to know nothing about transports, against a library the lobby does
not import. After this the lobby's `onError` is one line,
`(error) => lobby.fail(error.message)`, and 0004's socket branch is obliged
to produce sentences of the same quality, because there is nowhere else for
them to come from.

`packages/net/src/index.ts` gains, beside the existing mesh exports:

```ts
export { parseRef, formatRef, RTC_PREFIX } from "./ref.js";
export type { ConnectionRef } from "./ref.js";
export { openConnection } from "./connect.js";
export type { Connection, ConnectOptions, Opener } from "./connect.js";
```

`packages/net/tsconfig.json` keeps its `lib: ["ES2022", "DOM"]`; the comment
above it says DOM is there "for mesh.ts alone" and now needs `ref.ts` (`URL`)
and `connect.ts` (`RTCIceServer`) added to it. A comment that names a single
file ages exactly this way, so name the reason instead: browser types.

## The lobby, line by line

```ts
private constructor(
  readonly identity: Identity,
  readonly connection: Connection,
  /** Where we are, resolved: what the joiner typed, or — for a host — the
   *  room the broker has just handed us. Known only after the connection is
   *  open, which is why it is a constructor argument and not a parse result. */
  readonly ref: ConnectionRef,
  private readonly joined: boolean,
) {
  this.phase = joined ? "waiting" : "hosting";
  ...
}

/** The room token: a peer id on WebRTC, a room name on a socket. Shown where
 *  a short thing is wanted, and fed to the map seed. `shareable` is what a
 *  player actually sends to somebody else. */
get code(): string {
  return this.ref.kind === "rtc" ? this.ref.code : this.ref.room;
}

get shareable(): string {
  return formatRef(this.ref);
}
```

`open` becomes:

```ts
static async open(
  identity: Identity,
  ref?: ConnectionRef,
  options: ConnectOptions & { connect?: Opener } = {},
): Promise<Lobby> {
  let lobby: Lobby | undefined;
  const connection = await (options.connect ?? openConnection)(ref, {
    ...options,
    onJoin: (peer) => lobby?.welcome(peer),
    onLeave: (peer) => {
      lobby?.members.delete(peer);
      lobby?.changed();
    },
    onError: (error) => lobby?.fail(error.message),
  });
  const here: ConnectionRef = ref ?? { kind: "rtc", code: connection.id };
  lobby = new Lobby(identity, connection, here, !!ref);
  return lobby;
}
```

Everything else in the file survives verbatim, and it is worth being precise
about how much that is: `welcome`, `greet`, `route`, `host`, `adopt`,
`baseTransport`, the backlog, the watchdog, `players`, `labels`, `fail` and
`close` — the entire body of `lobby.ts` from line 155 to line 346, minus three
identifier renames. The handshake was already transport-neutral; nothing in
this plan discovers otherwise.

The three renames: `this.mesh` → `this.connection` at `lobby.ts:107, 112, 161,
215, 283, 321, 344`. Renaming rather than widening in place, because a field
called `mesh` holding a WebSocket is the kind of thing that is true for one
release and misleading for five. Two call sites outside the package follow:
`main.ts:525` and `observer/main.ts:97`.

The watchdog message at `lobby.ts:113-116` interpolates `join`; it becomes
`this.shareable`, which is the same string for a WebRTC joiner and a correct
one for a socket joiner later.

`host()` at `lobby.ts:273` seeds from `` `${this.code}:${Date.now()}` ``. That
keeps working through the getter and produces an identical seed for every
WebRTC game — the input is a peer id today and a peer id after. Nothing about
the map changes, which is the point: this plan must not move a single hash.

## What a ref is not: an address is not an authority

Worth writing down before 0004 makes it load-bearing, because it is the first
time this repository lets a *stranger's string* choose which server a peer
talks to.

Unchanged, and it is most of what matters. The genesis is content-addressed and
`inspectGenesis` runs on every peer before it agrees to play (`lobby.ts:292`).
Every move is signed and verified per peer. Every state is hash-checked against
the one invariant. A room bus, like a TURN relay, can drop, delay and reorder;
it cannot forge, alter or read a decision. The header of `mesh.ts` makes this
argument for TURN already and it transfers intact.

Two things are genuinely new:

**A ref names a server of the sender's choosing.** Opening one reveals your IP
address and your timing to whoever runs it. Today the only third party is a
broker fixed at build time; after this, a pasted link picks one. This is the
same exposure as clicking any link, and it is why the join box and the address
book must show the **full host**, never a friendly name — 0007 and 0008 should
take that as a constraint rather than a suggestion.

**A room bus stamps `from`, so it can conjure peers that do not exist.** In the
lobby that means phantom rows in the host's team picker: a `HELLO` carries
`gameId: ""` and proves nothing beyond "here is a key to seat me under", which
`lobby.ts:210-213` already says out loud. A host who seats a phantom key
composes a game with a seat nobody can play — which the abandonment window
(0002) resolves, slowly, and which 0009's co-signed genesis resolves properly.
Griefing, not authority. The distinction is the whole point, and it is the
reason this plan can open the transport question without touching the trust
model at all.

## The first lobby test, which is what pays for the refactor

There is no lobby suite. The body's verification says "the existing lobby and
harness suites pass untouched"; the harness suites do and there is no lobby
suite to pass. Nothing under `packages/net/src/test` mentions `Lobby`, and the
reason is structural: `createMesh` reaches for PeerJS through a dynamic
`import("peerjs")` (`mesh.ts:111`) with no injection point, so a lobby test
would need a real broker.

The `connect?: Opener` option is the injection point, and it costs four words
in a signature. A test supplies an opener over `LoopbackNetwork`, which needs a
~10-line wrapper because a loopback `Transport` has no `close` and no
join/leave events — the test calls `onJoin` itself when it wires the pair,
which is honest, since "a peer appeared" is the transport's news to deliver.

One test is enough to be worth it, and it covers the seam every later plan
leans on:

```
two lobbies over a loopback: the joiner's HELLO reaches the host, the host
composes and broadcasts, both reach phase "playing", the host holds
{empire: 1, member: 0} and the joiner {empire: 2, member: 0}, and a third
lobby that never sent a key adopts the same genesis with seat undefined.
```

That is the observer-by-construction claim, currently asserted only in prose
(`docs/concepts/peers-and-roles.md`), and it is exactly what 0006's host peer
and 0010's vacant empires will change the shape of.

This is the one addition to the body's scope. It is optional in the sense that
0003 ships without it; it is not optional in the sense that 0004, 0006 and 0009
all edit this file and none of them can currently prove they did not break it.

## Headless: `code` becomes `ref`, and node-datachannel stops loading

`packages/headless/src/peer.ts:35`:

```ts
/** Where the game is: a room code, or a room link. A string rather than a
 *  parsed ref because both callers are command lines, and parsing it here
 *  means one error message for both of them. */
ref: string;
```

`joinGame` parses first and installs second, replacing the unconditional
`await installWebRTC()` at `peer.ts:67`:

```ts
const ref = parseRef(options.ref);
// A socket peer has no use for a native WebRTC stack, and this is the only
// place in the repository that loads one. node-datachannel is the single
// genuinely unpleasant dependency here — prebuilt binaries per platform,
// where everything else is portable TypeScript — so a socket-only deployment
// getting to skip it is not a micro-optimisation, it is the difference
// between an install that works on a small VPS and one that does not.
if (ref.kind === "rtc") await installWebRTC();
```

`shutdownWebRTC` needs no guard: it already returns early when nothing was
installed (`webrtc.ts:44`), so all three teardown paths stay as they are.

The timeout message at `peer.ts:85` interpolates `options.code` → `options.ref`.
The bad-ref case fails synchronously, before the lobby exists, which is a
better failure than any this function currently produces.

**Both CLIs**: `apps/observer/src/main.ts:75` and `apps/bot/src/main.ts:210`
change `code,` to `ref,`; the positionals at `main.ts:205` and `main.ts:275`
and the `USAGE` blocks at `main.ts:37` and `main.ts:47` change `<room-code>` to
`<room>`. One pleasant side effect: `tessera-observe ./archives/abc` — the
mistake of forgetting the `verify` subcommand — now fails immediately with
`"./archives/abc" is not a room` instead of dialling it and waiting 45 seconds
for a broker that was never going to have it.

The observer's `--as` gains the warning described above. `--ice` keeps working
and does nothing on a socket ref; that is documented, not enforced, because
both CLIs pass it unconditionally from a flag and turning an ignored option
into an error would break scripts that set it once for everything.

## The web: parse before "connecting", and one word in the placeholder

`apps/web/src/main.ts:473`:

```ts
async function begin(input?: string): Promise<void> {
  if (lobby) return;

  // Parsed before the panel says "connecting", because a string that was
  // never going to be a room should not flash a spinner on its way to being
  // rejected. This is the whole of the client's involvement in transports.
  let ref: ConnectionRef | undefined;
  try {
    if (input) ref = parseRef(input);
  } catch (error) {
    panel.detach((error as Error).message);
    return;
  }

  panel.connecting();
  ...
  opened = await Lobby.open(identity, ref);
```

`main.ts:525` becomes `new OnlineGame(driver, lobby!.connection)`, and
`apps/web/src/game/Online.ts:9,24` widen `PeerMesh` to `Transport` — the class
reads `peers().length` at lines 120 and 122 and nothing else, so the field is
better named `net` than `mesh` while it is being touched.

`LobbyPanel.ts:168` placeholder `"room code"` → `"room code or link"`, and the
hint at line 162 gains the same word. `handlers.join` keeps taking a string
(line 15): the panel collects text and the page parses it, which keeps the view
free of network types exactly as it is today. `LobbyPanel.ts:208-209` shows
`lobby.code`; that becomes `lobby.shareable`, which is identical for a WebRTC
host and correct for everything after.

## Order of work

| # | Step | Green on its own |
|---|---|---|
| 1 | `ref.ts` + `ref.test.ts` | yes — nothing imports it yet |
| 2 | `connect.ts`: `Connection`, `ConnectOptions`, `openConnection`, `translate`; exports; the tsconfig comment | yes — still nothing calls it |
| 3 | `lobby.ts`: field rename, `ref`/`code`/`shareable`, the new `open`, `onError` slimmed | **no** — lands with step 4 |
| 4 | `main.ts:480,525`, `Online.ts`, `observer/main.ts:97` | with step 3 |
| 5 | `peer.ts`, then both CLIs and their `USAGE` | yes |
| 6 | `LobbyPanel` copy and `shareable` | yes |
| 7 | `lobby.test.ts` over a loopback opener | yes |
| 8 | Docs | yes |

Steps 3 and 4 are one commit: `Lobby.open`'s signature changes and it has
exactly two callers, one of which is in another package. Everything else is
independently revertable.

## Docs

| File | Change |
|---|---|
| `docs/mesh/connection-refs.md` | new, short: the two forms, the shared charset, `parseRef`/`formatRef`, and "an address is not an authority" |
| `docs/mesh/the-lobby.md` | the `open` signature under **Phases**; `undefined` means host; `code` vs `shareable` |
| `docs/mesh/transport-interface.md` | `Connection` beside `Transport`, and why the latter did not grow a `close` |
| `docs/mesh/README.md` | link the new page |
| `docs/glossary.md:11-14` | **host** says "its PeerJS peer id **is** the room code" — still true of a WebRTC room, now one case of two; add **connection reference** |
| `docs/clients/observer.md:17,31` | `<room-code>` → `<room>`; the `--as` warning |
| `docs/clients/bot.md:47` | the same |
| `docs/clients/headless-peers.md` | `JoinOptions.code` → `ref`; the node-datachannel skip |
| `README.md:69-76` | the example keeps `tsr-` codes; add one sentence that a room can also be a link |

The new page is worth its own file rather than a section: 0004 (the contract),
0007 (the address book) and 0008 (the join box) all need somewhere to point,
and pointing at a heading inside the lobby doc would put the ref's definition
underneath a page about something else.

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| both forms parse | `net/src/test/ref.test.ts` — `tsr-abc234`, a bare `nightwatch`, `wss://h/tessera/r`, `wss://h:8443/r`, `ws://localhost:9000/dev/r` |
| refusals name the alternative | the same file — `""`, `"   "`, `"tsr-"` alone, `"hello there"`, `"wss://h"`, `"wss://h/r?x=1"`, `"wss://h/r#f"`, `"wss://h/../r"`, a 65-character name, `"http://h/r"` |
| the round trip is stable | `format(parse(s))` reparses to the same ref, for every accepted input above. Not `=== s`: parsing normalises host case and scheme |
| a WebRTC ref still reaches a game | the observer against a browser host — the same manual check as today, and the only one this plan cannot automate |
| a socket ref fails early and cleanly | `joinGame({ ref: "wss://h/t/r", … })` rejects with "socket rooms are not built yet" |
| a socket ref loads no native module | the same test asserts `installWebRTC` was not called. The cheap version is a spy; the honest version is that the suite runs with `node-datachannel` absent and still passes |
| the lobby still gets two peers to one game | `net/src/test/lobby.test.ts`, over a loopback opener |
| an unkeyed peer adopts and holds nothing | the same test's third lobby |
| nothing moved the hash | `pnpm test` unchanged, and the recorded-game fixture unchanged — this plan touches no file under `packages/sim` |

The last row is the cheapest and the most important. `packages/sim` is not in
the diff at all, `packages/protocol` is not in the diff at all, and no frame
type, field or encoding changes. A reviewer can establish the whole
compatibility argument from `git diff --stat`.

## Two things this plan does not settle

**Who hosts a socket room.** `phase = ref ? "waiting" : "hosting"` is WebRTC's
shape: absent a ref you are the host, and with one you are not. Over a socket
the first peer into a room is its host and the ref says nothing about which you
are. 0004's `welcome` carries `peers: []`, which is the answer — but it arrives
*after* `Lobby.open` has already chosen a phase, so either the phase becomes
late-bound or the host peer (0006) is always the composer and a browser is
never a socket host. The second is probably right and is 0006's call; naming it
here so 0004 does not have to discover it.

**A ref names a room, not a game.** `tsr-abc234` is a peer and
`wss://h/t/abc234` is a room; either can outlive the game that was in it, and
either can hold a different one tomorrow. A rejoining peer that already knows a
`gameId` has no way to say so, and takes whatever genesis the room sends it —
checked by `inspectGenesis`, certainly, but not necessarily the game it meant
to rejoin. 0007's address book pairs a ref with a game id and is where this
gets fixed. Until then, "rejoin" honestly means "reconnect and see".
