# Changelog

## net@0.6.0 (2026-09-02)

### Features

- drop a peer that will not come back
  Divergence was detected and reported and then nothing happened. A peer
  whose state has drifted validates against a world nobody else is in and
  contributes noise for the rest of the game; the plan's rule is that it
  rebuilds from a checkpoint and is dropped if it still disagrees.

  The obvious objection is that a desync has no proof behind it. Two
  peers cannot see each other's memory and neither can prove the other
  wrong, so nobody acts alone: the drop goes through the same
  majority-endorsed record a stall does, and a peer only proposes one
  while it is in the agreeing majority itself. A peer that disagrees with
  everybody is likelier to be the broken one than everybody is, so from
  the minority it rebuilds and says nothing. Detection is symmetric;
  escalation deliberately is not.

  Three checkpoints of tolerance, which is two chances to recover: the
  first says something is wrong and a rebuild lands well inside the
  second. Agreeing again clears the count, because a peer that rebuilt is
  not a cheat. Proposals stagger by seat the way a stall's do, or two
  naming different steps could each fall short of a majority and leave
  the seat neither dropped nor trusted.

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

### Fixes

- stop deleting the TURN relays PeerJS provides
  PeerJS ships a STUN server and two TURN relays and uses them unless it
  is handed a config of its own. That option is merged one level deep, so
  the config this package passed did not add a STUN server to the
  defaults — it replaced the lot, relays included.

  The effect was invisible to anyone whose NAT did not need a relay, and
  total for the roughly one pair in five behind symmetric NAT: signalling
  succeeded, the room code worked, and the data channel simply never
  opened. The plan's "one unavoidable server" turned out to be a server
  we already had and were throwing away.

  Config is now sent only when a caller asks for one, which is still how
  you point the mesh at a coturn you run rather than someone else's free
  tier. The relay never had authority either way: every move across it is
  signed and every state hash-verified.

### Dependencies

- sim: 1.0.0 -> 1.1.0


## net@0.5.0 (2026-09-01)

### Features

- the night shift only defends
  A PeerBot covering a sleeping seat reinforces the thinnest contested
  tile and nothing else: no expanding, no coin grabs, and it banks its
  population when there is no line to hold.

### Dependencies

- sim: 0.2.0 -> 1.0.0


## net@0.4.0 (2026-09-01)

### Features

- seat a substitute mid-game
  A marathon game outlives its roster. ROSTER_AMEND existed in the protocol
  and in the simulation but nothing drove it; the driver now proposes,
  collects endorsements, and seats the newcomer.

  Endorsing is deliberate, unlike endorsing a drop. A drop is an
  observation — the seat did go silent, and any peer can see it — but an
  amendment is a decision about who joins the team, and teammates share
  territory, so a peer that signed whatever reached it would turn a quorum
  into a formality. onInvitation announces the ask; endorse() answers it.

  The hard part is that the new seat is hashed state: every peer must append
  it on exactly the same step, or peers agreeing about every move still
  disagree about the world. So a proposal is dated three seconds ahead and
  readiness is held below that step while the vote is out. The hold is
  released on a step number rather than a stopwatch — every peer gives up on
  the same step, so giving up cannot itself become the thing peers disagree
  about. A quorum that arrives after its step is a known divergence, and the
  driver rebuilds from a checkpoint rather than carrying on.

  A record with no valid signature is never stored, gossiped, or allowed to
  hold a step: otherwise anyone able to open a data channel could stop the
  game by broadcasting noise.

- let one page run several drivers
  A PeerBot is a full mesh client, and until now that meant a whole extra
  browser tab: a mesh only reaches other people, so a bot seated beside its
  teammate would sign moves that every remote peer applied and its own page
  never heard. The one peer guaranteed to desync was the one hosting the bot.

  LocalHub is the missing loop-back. It hands out ports that look exactly
  like a Transport, sends what they broadcast both outward and sideways, and
  fans anything arriving from a remote peer to every port. Drivers stay
  unaware they share a page — the alternative, teaching Lockstep that some
  seats are local, would put a special case in the middle of the consensus
  code for the sake of a convenience feature.

  Frames cross it as text, as they cross a data channel, and a fan-out is
  queued whole before any of it is delivered: draining after each recipient
  would let the first one's reply overtake the second one's copy of the
  original, and two drivers in one page would see one broadcast in two
  different orders.

### Fixes

- rebuild the roster, not just the state, from a snapshot
  Re-applies the amendments and drops behind a snapshot in order, verifying
  each quorum against the roster as it stood at the time — an empire's quorum
  grows as the empire does, so replaying in order is what reconstructs the
  roster each record was signed against. Anything that fails to check out
  stops the walk rather than being skipped: the records after it were
  verified against a roster this peer would no longer be reproducing.

  Also makes an arriving peer patient rather than persistent. It now waits
  out a mesh that has not finished forming — the first request for the world
  is the one most likely to go out to nobody, because a joiner is routinely
  playing before its channels have opened — and asks again while it waits.
  Giving up meant replaying from step zero, which derives a state that agrees
  with nobody, since the moves that built the real one were broadcast before
  this peer was listening.

  An earlier attempt at that asked for a snapshot whenever a peer was blocked
  and behind the wall clock. That is what ordinary waiting looks like, so
  three browsers spent a game rewinding into each other's snapshots: hundreds
  of moves arriving for steps already simulated, and hashes that agreed only
  by coincidence. Waiting is not the same as being lost.

### Dependencies

- protocol: 0.3.0 -> 0.4.0


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
