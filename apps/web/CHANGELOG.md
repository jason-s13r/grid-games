# Changelog

## web@0.8.0 (2026-09-02)

### Features

- stop reading someone
  Clicking a name mutes that seat and takes their lines down with it; a
  bar under the log lists who is muted and is the only way back, since
  what it hid is gone. Muting resets when the game does, because empire 2
  seat 1 is a different person next time.

  It is local view state and deliberately nothing else — no log entry, no
  record type, nothing to agree on. Two peers who disagree about who is
  worth listening to still hold identical state. A version of this that
  had to be agreed would be a rule about who may speak, which is a much
  worse feature wearing the same word.

### Dependencies

- sim: 1.0.0 -> 1.1.0
- net: 0.5.0 -> 0.6.0


## web@0.7.0 (2026-09-02)

### Features

- the setup screen links to the original prototype
  It carries the Empire Attack credit too, which had nowhere else to live
  once the landing page went.

- a sidebar layout, and a board with no modes
  Clicking a river places a bridge, a wall places a ladder, and a tile two
  out marches. The terrain decides, so nothing needs arming first — and a
  mode left armed over an empty stock can no longer swallow every later
  click in silence. Bought modifiers leave the shop and show on the HUD.

  Empire status moves to the top bar. Map, standings and seats collapse in
  a left sidebar; chat gets a right one, and only in a mesh game. The shop
  is a drawer off the top bar. The board holds 4:3 on desktop and fills the
  stage on a phone.

  Lobby and setup are their own screen, with solo options on it. "Menu"
  said nothing about what it did and is now "Leave", which leaves.

  Pause stayed disabled for every solo game after a mesh one; it is derived
  from the driver now.


## web@0.6.0 (2026-09-01)

### Features

- an upgrades panel, and march as a click mode
  March and growth get their own section rather than sitting in the shop
  beside the consumables. Marching arms the board like a bridge does, but
  stays armed, since nothing is spent.

### Fixes

- a placed bridge no longer locks the board
  Placing left the board armed with an empty stock, so every later click
  was a failing PLACE_BRIDGE and the player could never claim again. A
  placement disarms; so does Escape.

### Dependencies

- sim: 0.2.0 -> 1.0.0
- net: 0.4.0 -> 0.5.0


## web@0.5.0 (2026-09-01)

### Features

- join a game already in progress
  A peer whose key is not in the roster used to be turned away. It now
  watches: it validates and stores the game exactly as a player does and
  simply holds nothing, which is why an uninvited peer was always harmless
  without needing any mechanism to keep it out.

  From there it can be voted in. Anyone seated sees who is watching and can
  offer a seat on their empire; their teammates see the ask with its tally
  and agree to it; the moment the quorum lands, the observer is holding a
  seat and playing. The panel that already shows the room code carries all
  of it, because "who is playing" is one question and a marathon game
  changes its answer while you watch.

  The board no longer assumes a seat, either — empire 0 is neutral, so an
  observer highlights nothing and owns nothing, rather than reading past the
  end of the empire list.

  Verified in three browsers over a real broker: C joined a game in progress
  as an observer, A offered a seat, B agreed, and C was seated as member 2 of
  empire 1 with all three peers on the same hash and no late moves.

- seat a bot for the night shift
  The lobby can now add bot seats to an empire. The host mints a keypair per
  seat, writes it into the genesis as an ordinary keyed member, and runs its
  driver behind the same connection as its own — every other peer sees a
  normal seat in the roster and validates its moves like anyone else's.

  The price is charged by the rules rather than by the lobby: a bot member
  accrues at half rate, caps lower, and its coin claims never chain. It can
  hold the line; the big cascade stays a human play. Three per empire, so
  "add bots" is not a way to out-populate the table.

  Its key is not persisted and never leaves the page, which is the honest
  behaviour — a bot exists because the host offered to run it, so closing
  that tab stops it, and the empire idles exactly as it does when a person
  walks away.

  Verified in two browsers over a real broker: at step 25 the human seat held
  25 population and the bot 12, the bot spent its timer unprompted and took
  its empire from four tiles to seven while nobody clicked, and both peers
  agreed on the same hash throughout.

