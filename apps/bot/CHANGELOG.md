# Changelog

## bot@0.1.0 (2026-09-04)

### Features

- the headless bot speaks the same vocabulary
  A profile is how a game says what a bot is like, and there was no reason for
  the two kinds of bot to be configured out of different words. PeerBot takes
  one: under `--play cycle` it runs the phases the profile declares at the tempo
  each asks for, so "quick to expand and slow to attack" means the same thing
  whichever kind of bot is playing. `--level` picks which cycle.

  What a headless bot cannot pick is its ceiling. popMax is hashed state, set by
  whoever seated it, so a bot may choose to play weakly and may not choose to
  play strongly. Additive on both sides.

- pick how hard the bots play
  The difficulty a game is composed with has to be chosen somewhere, and every
  surface that composes a game now offers it, writing it into the genesis record
  with everything else so a replay plays the same bots. HostPlan gains an
  optional level; nothing here is a break.

- a bot you can tell how to play
  --attack was the whole configuration surface, so a seat could be covered but
  only in one style, at one speed, around the clock. Five flags now, each a
  question a team covering a night shift has an opinion about: --play picks the
  posture, --target says whose ground to walk at by name or nearest or in
  rotation, --rate is how long it banks between claims, and --hours and --duty
  keep it to a shift.

  Those last two are the balance lever. A seat that never sleeps has reflexes
  nobody can match by staying awake, and a resting bot is still a connected peer
  — it heartbeats, it promises readiness, it banks rather than spends. Resting
  must not cost the empire the seat, which is what the new tests are pointed at.

  What a bot cannot configure is what it costs. Accrual and cap are hashed state
  in the genesis record, so the host prices the seat and the bot only decides how
  to play it. policy() takes an optional focus; a SimBot passes none, so the draw
  order is unchanged and the hash does not move.

- peers that outlive a browser tab
  An observer has worked in the browser since Phase C, but close the tab and the
  game's history goes with it, and a mesh with nobody awake in it has stopped.

  @tessera/headless is the runtime, and it is thin because everything below the
  lobby already ran under Node. What was missing: a WebRTC implementation, since
  PeerJS reaches for RTCPeerConnection as a global and cannot be handed one; a
  key in a file rather than in localStorage; a pump on a timer; and an
  append-only archive, because rewriting a multi-day log on every claim is not a
  plan.

  apps/observer follows a game and writes it down, holds the room open at a
  stable id with `--as`, exports a directory into the single file replay reads,
  and verifies one end to end. apps/bot is night cover with a process around it,
  seated by ROSTER_AMEND like any substitute — from the mesh's side it is a
  player who happens never to sleep.

  Verified over the public broker: 713 steps followed, archived, and read back.

### Dependencies

- sim: 1.1.0 -> 2.0.0
- net: 0.6.0 -> 0.7.0
- protocol: 0.4.0 -> 0.5.0
- headless: 0.0.0 -> 0.1.0
