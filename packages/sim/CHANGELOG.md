# Changelog

## sim@1.1.0 (2026-09-02)

### Features

- replay a recorded game, not just a seed
  The replay tool could only play a fresh seeded game, which checks the
  world's own machinery — events, bots, decay — and none of the move
  path. It now reads a recorded game and prints the hash that log arrives
  at, which is the number two engines have to agree on.

  Recording needs a source of moves that is not the shared stream, so
  --record decides the human empire's moves from a side rng, exactly as a
  PeerBot does. Bot empires derive theirs from the seed and leave nothing
  in the log. Replaying the fixture without applying its moves reaches a
  different hash, so the log is load-bearing rather than decorative.

  A log stops at a step, not at its last move: coins spawn and territory
  decays long after anybody last clicked, so the recorded step count is
  what replay targets.

  Lockstep gains onApplied, which is where a recorded log comes from — it
  reports each step with the inputs that made it, and keeps the signed
  envelopes so an archive can re-verify a log rather than believe it.

  Also fixes the argument parsing, which read argv[3] and argv[4]: every
  seed anyone ever passed on the command line was silently ignored and
  the step count taken as the seed.


## sim@1.0.0 (2026-09-01)

### Breaking Changes

- raise the protocol to 2
  Every rule change in this release moves the state hash. A peer refuses a
  genesis whose major it does not share, so a v1 and a v2 client decline
  each other at the lobby instead of desyncing hours in.

### Features

- march and growth as standing modifiers
  Two permanent upgrades, six diamonds each, inherited with a captured
  capital. March claims two tiles out and fills the tile between from the
  same spend; growth adds population to every tile the capital reaches, on
  every upkeep pass — it scales with tile count, so it compounds over a
  long game. Snapshot layout 1 to 2.

- coins spawn faster and near the fighting
  Interval 4-10s to 1.5-4s, diamonds weighted roughly double, and most
  spawns land just outside somebody's border instead of uniformly across
  the map.

- taking a capital annexes the empire behind it
  Its tiles, population and unspent stock go to the attacker rather than
  sitting on the board as an ownerless rump. CAPITAL elimination only.

- territory cut off from its capital decays
  A tile the capital cannot reach loses an eighth of its population per
  upkeep pass and goes neutral at zero, so cutting a supply line is worth
  something on its own.

- rivers can be forded, and capitals start on the mainland
  Rivers get passable gaps, so one is a detour rather than a wall.
  Capitals are placed only on the largest connected region, so no empire
  starts sealed in a pocket it cannot leave.


## sim@0.2.0 (2026-08-31)

### Features

- add the deterministic simulation core
  Peers exchange moves, never board state, so every peer must produce
  bit-identical state from the same seed and move log. That single property
  also gives deterministic bots, and it is why this lands before any
  networking: lockstep is undebuggable on a simulation that is not already
  deterministic.

  Four flat typed-array layers (owner, pop, terrain, item) replace the
  prototype's signed-integer cells, which is what unlocks N empires and
  leaves room for terrain and items on the same tile. Ownership moves out
  of the sign of pop into its own layer.

  An empire is a set of member seats rather than a player: timers accrue
  per member over shared territory, so three teammates make three
  independent click streams and simultaneous fronts, and a shift handover
  needs no mechanism at all.

  Mechanics: coin claims over von Neumann balls of 5/13/25 tiles, cascades
  that create population rather than dividing it, the 1..4 surround
  multiplier (the old getNeighbours conflated self with neighbours and so
  scored 5), impassable terrain with bought bridges and ladders, and capital
  protection that lifts on tiles or time, whichever lands first.

  The world runs on wall-clock time, so world updates are scheduled events
  rather than per-tile scans; six offline hours catch up in ~160ms instead
  of sweeping the map 260,000 times.

  Liveness is derived from signed heartbeats in the log, never from socket
  state: peers disagree about who is reachable, so reading presence from
  connections would have two peers computing different winners.

  hash(state) = fnv1a(snapshot(state)) — one canonical serialisation drives
  both the consensus check and the content address of a checkpoint, so a
  snapshot from an untrusted peer can be verified before it is restored.

  Verified by 46 headless checks covering the rules, determinism, snapshot
  round-trips and fast-forward equivalence.
