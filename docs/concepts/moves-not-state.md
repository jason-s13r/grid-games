# Moves, not state

The whole design falls out of one requirement: **peers exchange moves, never
board state.**

A peer never sends "here is my board", "my empire has four diamonds" or "I
captured these tiles". It sends an *intent* — a [move](../moves/the-move-record.md)
— and every peer, the sender included, derives the consequence from its own copy
of the rules. Nothing about the outcome travels.

## Why not send state

A CRDT was considered and rejected. CRDTs guarantee **convergence**, not
**correctness**: they will make every peer agree on *a* value, but they offer no
place to stand and say "that move was illegal, drop it". A territory game is
almost entirely illegal-move rejection — you cannot claim a tile you do not
border, spend population you have not accrued, or take a capital from two tiles
away — so a mechanism with nowhere to reject a move is the wrong mechanism.

Under lockstep replication a peer can only submit inputs, and every peer
validates every input against its own simulation
([`rules.ts:251`](../../packages/sim/src/rules.ts#L251)). A bad move dies
identically everywhere, with no trust and no negotiation. See
[moves/validation.md](../moves/validation.md).

## What follows from it

Nearly everything in this tree:

- **A deterministic simulation is mandatory**, not an optimisation. If two peers
  applying the same moves reached different boards, the game would have no state.
  Hence the [determinism discipline](../simulation/determinism-discipline.md):
  one RNG, integers only, no iteration-order dependence.
- **The state hash is the contract.** If agreement means "same hash", then any
  change that moves the hash breaks compatibility with peers that have not
  changed — even when no function signature changed. See
  [the-one-invariant.md](the-one-invariant.md).
- **A move asserts a decision, never a quantity.** No key, no amount, no cost, no
  result in the record — a field a peer could lie about is a field the rules
  would have to be prepared to disbelieve.
  [moves/the-move-record.md](../moves/the-move-record.md).
- **Nothing outside the simulation may enter it.** Camera, chat, signatures,
  socket state and wall-clocks are all deliberately outside the hash, because
  anything hashed has to be identical on every peer and those things are not.
  continuity/what-is-hashed.md.
- **Presence is derived, not observed.** Peers genuinely disagree about who is
  reachable over the network, so "is this seat still playing" is answered from
  signed heartbeats in the log, never
  from a socket.
- **Late joins are observers by construction.** A move needs a roster key; an
  arbitrary connection has none. peers-and-roles.md.
- **Hidden information is impossible.** Lockstep replication means every peer
  holds every byte of state, so a game of hidden information would need a
  different design. [moves/the-move-record.md](../moves/the-move-record.md).
