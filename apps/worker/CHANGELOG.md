# Changelog

## worker@0.8.0 (2026-11-11)

### Features

- a stand-in map and a length badge in the game lists
  A game has no map to show until it starts, so the scheduled games sat in
  the public list as blank boxes. Those now show a made-up map, faded so it
  does not pass for the game's own, and every listed game carries its
  length (6h, 1d, 3d, 10d) over the corner of its picture.

  The length comes from the room's summary as durationMs and is kept in D1
  (migration 0005). A row written before that falls back to its start and
  end, and a lobby picks it up the next time its room reports.

### Dependencies

- sim: 5.4.0 -> 6.0.0
- room: 1.7.0 -> 1.8.0
- web: 1.13.0 -> 1.14.0


## worker@0.7.0 (2026-11-11)

### Features

- record the map over a game, and keep it in the archive
  The room records a frame of the map on a steady pace, about 4,000 over a
  game with an end whatever its length, plus the start and the end. It
  simulates in pieces that stop at each frame, so a quiet room's hourly
  catch-up records its frames as surely as a busy one.

  A frame is a grid like the listings' map, a tile a cell up to Large
  maps and at most 256 cells across, stored as runs: a key frame every
  64, deltas between. One row written per frame. A six-hour game on a
  Large or Vast map comes to about 600 KB.

  The archive carries it as `timeline`, with the house each empire flew,
  for a replay to fast-forward through and make a video from.

- a small map of each game in the listings
  The room builds a grid of who holds what, at most 96 cells across, each
  cell what covers most of its square, with the house each empire flies.
  It is sent at the start and the end, and in between at most every ten
  minutes, from the snapshot the room already takes; rooms wake hourly,
  so a quiet game's map is at most an hour old.

  The Worker deflates it into the games row (migration 0004) and the
  listings carry it. The start page draws it a pixel a cell in the
  zoomed-out map colours, says how old it is, and takes the house you
  flew and the winner's name from it rather than from whatever game is
  on the board.

### Dependencies

- room: 1.6.0 -> 1.7.0
- web: 1.11.0 -> 1.12.0


## worker@0.6.0 (2026-11-11)

### Features

- count seats taken, and let a player leave a lobby
  A game's player count is now the seats taken: in a lobby, the people who
  have picked an empire, rather than everybody who has opened it. A lobby
  also lists how many are in it, picked or not ("1 player, 3 in lobby"),
  kept in a new games.lobby column. Both change only on a join, a pick or
  a leave, so they cost no more writes than before.

  The lobby's Leave button now takes the player out of the game
  altogether: out of its lobby and its count, and off their own list of
  games. Coming back is joining again. Leaving a game that has started is
  still just closing it; the seat stays.

  The deploy applies D1 migrations before the Worker goes up as well as
  after, so a new column exists before the code that reads it.

### Dependencies

- room: 1.4.0 -> 1.5.0
- web: 1.9.0 -> 1.10.0


## worker@0.5.0 (2026-11-11)

### Features

- open chat in scheduled games
  Everybody can chat to all players or to their own team, rather than to
  their team only.

- one bot of each difficulty in scheduled games
  The 6-hour and 1-day games get an easy and a steady bot, the 3-day and
  10-day games an easy, a steady and a hard one. The test now checks every
  series against the create form's own validation.

- scheduled public games of each length, always open
  There is now always a public 6-hour, 1-day, 3-day and 10-day game to
  sign up for. Each length runs on a fixed grid: with J the late-join
  window (a third of the game), game k starts at k*2J and takes late
  joiners until k*2J + J, which is when game k+1 opens its lobby, J before
  its own start. For six hours: two hours of lobby, two of late joining,
  and a new game every four hours.

  Asking for the open list makes any missing scheduled game, so nothing
  runs on a timer. Room ids come from the series and slot (6h-<slot>), so
  two lists at once make the same room and the second init is refused. A
  slot that was called off at its start (nobody picked an empire) moves
  the list on to the next slot early, so one is always open.

  Scheduled games are owned by the key in SCHEDULE_CREATOR, a dashboard
  variable, or by nobody when it is unset: then nobody can start one early
  or change its settings, and it starts itself. The lobby and settings
  say so.

- link a best single game on the leaderboard to its game
  The "best single game" lists now say which game each best came from,
  and the number links to it: a finished game, so it opens as its replay.
  Wins are a total and stay unlinked. The link is a real /g/<id> link, so
  it can be opened in a new tab; a plain click opens it in place.

### Dependencies

- room: 1.3.1 -> 1.4.0
- web: 1.8.1 -> 1.9.0


## worker@0.4.1 (2026-11-11)

### Fixes

- catch a sleeping room up an hour at a time
  A room simulated everything since it last woke in one call. On a large
  map with bots, twelve hours of game takes most of a Durable Object's 30 s
  of CPU, so a long idle gap got the object thrown away mid-catch-up: the
  alarm failed until Cloudflare gave up on it, every hello failed the same
  way, and the game sat at its last snapshot, never ending or archiving.
  Clients waited on "Connecting..." forever.

  The room now simulates at most an hour of game per call (MAX_ADVANCE)
  and, while behind, asks to be woken again straight away, so each wake
  gets fresh CPU and the game catches up over a handful of alarms. Running
  games check in hourly instead of twice a day, so a wake never has much
  to do. Asking for a game's info sets its alarm again, which restarts a
  room whose alarm was dropped.

  A browser client catches up a few thousand steps a frame instead of
  all at once, so arriving far behind no longer freezes the tab. And an
  ended, archived game opens as its replay: the check looked for a phase
  of "ended", which a live room never reports.

