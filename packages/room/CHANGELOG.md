# Changelog

## room@1.3.0 (2026-10-31)

### Features

- a game that ends says so
  A game used to end with a strip along the bottom of the board, while the
  clock stayed on the time that had been left, so on a phone it read as the
  game freezing.

  Now the end opens a card over everything, once per ending: who won ("You
  won!" for your own win, with tiles in your colours falling behind it), why
  in a sentence, where you came, the final standings, and how long it lasted.
  The board dims behind it. "See the board" closes it and leaves a bar along
  the bottom of the board with Results to open it again; Start page goes home.
  Watchers and replays get it too.

  The card is a dialog because the stage is a size container on a phone,
  which would hold even a fixed card to the board.

  The clock reads "Game over · lasted 2d 22h", and Settings says the length
  ended after 2d 22h with joining closed.

  room exports placesOf(state), the same placing as the recorded result, so
  the card and the start page's "you came 4th" agree.

### Dependencies

- sim: 5.1.0 -> 5.2.0
- protocol: 1.1.0 -> 1.2.0


## room@1.2.0 (2026-10-31)

### Features

- delete a game nobody came to once joining closes
  When a game's join window closes with no person seated (only bots), or
  its scheduled start comes with nobody having picked an empire, the room
  deletes its storage and its rows in D1. Nothing is archived. The room
  now also wakes when the join window closes, to check.

- chat a game's creator can set, links out, slower open chat, and blocking
  - Who may chat is set per game by its creator: everyone, team only, or
    off. On the create page under More, and in Settings during the game
    (the creator's to change, everybody else's to read). Public games
    start team only, others open.
  - The room takes links out of a line ("[link]" in their place), drops the
    same line said twice within 30 seconds, and keeps lines to everyone two
    seconds apart from one seat. In a public game, open chat is for players
    two minutes into their seats; watchers read along.
  - Click a name in the chat to block that player: their lines are hidden
    in every game, kept in this browser, with a Blocked row to undo it.
  - A refusal from the room during a game shows in the chat, where it is
    read.

### Dependencies

- sim: 5.0.1 -> 5.1.0


## room@1.1.0 (2026-10-30)

### Features

- Delete my data, names out of archives, and a meeting place for moving a player
  Archives and results carry keys and no names; names stay in the records,
  where their owners can take them out. POST /api/players/:key/forget,
  signed by the key, sets the name to the key's stand-in in players and
  seats, and tells the room of every game the key sat in to forget it too
  (the player list and the chat), so running games show it straight away.

  A Pairing Durable Object (migration v2) at /api/pair/:code/ws passes
  messages between two devices for up to ten minutes and keeps nothing,
  for moving a player from one to the other.

### Dependencies

- protocol: 1.0.0 -> 1.1.0


## room@1.0.0 (2026-10-30)

### Breaking Changes

- stamp moves as they arrive, and let clients keep time
  The room no longer ticks. A move is stamped the moment it arrives, half a
  second ahead of now, and broadcast at once with the room's clock; nothing
  is stamped below a step already handed out, so every earlier step is
  final. The room's own simulation catches up lazily, only when it needs an
  answer: a newcomer's snapshot, a hash to compare, a seat to judge. Between
  messages it does nothing, which is what lets a Durable Object hosting it
  hibernate.

  Clients set their clock by the room's and simulate up to now on every
  advance(). A move that arrives after its step is replayed from one of ten
  rewind points kept a second apart; anything older asks the room for its
  state. A reconnecting client offers the last state it knows is complete,
  from before it lost the room, rather than what it simulated since.

  Hash reports go every 15 seconds of game time and carry the seat's
  presence: the room stamps a HEARTBEAT when one is due. Seats given after
  the start are ROSTER_AMEND moves at a step of their own, judged against
  the state they land in.

### Features

- game settings in a dialog over the board; the creator can list a game publicly
  Settings opens from the ≡ menu as a dialog, so the game stays on screen.
  It holds your name, the game's link and, for the creator, whether the
  game is listed publicly. The map, length, empires and joining window are
  shown read-only, since they are fixed when the game starts.

  The room takes a new "public" message from the creator, saves it and
  sends the settings to everyone; the records upsert now updates public
  and phase, so the listing follows.

- the start page's lists side by side, and more leaderboards
  The start page shows every list at once, as its own section:

  - Your games: the ones you are in that have not finished, to resume (or
    open the lobby).
  - Public games: open and running together. Join a lobby or a game still
    taking players; watch one that is not. Yours are not repeated here.
  - Finished: public games that have ended, to view the replay.
  - Leaderboard: the top ten for games won, area, population and largest
    coin cascade, over all games or each player's best single game.

  The lists reload whenever the start page shows.

  A result now records the empire's peak population and each seat's
  largest coin cascade (migration 0002); results from before read as 0.
  GET /api/leaderboard?scope=total|game returns every list at once.

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

- game records in D1, archives in R2, replays
  The room reports what outlives a game through hooks, and knows nothing
  about where it goes: a listing row when its lobby or phase changes, a
  player when someone joins or is seated, and the result when it ends. A
  room now also wakes at its game's end and twice a day while it runs, so
  a game that ends with nobody connected is still recorded.

  The Worker writes those to D1 (migrations/0001_listings.sql): games,
  seats, results and players. It answers GET /api/games?list=open|running|
  ended for public games, /api/players/:key for one key's record and recent
  games, and /api/leaderboard. A game can be listed publicly from the
  create form.

  A finished game is archived to R2 as one gzipped JSON object: the genesis
  record, every stamped move with its signature, who sat where, and the
  result, in the shape `pnpm replay --log` reads. KEEP_DAYS (30) after that,
  the room's object deletes its own storage, and the archive is the game:
  GET /api/games/:id/archive serves it, and /api/games/:id says so.

  The menu has a Games card: open, running and finished public games, your
  own games with your record, and the leaderboard. A finished game opens as
  a replay, played from its archive at a speed from real time to six hours a
  second, and a link to a game whose room is gone opens its replay.

  Both bindings are optional: without them games still run, and nothing is
  listed, archived or deleted. The first deploy creates the database and
  the bucket; `pnpm deploy` applies the schema after deploying.

- bot seats
  A client can say it is a bot in its hello. The room seats it as a BOT
  member, through the same doors as a latecomer: an invite or a player's
  approval, never by taking an open empire on its own. Like any bot seat it
  may come in after the join window closes. The People panel marks it.

- chat
  A line is said to everybody in the room, or to the speaker's empire
  alone. The room carries it and keeps the last 200 for whoever arrives
  later; nothing in the game depends on chat, so it is neither signed nor
  stamped. Control and bidi characters are stripped, whitespace collapsed,
  lines capped at 500 characters, and a speaker gets one line every 400
  ms. A team line reaches the empire's members and nobody watching.

- seats after the start
  Three ways into a running game, each ending in a ROSTER_AMEND the room
  issues at the next batch, so the simulation's own rules decide: the join
  window, the seat cap and a living empire.

  - claim: take an empire nobody holds
  - ask, then approve or decline: any member of the asked empire answers
  - redeem: present an invite a member of that empire signed; each invite
    is accepted once

  Late seats are stored and replayed onto the roster when the room is
  rebuilt. The room tells a newly seated client its seat, and sends
  everybody who is in the game, seated or watching, with the open
  requests. Names can change during the game.

- take back sockets after a wake
  A Durable Object woken from hibernation still has its sockets but not the
  room object that knew them. reattach() hands a socket back to a fresh
  room with the key it had already proved, and keyOf() is what the host
  saves beside the socket to make that possible. RoomClient.reconnected()
  points a client at a new connection while it keeps its game, so the
  room only sends what it missed. The room's phase is readable for hosts.

- the game room and its client
  @tessera/room puts a game's moves in order. The room stamps each signed
  move onto the next unsealed step, simulates up to the wall-clock step,
  logs the batch and broadcasts it; every client simulates exactly that
  and reaches the same hash. It runs the lobby and seals the genesis
  record (by hand or at a scheduled time), heartbeats for connected seats,
  keeps a snapshot, catches returning and late clients up, and resyncs a
  client whose checkpoint hash disagrees.

  It has no timer, socket or storage of its own: the host supplies
  connections, calls tick() and passes a store. RoomClient is the other
  end, holding the client's simulation. The tests run a room and several
  clients in one process: lobby rules, scheduled start, moves on every
  client, stale and seatless moves refused, heartbeats, drift resync,
  reconnecting, late joining from a snapshot, six hours asleep, and the
  room rebuilt from its store.

### Fixes

- list every game you play in under Your games
  A player's list was cached for 15 seconds, so a game you had just joined
  or taken a seat in was missing when you went back to the start page. It
  is no longer cached.

  Games that began before the records did had nobody on record, so they
  were missing from everybody's list. Such a room now reports its players
  once, the first time it wakes.

- keep a game's Durable Object within the free tier
  A room read its whole move log every time its object woke: the moves
  query asked for "step >= ? ORDER BY id", which SQLite answered with a
  scan of the table rather than the step index. A connected client wakes
  the object with a hash report every 15 seconds, and the log grows by a
  heartbeat every 30 seconds per seat plus every move, so one ten-day game
  with two people went past the 5M rows-read daily limit by itself.

  The store now reads only what it returns. Moves are kept one row per
  stamp in a WITHOUT ROWID table keyed by (step, n), so a range of steps is
  a range of the key and a write is one row, not a row and an index entry.
  The small values are read once per wake and cached, and an unchanged
  value is not written again. A room made before this is migrated when it
  wakes: the old log is kept as moves_v1 for the archive, and only the moves
  since the snapshot are copied across.

  The room writes less. It no longer stores its step, its last stamp or the
  sequence numbers on every move: the step comes back from the snapshot,
  the last stamp from the log, and the sequence numbers and heartbeat times
  from the moves since the snapshot, which the room reads on waking anyway.
  That also stops a woken room from beating a seat early because it had
  forgotten the last beat. Snapshots are every two minutes of game time.

  Clients report their hash once a minute rather than every 15 seconds. New
  games beat a connected seat every three minutes and count it live for
  five; the sim never read the heartbeat interval itself, and abandonment is
  measured in hours. Games already running keep the rules they were sealed
  with.

  Measured in workerd: a wake now reads about a dozen rows plus the moves
  since the last snapshot, and a move costs one row written.
  /api/games/:id reports the rows the object has read and written since it
  woke.

### Dependencies

- sim: 2.0.0 -> 4.0.0
- protocol: 0.5.0 -> 1.0.0
