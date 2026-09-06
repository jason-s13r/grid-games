# The mesh

[`packages/net`](../../packages/net) is the network: how peers find each other,
how frames cross between them, and how a game is agreed. The
[lockstep driver](../continuity/lockstep.md) that turns those frames into an
agreed world is large enough that it and the recovery paths around it live in
[continuity/](../continuity/).

| Page | Covers |
|---|---|
| [transport-interface.md](transport-interface.md) | The four methods the driver needs; the loopback network the tests use |
| [webrtc-mesh.md](webrtc-mesh.md) | `PeerMesh` — the PeerJS broker, the full mesh, chunking, TURN |
| [local-hub.md](local-hub.md) | `LocalHub` — running several drivers (a seated bot) in one page |
| [the-lobby.md](the-lobby.md) | `Lobby` — from "two peers connected" to "one agreed genesis" |

## The shape

```
                 PeerJS broker  (signalling only — never sees a move)
                       │
   browser ───── WebRTC full mesh ───── browser
       │                                   │
   Lobby → Lockstep                   Lobby → Lockstep
       │                                   │
   Sim + Roster                       Sim + Roster
```

The driver never mentions PeerJS, WebRTC or a socket — it speaks only the
[`Transport`](transport-interface.md) interface. That is not tidiness: it is what
makes the consensus logic testable, because `LoopbackNetwork` implements the same
interface well enough to run six drivers in one Node process with deterministic
delivery order.