### Dependencies

- room: 1.3.0 -> 1.3.1
- web: 1.8.0 -> 1.8.1


## worker@0.4.0 (2026-10-31)

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
- room: 1.1.0 -> 1.2.0
- web: 1.4.1 -> 1.5.0


## worker@0.3.0 (2026-10-31)

### Features

- Huge and Vast maps, mines on the board, and v5 words
  Two larger maps, 384 by 256 and 512 by 352 (a snapshot of about 1.3 MB,
  inside a Durable Object's 2 MB value limit). Mines are drawn on the board
  and the minimap, dark until dug and lit while they give, and the hover
  says what one has left or what a dig takes. How to play and the Growth
  item in the store describe the v5 rules.

### Dependencies

- sim: 4.0.0 -> 5.0.0
- web: 1.1.0 -> 1.2.0


## worker@0.2.0 (2026-10-30)

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
- room: 1.0.0 -> 1.1.0
- web: 1.0.0 -> 1.1.0


## worker@0.1.0 (2026-10-30)

### Features

- game settings in a dialog over the board; the creator can list a game publicly
  Settings opens from the ≡ menu as a dialog, so the game stays on screen.
  It holds your name, the game's link and, for the creator, whether the
  game is listed publicly. The map, length, empires and joining window are
  shown read-only, since they are fixed when the game starts.

  The room takes a new "public" message from the creator, saves it and
  sends the settings to everyone; the records upsert now updates public
  and phase, so the listing follows.

- How to play, Privacy, Qot. games and Support at the foot of the start page
  The same links as the other Qot. games:

  - How to play (/about): the rules in plain words (claiming and the bank,
    the map, coins and diamonds, the store and its keys, capitals, playing
    online) and where the game comes from.
  - Privacy (/privacy): what the browser keeps (a key and a name), what the
    server keeps for online games and for how long, who can see what,
    Cloudflare and Ko-fi, and how to have it removed.
  - Qot. games: Tessera's page at qot.nz/games/tessera.
  - Support the game ☕: the tip link as a QR code, with a link to open it
    here. It comes from the Worker: TIP_URL from the dashboard, the maker's
    Ko-fi page when unset, none when "off"; /api/config now says which.

  The two pages are plain HTML beside the game (Parcel entries), styled to
  match the start page.

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

- games default to 15 minutes
  A game created without a length, solo or online, is 15 minutes, and both
  forms start on that. DEFAULT_DURATION_MINUTES overrides it (14400 is ten
  days); it is set in the Cloudflare dashboard rather than in
  wrangler.jsonc, with keep_vars so a deploy does not reset it. The page
  reads it from GET /api/config, and a length the list does not have is
  added to it.

  DEFAULT_DURATION_DAYS, which wrangler.jsonc set to 10, is gone.

- serve archives through the edge cache
  A finished game's archive never changes, so the Worker keeps it in the
  edge cache after the first R2 read. A replay watched by many people, or a
  script asking for one in a loop, then costs no R2 operations, which was
  the one way R2 could run past its free allowance.

  The cache holds the stored gzip as plain bytes, with no content-encoding
  for it to act on, and the Worker labels it gzip on the way out; a cached
  response that carried the header came back compressed twice. The cache
  works on a custom domain such as tessera.qot.nz and is skipped on
  workers.dev.

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

- the Worker and its game rooms
  apps/worker is the Cloudflare Worker for tessera.qot.nz. It serves the
  web build as static assets with /g/<room> falling back to the client,
  creates games at POST /api/games, reports one at GET /api/games/:id, and
  hands /game/:id/ws to that game's GameRoom Durable Object.

  GameRoom hosts a Room over the object's SQLite storage. Sockets use the
  hibernation API and keep their proved key in their attachment; an alarm
  ticks every 250 ms while anybody is connected and wakes the object for a
  scheduled start otherwise. The default game length is 10 days, set by
  DEFAULT_DURATION_DAYS.

  pnpm dev now builds everything and runs Parcel in watch mode beside
  wrangler dev on port 8787; pnpm dev:solo is the old client-only server.
  scripts/smoke.mjs plays two clients through a running server: create,
  lobby, start, a claim on both, a drop and a rejoin at the same hash.

### Fixes

- list every game you play in under Your games
  A player's list was cached for 15 seconds, so a game you had just joined
  or taken a seat in was missing when you went back to the start page. It
  is no longer cached.

  Games that began before the records did had nobody on record, so they
  were missing from everybody's list. Such a room now reports its players
  once, the first time it wakes.

- create the archive bucket before deploying
  Wrangler provisions the D1 database on the first deploy, but it takes a
  bucket_name to mean the R2 bucket already exists, and the deploy failed
  with "R2 bucket 'tessera-archive' not found". The deploy script now
  creates the bucket first and carries on whether that succeeds or the
  bucket is already there; if R2 itself is not switched on for the account,
  the deploy reports that.

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

- no tick while a game is running
  The room acts on messages alone now, so the object runs nothing between
  them and can hibernate; the timer goes, and the only alarm is a
  scheduled start. The smoke script drives its clients' clocks the way a
  page does.

- tick with a timer while players are connected
  An alarm per tick costs a request and a row written every 250 ms, about
  14,400 of each per hour of play. A timer in the object costs neither.
  The alarm stays for a scheduled start and as a fallback every 30 s.

### Dependencies

- sim: 2.0.0 -> 4.0.0
- protocol: 0.5.0 -> 1.0.0
- room: 0.0.0 -> 1.0.0
- web: 0.10.0 -> 1.0.0
