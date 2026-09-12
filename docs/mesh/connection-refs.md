# Connection references

[`ConnectionRef`](../../packages/net/src/ref.ts) is what kind of connection a
string names. It exists so that the [lobby](the-lobby.md) does not care which
transport it opens, and so that choosing one is **data a player already typed**
rather than a settings screen.

```ts
type ConnectionRef =
  | { kind: "socket"; url: string; room: string }   // wss://relay.example/tessera/abc234
  | { kind: "rtc"; code: string };                  // tsr-abc234, or any peer id

parseRef(input: string): ConnectionRef   // throws, naming both forms
formatRef(ref: ConnectionRef): string    // the exact inverse
```

## The two forms

| Input | Reads as |
|---|---|
| `ws://…` or `wss://…` | `socket` — a room on a [room bus](room-bus.md), opened by the [socket transport](socket-transport.md). The last path segment is the room, everything before it is the server. |
| anything else in the room charset | `rtc`, verbatim — a [PeerJS](webrtc-mesh.md) peer id. |
| anything else | an error that names both forms. |

**The ref is the toggle.** There is no probe, no `?transport=`, and no runtime
fallback ladder. A transport nobody chose is a transport nobody can debug, and
the two failure modes a ladder would hide — symmetric NAT on one side, an
unreachable relay on the other — look identical from inside one and completely
different from outside. A player who wants the other transport joins the other
string, which is also how one room advertises both.

`ws://` stays legal and is nearly useless: a page served over https cannot open
a plaintext socket, and the browser blocks it before any of our code runs. It is
there for `pnpm dev` against a room bus on localhost, which is the case browsers
exempt.

## One charset, so one room can have two refs

A room name is 1–64 characters of `[A-Za-z0-9_-]`, on both transports.

That is what lets a listing row offer the same room as `tsr-abc234` *and* as
`wss://relay.example/tessera/abc234` with no mapping table, and it is why
`formatRef` is a concatenation rather than an escaping problem: every legal name
is already a safe URL path segment. It is a constraint on a room bus too — a
relay that accepts `../` or a newline as a room name is a relay with a path
traversal in whatever it eventually logs to.

The `rtc` branch accepts **any** legal name, not only the `tsr-` prefix that
[`openConnection`](#openconnection) mints under. The prefix is a minting
convention, not a wire format: an [observer](../clients/observer.md) started
with `--as nightwatch` is dialled at exactly `nightwatch`, and insisting on the
prefix would make the durable peer unreachable from a join box.

Parsing **normalises** — `new URL` lowercases the scheme and host — so the
round-trip property is that `formatRef(parseRef(s))` reaches the same room when
typed back in, not that it equals `s` character for character.

## openConnection

[`openConnection`](../../packages/net/src/connect.ts) is the only place the
switch lives:

```ts
type Opener = (ref: ConnectionRef | undefined, options: ConnectOptions) => Promise<Connection>;
```

**`undefined` means host.** A ref is a string somebody typed and nobody types
"host", so there is no variant for "start a room here"; absent a ref, we are the
room. That is WebRTC's shape, where a peer id *is* a room code. Over a socket the
room bus creates a room on first join, so hosting is not a separate act there —
which leaves "who composes the genesis in a socket room" a question for the host
peer rather than for this type.

It is also where a transport's error vocabulary becomes a sentence. PeerJS tags
its errors; that cast used to sit in the lobby — the one file meant to know
nothing about transports — so it moved here. The lobby's `onError` is now one
line, and **every transport owes the lobby a sentence, not a tag**, because there
is nowhere else for one to come from.

## An address is not an authority

A ref chooses a server. It does not, and cannot, choose what is true.

Unchanged, and it is most of what matters: the genesis record is
content-addressed and [`inspectGenesis`](../protocol/genesis.md) runs on every
peer before it agrees to play; every move is signed and verified per peer; every
state is hash-checked. A room bus, exactly like a TURN relay, can drop, delay and
reorder. It cannot forge, alter or read a decision.

Two things are genuinely new, and both are worth naming:

- **A ref names a server of the sender's choosing.** Opening one reveals your IP
  address and your timing to whoever runs it — the same exposure as clicking any
  link. It is why a join box and a listing must show the **full host** and never
  a friendly name.
- **A room bus stamps `from`, so it can conjure peers that do not exist.** In the
  lobby that means phantom rows in a host's team picker: a `HELLO` carries
  `gameId: ""` and proves nothing beyond "here is a key to seat me under". A host
  who seats a phantom key composes a game with a seat nobody can play — which the
  abandonment window resolves slowly, and a co-signed genesis resolves properly.
  Griefing, not authority.

## A ref names a room, not a game

`tsr-abc234` is a peer and `wss://h/tessera/abc234` is a room. Either can outlive
the game that was in it, and either can hold a different one tomorrow. A
rejoining peer that already knows a `gameId` has no way to say so and takes
whatever genesis the room sends it — checked by `inspectGenesis`, certainly, but
not necessarily the game it meant to rejoin. Pairing a ref with a game id is the
address book's job; until then, "rejoin" honestly means "reconnect and see".