### Dependencies

- net: 0.3.0 -> 0.4.0
- protocol: 0.3.0 -> 0.4.0


## web@0.4.0 (2026-09-01)

### Features

- put people on the same empire
  Until now the lobby handed every player their own empire, one member
  each — so the thing the whole design exists for could not be set up. An
  empire is a set of seats sharing territory with a population timer each,
  which is what makes three people on one empire meaningfully stronger
  than one, and what makes shift rotation need no handover mechanism at
  all: the incoming player simply has their own timer.

  The host arranges it, because the host is the one composing the genesis
  record. That is not authority — once the record is sealed and broadcast,
  every peer verifies it independently and the host has no further say in
  anything.

  The picker offers exactly one empire beyond those in use, so there is
  always somewhere to move a player to and never a list of empty choices.
  Assignments are compacted on every read: a host who puts everyone on
  empire 3 has made one empire, not four, and the colour beside a name has
  to be the colour that player will actually hold.

  Players are identified by eight hex characters of their key's digest.
  The peer id would have been free, but it belongs to the connection
  rather than the person, and it changes on reload.

  The composition and the validation moved to src/net/teams.ts, away from
  both the panel that renders them and the lobby that seals them. They are
  the only logic in the app that is neither DOM nor network, and a mistake
  in either would stay invisible until a game started with the wrong
  people on the wrong side. They are now the app's first tests.

- hand a mid-game arrival the genesis record
  A peer that connects after the game has started cannot ask for the genesis,
  because until it has one it does not know the game id every other frame is
  signed against. So every peer now keeps the record it agreed to play and
  offers it to anyone who turns up later — every peer and not only the host,
  because by the time someone reloads the host may be long gone.

  Also exposes the live driver and lobby on window.tessera. The state that
  decides whether a rejoin is working is all private to Lockstep, and reading
  it from a browser test beats inferring it from the step counter.

- say something to the other peers
  The chat records have been in the protocol since the mesh landed — signed,
  ordered, verified against the roster and deliberately left out of the state
  hash — but nothing in the browser could send or show one. This is the panel.

  Chat goes straight to the Lockstep driver rather than through Driver: a solo
  game has nobody to talk to, so there is nothing for LocalGame to implement
  and no reason to widen the interface for it. The box says as much until a
  game exists, instead of quietly swallowing what someone types.

  Every body on the wire is another player's text, so lines are built with
  textContent and never innerHTML. A signature proves who wrote a message, not
  that it is safe to hand to a parser.

  Stamps come from the step number rather than the local clock, because the
  step is the one reading every peer already agrees on.

  Verified with two browser contexts over the public broker: both directions
  delivered, `<b>` arrived as characters rather than markup, emoji survived the
  round trip, and the two peers still agreed on step and hash afterwards —
  which is the point of chat being outside consensus.

### Fixes

- let a status note lapse
  A note is news, not state. A peer that resumed from a snapshot repairs
  the disagreement that prompted it within a step or two, but the notice
  stayed up for the rest of the game, telling every player the game was
  broken long after it was fine. Everything but a halt now expires after
  twelve seconds of game time; a halt is permanent because a halt is still
  true a minute later.

### Dependencies

- net: 0.2.0 -> 0.3.0
- protocol: 0.2.0 -> 0.3.0


## web@0.3.0 (2026-08-31)

### Features

- host and join a mesh game from the browser
  Closes the Phase C milestone: two tabs, WebRTC between them, matching
  state hashes. Verified end to end — hosted from one context, joined by
  room code from another, both empires claiming tiles, agreeing on step
  and hash the whole way.

  PeerJS is loaded on demand rather than imported, so it lands in its own
  bundle and a solo game never downloads it — and, more to the point, the
  lockstep driver stays runnable under Node for the harness. Parcel would
  not resolve an exports subpath, which is what a static import would have
  needed.

  The lobby owns the mesh's only listener. A joiner cannot build its
  driver until the genesis record arrives, and game frames share that
  channel, so anything landing in the gap is buffered and replayed once
  the driver exists. Local play and mesh play now meet a shared Driver
  interface: the view never learns which one it has.

