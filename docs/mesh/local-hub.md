# The local hub

[`LocalHub`](../../packages/net/src/hub.ts#L37) lets several
[lockstep](../continuity/lockstep.md) drivers run in **one page**, sharing one
connection to the world.

## Why it exists

A [PeerBot](../gameplay/bots.md) is a full mesh client: it holds a seat, signs
its own moves, runs its own `Lockstep`. Nothing says that client has to be in its
own browser — a team that wants night cover should be able to seat a bot from the
[lobby](the-lobby.md) and close the laptop lid on it.

The obstacle: a mesh only reaches *other* people. `broadcast` walks the open data
channels, and a driver in the same page is not on one of them — so a
locally-seated bot would sign moves that every remote peer applied and **its own
tab never heard**. The one peer guaranteed to desync would be the one hosting the
bot.

## What it does

`LocalHub` wraps the base [`Transport`](transport-interface.md) and hands out
`port()`s that look exactly like a `Transport`. A port's `broadcast`:

- goes **outward** (`base.broadcast`), and
- goes **sideways** to every sibling port.

Anything arriving from a remote peer is fanned to **every** port (a remote peer
addresses the whole page by its one mesh id and cannot reply to a particular
port; a driver that did not ask for a snapshot refuses it anyway).

The first port takes the mesh's **own id**, so a page with no bots behaves
exactly as it did before the hub existed. Sibling ids get a `~N` suffix the
broker would never mint.

The drivers stay unaware they share a page. The alternative — teaching `Lockstep`
that some seats are local — would put a special case in the middle of the
consensus code for the sake of a convenience feature.

## Delivery is queued

Frames cross the hub as **text**, exactly as across a data channel (handing the
same object to two drivers would let one mutate what the other is about to read —
a bug that passes every local test and appears only on the wire).

Delivery is **queued, then drained** ([`drain`, hub.ts:117](../../packages/net/src/hub.ts#L117)),
not delivered inline: a handler that sends while handling appends to the end of
the queue instead of recursing into a second delivery halfway through the first.
That is the same ordering guarantee a real channel gives for free, and one the
consensus code relies on — draining after each recipient would let one port's
reply overtake another port's copy of the original broadcast.

[`hub.test.ts`](../../packages/net/src/test/hub.test.ts) covers the sideways
fan-out, "one delivery finishes before the next", and "a bot seated in someone
else's page plays its seat and stays in step".
