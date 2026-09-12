# The room bus

A **room bus** is a relay: it holds `room -> sockets` and forwards bytes. It is
the server half of the [socket transport](socket-transport.md), and this page is
the contract — an independent implementation in any language is correct if it
obeys the table below.

[`RoomBus`](../../packages/net/src/roombus.ts) is the reference implementation,
and it ships in `packages/net` rather than beside a test for the same reason
[`LoopbackNetwork`](transport-interface.md) does: a thing that defines a contract
by implementing it is part of the contract. It is written against an abstract
socket, so a host process wraps `ws` around it and a test wraps a fake around it,
and the bus never learns which.

## The envelope

```ts
client → server
  { op: "join",  v: number, room: string, id?: string }   // id is a request, not a right
  { op: "frame", to?: string, d: string }                 // d is the encoded frame text
  { op: "ping" }

server → client
  { op: "welcome", id: string, peers: string[] }
  { op: "frame",   from: string, d: string }
  { op: "peers",   ids: string[] }
  { op: "closed",  reason?: string }
  { op: "pong" }
```

`BUS_VERSION` is **1**. It is bumped when a server and a client can no longer
understand each other, which is a different question from whether two peers can
play the same game — that is `PROTOCOL_VERSION`, and it moves on a different
clock. A bus carries frames it does not parse, so it can outlive several game
protocols without changing at all. **The two must never be checked against each
other.**

`ping`/`pong` exists because a WebSocket through a proxy dies silently after
roughly a minute of idle and a browser cannot send protocol-level pings from
JavaScript. Seated peers are never quiet for long — a `HEARTBEAT` move goes out
every 30 s — but an observer sends nothing at all, and an observer that never
notices its socket died is a [host peer](../clients/headless-peers.md) failing to
be a door.

## The rules

| Rule | Because |
|---|---|
| `join` first, exactly once | a frame from a socket in no room has no `from` to stamp |
| `v` must equal `BUS_VERSION` | otherwise the first incompatible change is discovered as frames that arrive and mean nothing. `closed`, with a sentence |
| `room` must match the [ref charset](connection-refs.md) | a relay that accepts `../` or a newline as a room name has a path traversal in whatever it eventually logs to |
| a requested `id` is granted only if free | two sockets under one id is a driver addressing both and neither |
| a taken id is **replaced, not refused** | ids carry no authority and `welcome.id` is already the truth, so a refusal would be a failure path in exchange for nothing |
| `from` is stamped, never read from the client | the one property every peer relies on |
| never echo to the sender | every driver is written against its absence; `LocalHub` adds loopback as an explicit special case |
| an unknown `to` is dropped | a peer that left mid-frame is ordinary, and there is nobody to report it to who could act on it |
| the roster is **the whole room, self included**, broadcast | one message rather than one tailored per recipient: idempotent, cheap, and the filtering belongs to whoever knows which id they hold |
| over the size or rate limit | `closed`, and a client that is told `closed` does not redial |

## Limits

| Limit | Value | Why that |
|---|---|---|
| envelope | 1 MB | about six times the largest thing the game sends — a 160×112 snapshot is ~170 kB of base64, and a WebSocket carries it whole. There is no chunking here; the mesh's 15 kB slicing is a data-channel limit, not a protocol one |
| room name | 64 chars of `[A-Za-z0-9_-]` | already a safe URL path segment |
| peers per room | 64 | 24 seats is the game's ceiling; the rest is observers, who are unlimited by design — this is an abuse ceiling, not a rule about who may watch |
| rooms per bus | 1024 | a number an operator can raise knowingly |
| rate | 64/s sustained, burst 256 | a snapshot answer to three joiners at once must not trip a limit meant for a flood |

## What a relay can do

Unchanged, and it is most of what matters: the genesis is content-addressed and
checked by every peer, every move is signed and verified per peer, every state is
hash-checked. A bus can drop, delay and reorder. It **cannot** forge a move,
alter one, seat anybody, or read a team line. It keeps no game state and parses
no frame, so there is nothing in it to corrupt. This is the argument
[`mesh.ts`](webrtc-mesh.md) makes for a TURN relay, transferred whole.

One capability is genuinely new, and it is worth stating plainly. A TURN relay
carries one pair; a room bus carries everybody, and can therefore **silence one
seat while carrying the rest**. What happens then is that the honest majority
stops hearing that seat, the stall machinery proposes a
[`Drop`](../continuity/ejection.md), a quorum endorses it, and the player is out
of the game. So a hostile relay's power is denial of play escalating to ejection
— never authority, and never invisible: the ejection is a quorum-signed record in
every archive of that game, naming the step and the reason.

Two smaller ones:

- a relay sees who talks to whom and when, for every peer in the room at once.
  The mesh's broker sees only introductions;
- the [ref](connection-refs.md) names a server of the sender's choosing, so
  opening one reveals an IP and a timing pattern to whoever runs it. A room bus
  is why a join box must show the full host.

The abuse surface in the other direction is bytes pushed into rooms nobody is
listening to, bounded by the rate limit and harming nothing but bandwidth.
