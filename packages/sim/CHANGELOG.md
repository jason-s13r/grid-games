# Changelog

## sim@5.2.0 (2026-10-31)

### Features

- a game with an end has no abandonment
  An empire may idle until the timeout. durationRules gives any game with an
  end abandonWindow 0 (NO_ABANDONMENT), which nobody can be present inside, so
  LAST_ROSTER cannot fire. Open-ended games keep the 3 h floor, having nothing
  else to end them.

  The scaled window (a third of the game, capped at 36 h) could end a 10-day
  game on day three, as soon as one empire was the only one opened in the last
  36 hours.

  inspectGenesis accepts 0 as the one value below the floor. An older build
  refuses it, so an old peer declines to join rather than desyncing; any build
  that runs such a record reaches the same verdict, so no protocol bump.

  Games already running keep the window in their records.


## sim@5.1.0 (2026-10-31)

### Features

- no cap on coins short of the map itself
  New games put no limit on how many coins lie about: they keep coming
  until there is no open ground left. The 360 cap was reached within the
  hour on anything but the smallest map, and after that a farm refilled
  only as fast as somebody somewhere took a coin.

  With no cap, a spawn rate in proportion to the area carpeted the map (a
  two-hour bot game on a medium map ended 92% taken), so a bigger map now
  gets coins more often by the square root of its area instead: 55% taken
  in the same game, with 3,068 coins taken and a best cascade of 1,256.

  Games already running keep the cap and rate in their records.

- coin farms: ground walled in by one empire gets extra coins
  On half of spawns an extra coin goes into a farm: open ground where each
  straight line from the tile meets the same empire's ground, or impassable
  terrain, within 16 steps, at least two of them the empire. A local test
  rather than a flood fill, so it stays cheap on the largest map.

  A 20 by 20 field walled in on a default map gets 81 coins in five
  minutes, against 15 without. In a two-hour bot game on a medium map,
  1,522 coins are taken and the best cascade is 328 tiles, against 1,185
  and 248.

  Rules in the record (coinFarmShare, coinFarmReach), so games already
  running keep theirs.

- more coins on bigger maps, and more of them near the action
  Coins came at the same rate, and up to the same 360 at once, on every map,
  so a medium map was a third as dense as the default one and hit the cap:
  in a two-hour bot game on 160 by 112 the map sat at 360 coins and 216 were
  taken. New games now scale the spawn rate and the cap with the map's area
  (coinsFor), 85% of coins land near ground or another coin (was 72%), and
  the hop from it reaches six steps (was four). In the same game: 1,185
  coins taken and a best cascade of 248 tiles, against 64.

  These are rules in each game's record, so games already running keep
  theirs.


## sim@5.0.1 (2026-10-31)

### Fixes

- a march fires the coin on its target
  A march is two steps, the gap and then the target, and a coin in the gap
  fired while a coin on the target was left lying on ground the empire now
  held. The target now lands like a claim, its coin backed by the other
  half of the bank.

  Behind a rule in the genesis record, marchTakesCoins, which new games
  carry: a game composed before it, v5 ones included, has no such field and
  keeps the rule it started with, so every existing record replays to the
  same hash.


## sim@5.0.0 (2026-10-31)

### Breaking Changes

- protocol 5: coins gather, a ceiling on bot tiles, growth that stops, and diamond mines
  Every change reads state.genesis.protocol, so v4 games in progress keep
  their rules. Supported protocols are 5 and 4; v3 and its fixture go, and
  v4 is retired on 2026-12-15.

  - Coins: a coinNearBias share of spawns now keeps probing until it finds
    an owned tile or another coin to hop off, rather than landing wherever
    the first probe fell. In a test game the share of coins within a hop of
    an empire goes from 1 in 8 to 1 in 2, and coins have about twice as
    many neighbours. Farming enclosed ground is left to emerge from this.
  - Bots: a tile of an empire the simulation plays holds at most 5,000 for
    the first three hours, 10,000 for the next three, and so on to 50,000.
    A fortifying bot whose tile is full thickens its thinnest instead.
  - Growth: fills a connected tile to 999 and stops, and only while
    somebody in the empire has moved or sent a heartbeat recently.
  - Diamonds come from mines instead of lying about: plain tiles beside
    mountains, one per 1,024 tiles and one within twelve steps of every
    capital (with a mountain tile of its own if there is none). A claim with
    a bank of 800 or more digs one; it gives a diamond every fifteen upkeep
    passes (five minutes), three in all, while the capital reaches it, then
    is worked out until dug again. Mines live in the item layer, so the
    snapshot layout is unchanged. Bots that can bank 800 dig them.
  - Maps scale their mountains, lakes and walls with the area, and rivers
    with the side (mapFor), so larger maps are not open plain.


