# Changelog

## net@0.3.0 (2026-09-01)

### Features

- a bot that plays a seat rather than an empire
  The SimBot runs inside every peer's simulation, drives a whole empire
  and costs no bandwidth — which is why it must be perfectly deterministic
  and can never be told anything. A PeerBot is the other half of that
  table: its own mesh client, holding one member seat in a human empire,
  signing and broadcasting a move like any other player.

  That is what a marathon game needs. A team can sleep and still hold its
  ground, because the covered seat keeps answering: it heartbeats, it
  promises readiness, and so it never blocks the teammates still playing.

  The price is charged by the rules and not here. A BOT member accrues at
  half rate, caps at 499 rather than 999, and its coin claims fire without
  triggering the coins they land on — all keyed on the member's kind, so a
  bot seat inside a human empire is charged exactly as one inside a SimBot
  empire. A bot holds the line; it cannot execute the big farming play,
  which leaves cascade mastery as the human skill.

  Its randomness is deliberately its own. A SimBot draws from the shared
  seeded stream because every peer re-derives its moves; a PeerBot's moves
  are validated rather than derived, so touching that stream would move
  the RNG on one peer and nowhere else — the quietest possible desync.
  There is a check for exactly that.

- resume a game that started without us
  A peer joining a game already in progress used to start at step 0 and grind
  upward — minutes of simulating a state any peer could hand over in one
  message, and minutes of broadcasting checkpoints that disagreed with all of
  them. Now start() compares wall-clock time to its own step, and if the game
  began more than ten seconds ago it asks for a snapshot and holds the
  simulation until one arrives or the wait runs out.

  A snapshot request is answered from the present, not from the archive. A
  stored snapshot is only useful to someone who also holds every move between
  it and now, and a peer that has just arrived holds none of them — they were
  broadcast before it was listening. So the reply is the responder's current
  state plus the moves it still has pending for the steps after it, sent to
  the asker alone. Together those are the whole game.

  That in turn needs three things that were not true before:

    * A move can now arrive twice, so a pending slot is claimed once. Applying
      one move twice is a desync.
    * A snapshot behind us is ignored unless we asked for one, or helping
      somebody else recover would rewind a peer that is perfectly healthy.
    * Frames larger than 15 kB are sliced. PeerJS chunks binary payloads but
      refuses oversized JSON ones outright — "Message too big for JSON
      channel", raised on the sender, frame silently never delivered. A
      snapshot of a 160x112 map is around 170 kB, so every resume over a real
      data channel was failing on this.

  And one plain bug it uncovered: a DataConnection error was treated as a
  departure. A refused message leaves the channel perfectly usable, so that
  dropped a peer who was still there and still playing. Errors are now
  reported; only close forgets.

  The loopback harness gains a scenario for the whole path: a peer arrives 15
  seconds late, is handed the present rather than the newest stored snapshot,
  lands on the table's state, and leaves the table still agreeing with itself
  — which is what proves the re-sent moves applied exactly once.

### Fixes

- repeat a standing readiness promise
  Three players, and the game never starts. Two of them sit at step zero
  waiting on each other while the host runs three steps ahead and waits on
  both. Nothing recovers it but the stall timer, fifteen seconds later,
  ejecting a seat that was never absent.

  A full mesh takes a second hop to form. Two peers who join a host at the
  same moment are talking to the host well before their channel to each
  other opens — and readiness was announced exactly once, at the moment it
  advanced. Each had therefore made its promise before the other could
  hear it, and neither would ever say it again: announceReady only speaks
  when it has something new to say, and a blocked peer is not advancing,
  so it never does.

  A blocked peer now repeats the promise it is already standing on, once a
  second. A READY is cumulative and idempotent, so repeating one costs a
  signature and nothing else — and blocked is both the situation where it
  matters and the situation where it is free, since a peer that is waiting
  has nothing else to spend bandwidth on. It also covers a READY simply
  lost in flight, which nothing else did.

- make a reload rejoin the game it left
  Three faults, each of which alone was enough to leave a returning player
  permanently desynced. None was reachable from the loopback harness, so
  all three had to be found in a browser first; each now has a check that
  would have caught it.

  Reassembly rebuilt a sliced frame from its first slice. `new Array(n)`
  is sparse, and every iteration method skips holes, so the completeness
  test visited only the slices that had arrived, found none of them
  undefined, and handed on a truncated frame after the very first one.
  Every snapshot on the wire was silently discarded. A fake PeerJS with a
  16300-byte ceiling now exercises the path the loopback cannot.

  Resume was gated on being ten seconds behind. The gap is not a
  performance question, it is a correctness one: nobody sent moves to a
  client that was not connected, so a peer behind by more than a round
  trip is missing inputs it can never obtain, and replaying up from step
  zero derives a state that agrees with nobody. Two seconds, and only when
  there is a peer there to answer.

  Readiness went stale. Submitting a move holds the promise below the
  move's slot until the signature is out, and the world does not stop for
  signing — so a peer can overrun the ceiling and have every announcement
  capped away. It then blocks whoever is waiting on it, who stops
  announcing in turn, and two peers wait on each other until the stall
  timer ejects one of them for a fault it did not have. Renew the promise
  when the ceiling lifts, and again before settling in to wait.

### Dependencies

- protocol: 0.2.0 -> 0.3.0


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
