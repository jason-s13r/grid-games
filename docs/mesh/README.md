# The mesh

[`packages/net`](../../packages/net) is the network: how peers find each other,
how frames cross between them, and how a game is agreed. The
[lockstep driver](../continuity/lockstep.md) that turns those frames into an
agreed world is large enough that it and the recovery paths around it live in
[continuity/](../continuity/).

| Page | Covers |
|---|---|
| [transport-interface.md](transport-interface.md) | The four methods the driver needs; the loopback network the tests use |
| [connection-refs.md](connection-refs.md) | `ConnectionRef` — the string you join with, and which transport it chooses |
| [webrtc-mesh.md](webrtc-mesh.md) | `PeerMesh` — the PeerJS broker, the full mesh, chunking, TURN |
| [socket-transport.md](socket-transport.md) | `SocketTransport` — a room on a relay, the outbound buffer, the reconnect |
| [room-bus.md](room-bus.md) | The relay's wire contract: the envelope, the rules, the limits |
| [local-hub.md](local-hub.md) | `LocalHub` — running several drivers (a seated bot) in one page |
| [the-lobby.md](the-lobby.md) | `Lobby` — from "two peers connected" to "one agreed genesis" |
| [address-book.md](address-book.md) | `Directory` — finding a game on a board that is allowed to lie |

## The shape

```
                 PeerJS broker  (signalling only — never sees a move)
                       │
   browser ───── WebRTC full mesh ───── browser
       │                                   │
   Lobby → Lockstep                   Lobby → Lockstep
       │                                   │
   Sim + Roster                       Sim + Roster

   …or the same game through a relay, which is fanout and nothing else:

   browser ──┐                        ┌── browser
             ├── room bus (room → sockets, stamps `from`, parses no frame)
   headless ─┘                        └── host peer
```

Both shapes carry the same frames, and neither carries any authority.

Which transport a peer opens is decided by the [ref](connection-refs.md) it was
given, in one place, once.

Where that ref comes from is the [address book](address-book.md), which is a
**directory and never a server**: it holds connection parameters, it is allowed
to lie about all of them, and every row a client returns has been re-derived from
the sealed genesis inside it.

The driver never mentions PeerJS, WebRTC or a socket — it speaks only the
[`Transport`](transport-interface.md) interface. That is not tidiness: it is what
makes the consensus logic testable, because `LoopbackNetwork` implements the same
interface well enough to run six drivers in one Node process with deterministic
delivery order.