## sim@4.0.0 (2026-10-30)

### Breaking Changes

- the sim's later rules, on a cut-back base for the Cloudflare rebuild
  Online play is being rebuilt around Cloudflare: a Durable Object per game
  orders moves, keeps the log and keeps the game running, while every
  client still runs the simulation and validates every move. This commit
  carries forward what the peer-to-peer branches added to the simulation
  and drops everything built around the mesh. The branches themselves are
  squashed under the tag archive/p2p.

  Kept from the branches:
  - sim: supported protocol set (now 4), durations as step counts, the
    join window, vacant empires and their grace, banners, the world
    journal, hand-tuned bot profiles, and recorded v3 and v4 fixtures
  - protocol: inspectGenesis across supported versions and its window
    checks, and display names
  - web: per-empire bot difficulty, the length picker, one setup form

  Removed from main:
  - packages/net (lockstep, mesh, lobby, archive) and packages/headless
  - apps/observer and apps/bot (apps/prototype stays, frozen)
  - the Pages workflow; dispat.yaml and the release workflow are trimmed
    to the packages that remain

  packages/protocol keeps identity, the genesis record, the roster, names,
  and signed moves, messages and the hello proof. apps/web plays solo
  against bot empires; online play comes back on top of the game room.

### Features

- a move counts as its seat's presence
  A move is a seat doing something, so from protocol 4 any applied move
  sets the mover's lastBeat the way a heartbeat does. A v3 game keeps
  counting heartbeats alone.

  The room follows: a seat's own move resets its heartbeat timer, so the
  room stamps a HEARTBEAT only for a seat that is connected and idle for
  the heartbeat interval, and a woken room recovers the timer from the
  moves since the snapshot as well as the beats.

  This changes the hash of v4 games. v4 is not released yet, so it goes
  into the same release rather than a new protocol. The v4 fixture's
  recorded hash is updated (its moves are unchanged), and the fixture-set
  test now replays the v4 game under each older version's number and
  expects that version's own hash: the version gates are the whole
  difference between them.


## sim@2.0.0 (2026-09-04)

### Breaking Changes

- an emptied home is not a taken home
  Every tile goes neutral the moment its population reaches zero, and that
  included a capital. It should not have: emptying a capital and taking one were
  the same board state and are not the same event.

  An empire is eliminated by not owning its home, and annexation fires on a
  capture. A claim that landed exactly level on a capital produced neither — the
  tile went to nobody, checkVictory struck the empire out, and annex() never ran
  because nothing had changed hands. The victim's territory was left owned by an
  empire that was already dead, and the attacker who spent a full bank on the
  winning blow collected none of it. So the payoff inverted at the boundary: land
  one short and the whole empire comes with the capital, land exactly level and
  the board eats it.

  A home now stays its empire's at zero, waiting for the second click. That click
  is the ordinary capture path, so annex() runs and a capital pays what a capital
  is worth. Every other tile still empties to neutral.

  The recorded fixture is unchanged; any game that lands level on a home now
  diverges. PROTOCOL_VERSION stays at 3.

- a march collects what it walks over, and no volley takes a home
  The gap a march fills is an ordinary claim by every other measure, but items on
  it were ignored: a diamond under it was destroyed and a coin under it was
  stranded on a tile the empire now owned and had already spent its bank on. The
  gap now lands through the same path a claim does. What backs the cascade is
  half the raw spend, because half the raw spend is what went into that tile.

  The tile a march lands ON keeps its item, which is not the same oversight: the
  coin ends up on a tile the empire owns and can trigger next turn at full
  strength.

  The second fault was that a march could take a capital. A march is a ranged
  attack and stays one — arrows, not a column — so it still lands on a rival's
  tiles as readily as on empty ground, and taking the ground around a home at
  range is a siege. But it lands two tiles out, which by construction means from
  ground the attacker holds no border on, and four of them finished a game from
  outside the defender's reach with no turn in which to answer. So a capital now
  falls to a claim and to nothing else: a march is refused on one and cannot
  route through one, and a coin's ball sweeps over a home and leaves it standing.
  The last square of a siege has to be walked onto from a tile already touching
  it, where the defender has a neighbour to push back at.

  Terrain was already safe — the chain is owned tile → gap → target with every
  link orthogonal and every tile passable, so a march reaches two tiles by
  walking, never by hopping. That is now a test rather than an accident of three
  separate checks.

  The recorded fixture is unchanged, but any game that marches onto an item or
  sweeps a capital now diverges. PROTOCOL_VERSION stays at 3.

