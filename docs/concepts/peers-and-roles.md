# Peers and roles

There is one kind of participant — a **peer** — and a small number of roles it
can hold. None of the roles is a mode you configure; each falls out of the keys
a peer holds and the record it sealed.

## Peer

Any process in the mesh: a browser tab running [`apps/web`](../clients/web-client.md),
or a headless Node process ([`apps/observer`](../clients/observer.md),
[`apps/bot`](../clients/bot.md)). Every peer:

- runs a full [simulation](../simulation/README.md) of the whole game;
- independently [validates](../moves/validation.md) every move it hears;
- advances its world on [wall-clock time](time-and-steps.md);
- broadcasts a signed [checkpoint](../continuity/desync.md) hash periodically,
  and its checkpoint counts in the comparison.

What a peer cannot necessarily do is *act* — produce a move other peers accept.
That requires a key in the roster.

## Seat (member)

A **seat** is one playable slot in an empire, addressed `(empire, member)`. The
[roster](../protocol/roster.md) maps each seat to a public key. A peer that holds
the key for a seat can sign moves for it. A seat has:

- its own population timer and accrual ([gameplay/population.md](../gameplay/population.md));
- its own signing key (the keypair *is* the seat — [protocol/identity.md](../protocol/identity.md));
- its own `seq` counter for ordering moves within a step.

Three teammates in one empire are three independent seats — three click streams
into one shared territory. See [gameplay/empires-and-seats.md](../gameplay/empires-and-seats.md).

## Host

The peer that opened the room rather than joining one. In the WebRTC mesh the
host's PeerJS peer id **is** the room code
([`mesh.ts`](../../packages/net/src/mesh.ts)). The host:

- collects the people who connect and arranges them into empires and teams
  ([`Lobby.host`](../../packages/net/src/lobby.ts));
- builds the [genesis](../protocol/genesis.md) record, seals it (its hash becomes
  the game id) and broadcasts it;
- **then has no further authority.** Once the genesis is sealed the host is an
  ordinary peer. It can leave and the game continues; a peer that kept the sealed
  record re-sends it to later joiners.

Because a room code is a peer id, a game is only reachable while *some* peer is
online at a known id. That is why the [observer](../clients/observer.md) can
claim a stable id with `--as` and become the durable door back into a game whose
original host has closed their laptop.

## Observer

A peer with **no key in the roster**. This is not a setting — it is what you are
if the genesis (and every amendment since) does not list one of your keys. An
observer:

- connects, simulates, validates, hashes and [archives](../trust-and-verification/archive-format.md)
  exactly like a player;
- has its checkpoint vote counted in [desync](../continuity/desync.md) detection;
- **cannot** produce an accepted move — a move is verified against the roster
  seat it names, and an observer holds no seat.

An arbitrary mid-game join is therefore an observer by construction. There is no
mechanism to switch off and nothing to lock down. An observer can later be voted
a real seat by [`ROSTER_AMEND`](../continuity/roster-amendments.md) — which is
exactly how a [PeerBot](../gameplay/bots.md) is seated.

## SimBot

Not a peer at all. A SimBot empire is driven *inside every peer's simulation*
from the shared RNG ([`sim.ts:119`](../../packages/sim/src/sim.ts#L119)) — zero
bandwidth, cannot drop, always "present". Contrast the PeerBot, which *is* a peer
holding a seat. [gameplay/bots.md](../gameplay/bots.md).
