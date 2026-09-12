# The socket transport

[`SocketTransport`](../../packages/net/src/socket.ts) is the client half of a
[room bus](room-bus.md): one WebSocket per room, `Transport` on the outside,
opened when a [ref](connection-refs.md) says `socket`.

Most of it is bookkeeping — `id` comes from `welcome`, `peers()` from the last
roster, `broadcast` is a frame with no `to`, `send` is one with — and it shares
`PeerMesh`'s backlog, for the same reason: the connection is open before the
lobby exists, and the genesis record arrives on the same channel as everything
after it.

Three parts are not bookkeeping.

## The outbound buffer

A data channel is reliable and ordered, and when it stops being either it is gone
and so is the peer. A WebSocket has a third state — **back, having missed
things** — and every recovery path in the driver was written when that state did
not exist.

Without a buffer, this is what a 900 ms outage costs:

1. a seat submits: [`submit`](../continuity/lockstep.md) signs, stashes the move
   locally, broadcasts it, and in its `finally` announces readiness up to the
   slot;
2. the socket is down across that broadcast. A socket in `CLOSING` or `CLOSED`
   discards a send **silently**, so both writes go nowhere;
3. everyone else blocks, because each peer waits on every seat's readiness. This
   is the part that saves it: an outage shorter than `stallTimeout` costs nothing
   *if the frames survive it*;
4. the socket comes back. The peer is blocked, so `repeatReady` re-sends the
   standing promise — but **nothing re-sends a move**;
5. the room now has the promise without the move. Everyone unblocks and simulates
   the slot without it; the sender simulates it with. One divergence, permanent;
6. at the next checkpoint the sender is a minority of one, and about twenty
   seconds later its seat is dropped by quorum.

Step 2 is the whole fault and the buffer is the whole fix: frames written while
the socket is down are held, and go out **in order** the moment `welcome` lands,
before anything else is written. The game resumes as though it had merely been
slow.

The buffer is bounded at 2 MB and an overflow is a **failure**, not a
drop-oldest. Dropping the oldest held frame is precisely the reordering the
buffer exists to prevent, and doing it silently reproduces exactly the bug it was
added to stop.

## Coming back, and what nobody replays

The transport rejoins with **the id it already holds**, so the room sees a
reconnection rather than a departure and a stranger, and the held frames land
under the name that promised them.

The buffer covers our own writes. Nothing replays what everybody else said while
we were away, which is what `onReconnect` is for: the web client and every
headless peer answer it with `requestSnapshot()`. See
[resume](../continuity/resume.md).

While the socket is down `peers()` is empty. That is the truth, and it is what
stops a resuming peer asking nobody for a snapshot.

Redials are exponential with jitter, 500 ms doubling to 30 s — a relay restarting
must not be met by every client it dropped on the same millisecond — and a
`closed` from the server is **not** redialled: a server that means "go away" and
a socket that merely fell over are different events.

## The derived roster

A room bus tells everyone who is in the room; `onJoin`/`onLeave` are what the
lobby is written against. So joins and departures are the difference between two
rosters rather than events of their own, which is also self-healing: a roster
arriving after an outage produces exactly the joins and leaves that happened
during it, with no server having to remember what we missed.