- a bot's strength is its ceiling, its speed is its phase
  The last model made a bot weak by making it waste: cap it below its click
  interval and it fills, idles, and pours the rest away. It worked, but the
  weakness was invisible.

  Strength is now the population ceiling and nothing else. Everyone accrues one
  population a step and a claim spends the whole bank, so a claim is worth
  min(steps waited, popMax). Wait the 83 seconds a person needs for 999 and an
  easy bot still lands 333: the same patience, a third of the blow, and you can
  read it off a tile. Presets are 333, 666 and 999.

  Speed moves to the phase, and the tempo table is shared across all three
  difficulties, because tempo is a property of the work rather than of the
  opponent. Sharing it is also what makes the ceiling mean anything — an easy bot
  that clicked fastest would dodge its own cap. So a cap only bites in the slow
  phases, which is where it should.

  Six phases, each with a duration, and duration is the appetite: time in a phase
  is its share of the cycle, so the old weights are gone. expand sweeps its own
  border rather than reaching for the softest tile, which grew a finger. attack
  steers at the nearest held tile rather than a distant capital. heal reconnects
  a pocket before upkeep decays it. sleep is a real phase — population accrues
  through it, so a bot wakes with a full bank.

  The cycle is derived rather than remembered: step % cycle finds the phase in a
  walk over six entries and nothing enters the snapshot. Tempo is hashed from the
  pass through the cycle rather than drawn from the shared stream, so retuning a
  bot cannot move the coin spawns around it.

  Tuned by measurement: sixteen games each against a steady opponent, easy
  finishes ahead in 4, steady in 8, hard in 12.

  The state hash moves, and Mode loses "home" while BotProfile loses `interval`
  and `weights`. The recorded fixture becomes c0974773. PROTOCOL_VERSION stays at
  3, already this release's number.

- bots have a difficulty rather than a handicap
  A bot used to be a discounted player: half accrual, a 499 cap, and coin claims
  that fired without chaining. That is not an easier opponent, it is a worse one.
  It also gave the game exactly one bot — every SimBot empire played identically
  and the only dial was how many of them there were.

  The penalties are gone. A bot accrues at the rate everybody accrues at, and
  what replaces them is BotProfile, a per-seat record in the genesis and so
  something every peer can check before agreeing to play rather than something
  the peer running it asserts. easy, steady and hard are the presets. A seat
  voted in by ROSTER_AMEND gets the plain rules — difficulty is composed with a
  game, not recruited into one.

  The state hash moves, and the snapshot layout goes to 3 for the per-seat popMax
  it now carries. PROTOCOL_VERSION stays at 3, already this release's number.

- an empire may hold only so many seats
  An empire is a set of seats sharing territory with a population timer each, so
  a side that can add seats freely out-accrues everyone else — and since a
  headless bot is an ordinary peer holding an ordinary seat, adding one costs
  nothing but a process.

  rules.maxSeats closes it, defaulting to four: three people rotating shifts plus
  a seat to cover the night. It is a rule rather than a manner of the lobby
  because a picker can be edited and a rule cannot — validate() refuses the
  ROSTER_AMEND that would push an empire over, so no quorum can vote itself a
  bigger team than every other empire is allowed.

  The state hash moves with it: a peer on an older build would seat an amendment
  this one refuses. PROTOCOL_VERSION stays at 3, already this release's number.

- a coin is a reward rather than a redistribution
  A coin consumed the claim that triggered it: a full bank on a bronze coin put
  203 on the tile you clicked where bare ground would have taken 999, so on
  contested ground clicking a coin was a downgrade. The claim now lands first, as
  an ordinary claim with its ordinary surround multiplier, and the coin spreads
  on top of it.

  And every tile of a coin took the same share wherever it sat in the shape,
  which left the rarest coin the weakest per tile — gold at 39 a tile against
  bronze's 199, bouncing off any ground anybody held. Each tile now carries the
  multiplier it earns within the shape: everything in the ball is about to be
  claimed, so a tile with four neighbours inside it is being surrounded on four
  sides. The rarest coin is now the one whose middle is worth having.

  The shape is read rather than live ownership, so nothing depends on visit
  order, and the multiplier is charged once — to the click, never to the coin's
  share. The state hash moves; PROTOCOL_VERSION is already 3 for this release.

- a coin never claims nothing at all
  A coin divides the population that triggered it across its whole shape, which
  for gold is twenty-five tiles. Trigger one with less than that and the division
  floored to zero per tile — and place() refuses an amount of zero, so the coin
  took nothing whatsoever, not even the tile it was sitting on. Bronze spreads
  across five and effectively never hit it, which is why the two rarer coins
  looked broken and bronze looked fine.

  perTile is floored at one, which is enough to take neutral ground.

  The state hash moves. PROTOCOL_VERSION goes to 3, so a peer on an older build
  refuses the genesis at the lobby rather than desyncing overnight.

### Features

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