### Fixes

- give every lobby dead end an exit
  A joiner that reached the broker but never reached the host sat on a
  screen saying everything was fine. Reaching the broker is not reaching
  the host: roughly one peer pair in five is behind symmetric NAT and the
  channel simply never opens, with no error to report.

    * No channel to the host after 15s names the three possible causes.
    * peer-unavailable and broker errors are named rather than shown as
      whatever string PeerJS produced.
    * begin() dropped a failed open on the floor, leaving the panel
      looking like the click did nothing.

  Every state now has a way back: Back, Leave, or Cancel.

  Verified against the production build served from a subpath — bad code,
  offline, cancel while hosting, and the happy path still agreeing.

### Dependencies

- net: 0.1.0 -> 0.2.0
- protocol: 0.1.0 -> 0.2.0


## web@0.2.1 (2026-08-31)

### Fixes

- keep the workspace protocol on the sim dependency
  autoVersion rewrote workspace:* to ^0.2.0, which unlinks the package
  from the workspace and leaves pnpm-lock.yaml recording a specifier the
  manifest no longer declares, so the deploy's --frozen-lockfile install
  refused to run. Constrain the rewrite to workspace ranges and write them
  back as they were; package versions are still stamped.


## web@0.2.0 (2026-08-31)

### Features

- add map controls and fix tile alignment when zooming
  Zooming was visibly broken. reconcile() repainted live tiles but only
  ever set a transform in acquire(), so on a zoom every tile already on
  screen kept its old pixel position while taking the new size: tiles sized
  30px sitting on a 24px grid, each overlapping its neighbour, with the map
  crammed into a fraction of the viewport. Positions are now recomputed for
  every tile in range whenever the zoom changes, and left alone on a pan,
  where translating the one container is still enough.

  Zoom is also a ladder of whole pixels per tile rather than a continuous
  multiplier. Fractional zoom meant fractional tile sizes and therefore
  sub-pixel seams across the grid, and it made a step mean something
  different every time. Whole numbers keep every edge crisp and make a step
  mean the same thing from a button, a key or a wheel notch.

  Wheel handling now spends at most one rung per event and drops the
  remainder instead of banking it. A single mouse notch reports ~100px, so
  scaling by the raw delta made one flick skip several levels, which is
  what made zooming hard to aim.

  Adds on-screen pan arrows, zoom buttons, a centre-on-capital control and
  arrow/+/-/H keyboard equivalents. The controls sit over the viewport,
  which captures the pointer to drive panning, so pointerdown on them is
  ignored — capture would otherwise redirect the gesture and the buttons
  would never see their own click.

  The topbar now shows the built version and the sim's protocol number,
  read from the manifest that dispat rewrites on release.

- add the client with virtualised viewport and minimap
  Drives the simulation the way the lockstep driver will: moves in, dirty
  tiles out, camera and DOM strictly outside the simulation. Swapping local
  play for the mesh changes where moves come from, not how the game runs.

  The map is arbitrarily large, so one image of the whole map at one pixel
  per tile backs both the zoomed-out view and the minimap. Drawing is then
  one drawImage regardless of zoom or map size, and staying current costs
  one pixel write per changed tile.

  Close in, real DOM tiles carry the prototype's conic-gradient flag art,
  generalised to N empires by swapping --c1/--c2. Elements are pooled and
  recycled, and panning translates one container rather than every tile.
  The prototype ran a querySelector per cell per frame; this touches only
  tiles the simulation reports dirty.

  Not Leaflet: it is built for raster tile pyramids from a tile server and
  assumes tiles are static images, where here every cell can change on any
  step.

### Dependencies

- sim: 0.1.0 -> 0.2.0
