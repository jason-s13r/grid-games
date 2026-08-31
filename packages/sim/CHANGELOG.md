# Changelog

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
