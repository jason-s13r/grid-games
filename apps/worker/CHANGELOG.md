# Changelog

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
