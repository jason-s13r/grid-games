# Changelog

## observer@0.1.0 (2026-09-04)

### Features

- the table, and what it refuses to count
  Every input a leaderboard needs has existed since the archive shipped, and
  nothing gathered the files into a table. rankArchives is that, and the
  interesting half is refusal rather than arithmetic.

  A game counts only once it has survived verifyArchive, so an edited log
  contributes nothing rather than something slightly wrong. A fragment counts not
  at all, however genuine its signatures, because the stats depend on the part
  that is missing. And a game counts once however many observers archived it,
  since two observers on one game is how an archive is kept safe. A refusal names
  the file by its position in the pile, because two archives of one game share a
  game id and which was the duplicate is the point of saying so.

  The table is built on the member key, which is the only identity this game has.
  Ordering is wins, then tiles taken, then the best single move — plain counts and
  a plain sort, because a table nobody can explain gives back what the signatures
  were for. `tessera-observe rank <dir>` prints it, refusals included.

  Verdict gains winner and summary, which verification was already computing and
  throwing away.

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
