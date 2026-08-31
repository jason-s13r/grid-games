# Changelog

## net@0.2.0 (2026-08-31)

### Features

- lockstep driver, loopback mesh and consensus drops
  Peers exchange inputs and nothing else. A step is not simulated until
  every seat that could contribute to it has signed a cumulative "I am
  done through step N", which replaces a PASS per seat per step.

  The hard part was the stall. A silent peer freezes the game, and no
  local timeout can unfreeze it: two peers whose stopwatches disagree
  resume on different steps, which is a desync invented to fix a stall.
  Liveness-from-the-log cannot break it either, since the log is what the
  stall has frozen. So the timeout only decides when to *propose*, and
  what a drop does is fixed by the record: a quorum signs one Drop naming
  the exact step, each seat endorses at most one record per target, and
  two records naming different steps therefore cannot both reach a
  majority. Equivocation ejects the same way, on a step derived from the
  proof rather than from when a peer happened to see it.

  The 42-check harness runs six drivers over a loopback that serialises
  every frame as a data channel would, and it earned its keep: peers may
  legitimately run inputDelay steps ahead of a sender, which put a valid
  move on the same number as the receiver's next step and had it dropped
  as late — a desync manufactured by the check meant to catch one.

### Fixes

- give createMesh a deadline of its own
  A broker that answers slowly is indistinguishable from one that never
  answers, and PeerJS reports neither — it retries quietly. The open
  promise therefore never settled and the caller waited forever. It now
  rejects at 12s and destroys the peer, which PeerJS would otherwise keep
  retrying for the life of the page.

### Dependencies

- protocol: 0.1.0 -> 0.2.0
