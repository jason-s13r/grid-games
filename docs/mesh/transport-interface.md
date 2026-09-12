# The transport interface

[`Transport`](../../packages/net/src/transport.ts#L14) is the **entire** surface
[`Lockstep`](../continuity/lockstep.md) needs from a network:

```ts
interface Transport {
  readonly id: string;
  peers(): readonly string[];
  broadcast(frame: Frame): void;
  send(to: string, frame: Frame): void;
  listen(handler: FrameHandler): () => void;   // returns unsubscribe
}
```

Four verbs and an id. `FrameHandler` is `(from: string, frame: Frame) => void`.
The driver never learns whether it is talking to real browsers, a
[loopback switch](#loopbacknetwork), or a [hub port](local-hub.md).

The three implementations:

| Implementation | Used by |
|---|---|
| [`PeerMesh`](webrtc-mesh.md) | real games |
| a thin wrapper the [`Lobby`](the-lobby.md) returns | real games, so early frames are not lost |
| [`LocalHub.port()`](local-hub.md) | a page hosting a locally-seated bot |
| `LoopbackNetwork.connect()` | the test harness |

## Connection

[`Connection`](../../packages/net/src/connect.ts) is `Transport` plus `close()`:
a transport with a life, something the [lobby](the-lobby.md) opened and must
therefore be able to shut. It is what [`openConnection`](connection-refs.md)
returns.

`Transport` deliberately did **not** grow a `close`. Widening the interface that
every driver, the hub and the whole test harness are written against, for the
benefit of the two implementations the lobby happens to open, would be the wrong
way round — a loopback switch and a hub port have nothing to close, and an
optional `close?()` would put a `?.` at every call site to say so.

## LoopbackNetwork

[`LoopbackNetwork`](../../packages/net/src/transport.ts#L42) is an in-memory
switch with **explicit delivery**: nothing arrives until `flush()` is called, so
a test controls interleaving exactly and never races a timer.

- `connect(id)` returns a `Transport`; `disconnect(id)` removes it.
- Frames are **serialised through JSON on send** — a driver that accidentally
  relied on sharing an object with the sender would pass a loopback test and fail
  on the wire.
- `LoopbackOptions`: `latency` (delivery delay in flushes) and
  `drop(from, to, frame)` (packet loss on demand — used by
  [`desync.test.ts`](../../packages/net/src/test/desync.test.ts) and
  [`chat.test.ts`](../../packages/net/src/test/chat.test.ts)).
- Counters: `sent`, `delivered`, `dropped`, `pending()`.
- Frames sent by a handler *during* delivery land in the **next** flush, so a
  chain of reactions cannot starve the caller. This ordering guarantee is one the
  consensus code relies on — see [local-hub.md](local-hub.md).

The test harness ([`net/src/test/harness.ts`](../../packages/net/src/test/harness.ts))
builds a `table` of up to six `Lockstep` drivers on one `LoopbackNetwork` with a
fake clock, and `settleNetwork` pumps and flushes until the mesh is quiet.
