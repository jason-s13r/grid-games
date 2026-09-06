# Joining

Three ways a peer arrives, all through the same [`Lobby`](../mesh/the-lobby.md):

1. **At the start**, from the host's setup screen — the host composes and seals
   the [genesis](../protocol/genesis.md).
2. **Mid-game, as a reloading tab** — same identity, same seat, from
   `localStorage`.
3. **Mid-game, as a newcomer** — an [observer](../concepts/peers-and-roles.md)
   until an empire votes it a seat by [`ROSTER_AMEND`](roster-amendments.md).

## The handshake

When a connection opens, each side sends a `HELLO`
([`lobby.ts:214`](../../packages/net/src/lobby.ts#L214)) carrying `protocol`, its
`key` (absent for an observer) and a 16-byte `nonce`. In the lobby the `gameId`
is `""` — there is no game yet, and a lobby hello proves nothing beyond "here is
a key to seat me under".

The mutual challenge-response proper (`hello` / `welcome` / `proof`, each side
signing **both** nonces — [`records.ts:522`](../../packages/protocol/src/records.ts#L522))
establishes **possession of a key** and nothing more. That is enough, because
every [move](../moves/move-encoding.md) is separately signed against the real
game id anyway. `verifyHello` never replays: swap the nonces, or aim the proof at
another game or another key, and it fails.

## Getting the genesis

A mid-game joiner cannot *ask* for the genesis — until it has the record it does
not know the game id every other frame is signed against. So when a peer connects
to the [lobby](../mesh/the-lobby.md), `welcome()` immediately sends it the
`sealed` `GENESIS` frame ([`lobby.ts:161`](../../packages/net/src/lobby.ts#L161)).
**Every** peer keeps `sealed`, not just the host — by the time someone reloads,
the host may be long gone.

The `GENESIS` frame carries the **full record**, so the joiner computes the game
id itself ([genesis.md](../protocol/genesis.md)) rather than taking anyone's
word.

## Building the driver

`lobby.onStart(genesis, seat, transport)` fires. The client / headless peer
builds a `Sim`, a `Roster.fromGenesis`, and a [`Lockstep`](lockstep.md) with the
`seat` (or `undefined` for an observer). Frames that arrived during the gap are
replayed out of the lobby's `backlog`.

`Lockstep.start()` ([`lockstep.ts:336`](../../packages/net/src/lockstep.ts#L336))
then checks `targetStep() - sim.step`: if that gap is more than `RESUME_BEHIND`
(2 s), **the game began without us** and there are inputs we can never obtain —
so it enters `holdingForResume` and asks for a snapshot rather than replaying
from step 0. See [resume.md](resume.md).

## Taking a seat

A newcomer voted in by [`ROSTER_AMEND`](roster-amendments.md) receives
`onSeated`; if the seated key is its own and it had no seat,
[`seatArrivals`](../../packages/net/src/lockstep.ts#L1086) sets
`options.seat = { empire, member }` and resets `seq = 0`. From that step it is an
ordinary player. `seq` restarting is why [equivocation](equivocation.md)
detection keys on the step, not just the seq.

A reloading tab that kept its seat rejoins with move numbering restarted and
nobody accused — [`resume.test.ts`](../../packages/net/src/test/resume.test.ts)
holds it.
