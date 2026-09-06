# Glossary

Terms used throughout these docs, with the file that defines each.

### peer
Any participant in the mesh — a browser tab or a headless Node process. A peer
runs a full simulation and validates every move. Whether it can *act* depends on
whether one of its keys is in the roster. See
[concepts/peers-and-roles.md](concepts/peers-and-roles.md).

### host
The peer that created the room. Its PeerJS peer id **is** the room code. It
composes and seals the genesis record, then has no further authority — once the
game is sealed the host is an ordinary peer. See [mesh/the-lobby.md](mesh/the-lobby.md).

### observer
A peer with no key in the roster. It connects, validates, hashes and archives
like everyone else, and its checkpoint vote counts — it simply cannot produce an
accepted move. An arbitrary mid-game join is an observer **by construction**.

### empire
A colour on the board and a set of seats sharing its territory. `1..N`; `0` is
neutral ground. An empire is **not** a player —
[gameplay/empires-and-seats.md](gameplay/empires-and-seats.md).
[`Empire`](../packages/sim/src/types.ts#L261).

### seat / member
One playable slot in an empire, addressed as `(empire, member)`. A seat has its
own population timer and its own key. `member` is an index into the empire's
member list. [`Member`](../packages/sim/src/types.ts#L247).

### control
Who drives an empire: `HUMAN` (its seats are played by people or PeerBots) or
`SIMBOT` (the simulation itself drives it). [`CONTROL`](../packages/sim/src/types.ts#L51).

### move
The only thing that mutates hashed state. A signed assertion of an *intent*
bound to a step: `(step, empire, member, seq, type, x, y)`. Also — misnomer
noted — the vocabulary of eleven *actions*, most of which are not spatial.
[moves/the-move-record.md](moves/the-move-record.md).

### step
The unit of simulated time. `STEPS_PER_SECOND = 12`
([`constants.ts:39`](../packages/sim/src/constants.ts#L39)). The current step is
derived from wall-clock time since genesis, not counted by a timer.
[concepts/time-and-steps.md](concepts/time-and-steps.md).

### genesis
The record every hash derives from: protocol version, seed, start time, map
config, rules, and the empire/seat composition. Its SHA-256 hash is the
**game id**. [protocol/genesis.md](protocol/genesis.md).

### roster
The mapping from `(empire, member)` seat to public key. Built from the genesis,
mutated only by `ROSTER_AMEND`. [protocol/roster.md](protocol/roster.md).

### quorum
`floor(n / 2) + 1` of an empire's keyed seats. Endorses roster amendments; a
majority of *all other* seats endorses a drop. [protocol/roster.md](protocol/roster.md).

### snapshot
The single canonical byte serialisation of simulation state
([`state.ts:114`](../packages/sim/src/state.ts#L114)). Everything hashable is in
it; nothing else exists.

### hash
`fnv1a(snapshot(state))` — a uint32. Two peers with the same hash agree on every
byte. [concepts/the-one-invariant.md](concepts/the-one-invariant.md).

### checkpoint
A signed message: "at step S my state hashed to H". Broadcast every
`checkpointInterval`. Disagreement is a desync. [continuity/desync.md](continuity/desync.md).

### desync
Two peers reaching different hashes for the same step. Detected by checkpoint
comparison; the minority rebuilds from a snapshot.

### equivocation
One seat signing two different moves for the same `(empire, member, step, seq)`.
Cryptographic proof of cheating; the seat is ejected at a step derived from the
proof. [continuity/equivocation.md](continuity/equivocation.md).

### lockstep
The driver that turns "moves in" into "agreed state hashes out": it will not
simulate a step until every seat that could contribute to it has said it will
not. [continuity/lockstep.md](continuity/lockstep.md).

### readiness
A signed cumulative assertion, "I will send nothing more at or before step N".
Replaces a per-seat per-step `PASS`.

### SimBot vs PeerBot
A **SimBot** empire is driven inside every peer's simulation from the shared RNG,
at zero bandwidth. A **PeerBot** is a program holding one real seat in a human
empire, signing and broadcasting moves like a person.
[gameplay/bots.md](gameplay/bots.md).

### archive
The durable record of a game: genesis, every applied move (signed), amendments,
messages, the step reached and the final hash — in the exact format
`pnpm replay --log` reads. [trust-and-verification/archive-format.md](trust-and-verification/archive-format.md).
