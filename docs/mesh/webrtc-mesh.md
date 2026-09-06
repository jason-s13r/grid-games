# The WebRTC mesh

[`PeerMesh`](../../packages/net/src/mesh.ts#L129) is the real
[transport](transport-interface.md): a **full mesh** of WebRTC data channels,
introduced by PeerJS's public broker.

## The broker is signalling and nothing else

It hands two browsers each other's connection details and then has no part in the
game — it never sees a move, cannot alter one, and can be swapped for any other
broker without the game noticing. That is what "serverless" means here: **zero
authority servers**.

`createMesh(options)` ([`mesh.ts:105`](../../packages/net/src/mesh.ts#L105))
loads PeerJS **on demand** (a browser library; a static import would drag it into
every consumer of the package, and a solo game would download it for nothing) and
resolves once the broker assigns an id. `DEFAULT_OPEN_TIMEOUT_MS = 12000` — a
broker that answers slowly is indistinguishable from one that never answers, and
PeerJS retries quietly, so without a deadline the promise never settles.

## Host and room code

The peer that omits `join` is the **host**. Its id is a
`roomCode(prefix)` ([`mesh.ts:91`](../../packages/net/src/mesh.ts#L91)) built
from `ROOM_ALPHABET` (`abcdefghjkmnpqrstuvwxyz23456789` — no look-alikes), and
**that id is the room code**. Joiners pass `join: <hostId>` and `dial()` the host
when their connection opens. An `id` option lets a peer claim a *specific* id —
used by the [observer](../clients/observer.md) so a game stays reachable after
the host leaves.

## Star → full mesh

On each connection open, a peer sends the newcomer a `{ k: "p", ids: [...] }`
envelope listing everyone it knows. Every peer gossips the same way, and
[`dial`](../../packages/net/src/mesh.ts#L224) is **idempotent and skips self**, so
a star of connections through the host becomes a full mesh. Six peers = fifteen
channels, no relay in the middle.

## Envelopes

Mesh housekeeping is kept in its own envelope so it can never be confused with a
game frame ([`mesh.ts:39`](../../packages/net/src/mesh.ts#L39)):

| `k` | Carries |
|---|---|
| `f` | one game [`Frame`](../protocol/the-wire.md), JSON-encoded |
| `p` | the peer list that turns a star into a mesh |
| `c` | one slice of an oversized frame |

## Chunking

PeerJS refuses an oversized JSON message **on the sender, silently** ("Message
too big for JSON channel", ceiling ~16300 bytes). A snapshot of a 160×112 map is
~170 kB of base64, so frames over `MAX_SLICE` (15000, leaving room for the
envelope JSON) are sliced into `c` envelopes and
[`reassemble`](../../packages/net/src/mesh.ts#L307)d.

Everything in a slice is attacker-controlled, so every field is checked, the
array is **filled** not merely sized (a sparse array's holes are skipped by
iteration, so a truncated frame would pass the completeness check), a second
slice claiming a different total drops the whole message, and partials are
bounded to `MAX_PARTIALS_PER_PEER` (4) — a hostile peer cannot exhaust memory
with reassemblies it never finishes.
[`chunking.test.ts`](../../packages/net/src/test/chunking.test.ts) holds it.

## TURN

Roughly **one peer pair in five** sits behind symmetric NAT and cannot form a
direct connection without a relay. PeerJS ships relays and uses them unless told
otherwise, so the default path is covered. A relay holds **no authority** — every
move through it is signed and every state hash-verified, so a hostile relay can
drop packets but cannot forge or alter a single move. "Serverless" survives a
relay intact.

`iceServers` **replaces** PeerJS's defaults rather than adding to them — its
`config` is merged one level deep, so passing one wipes the TURN entries. This
package did exactly that for several versions and quietly broke symmetric-NAT
pairs. So `config` is now sent **only when a caller actually asks** for a relay.
[`ice.test.ts`](../../packages/net/src/test/ice.test.ts) pins it.

## Lifecycle notes

- `adopt(connection)` wires `open` / `data` / `close` / `error`. An **error is
  not a departure** — a refused oversized message leaves the channel usable, and
  forgetting the peer over it would drop someone still playing.
- `backlog` (bounded 4096) holds frames that arrive before anyone calls `listen`
  — a joiner cannot build its driver until the [genesis frame](the-lobby.md)
  turns up, and that shares the channel with everything after it.
- `close()` closes every channel and destroys the peer.
