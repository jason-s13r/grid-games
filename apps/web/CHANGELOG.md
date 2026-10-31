# Changelog

## web@1.6.0 (2026-10-31)

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

### Dependencies

- sim: 5.1.0 -> 5.2.0
- protocol: 1.1.0 -> 1.2.0
- room: 1.2.0 -> 1.3.0


## web@1.5.0 (2026-10-31)

### Features

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

- long-press a tile on a touch screen, show bridge places on demand, and a mine that is giving glows
  - On a touch screen the line under the board is gone, since a tap is a
    claim and could not also be how you pick a tile to read. A long press
    shows what the tile is in a popover over the board and claims nothing;
    a tap claims as before.
  - The tile line says what a click would do without the bank figures.
  - Where a bridge or ladder can go is lit for a few seconds after buying
    one, when you press one held in the store, and while the pointer is on a
    river or wall, rather than the whole time one is held.
  - A mine that is giving has a cyan shaft and its diamond in front at the
    top right, clear of the number.

### Dependencies

- sim: 5.0.1 -> 5.1.0
- room: 1.1.0 -> 1.2.0


## web@1.4.1 (2026-10-31)

### Fixes

- the standings and status bar update their numbers in place
  Every bank in the standings changes every step, so the whole panel, and
  the status bar with its meter, were rebuilt five times a second, which
  flickered and cost a layout each time. The numbers that change every step
  now sit in slots filled in place; the markup around them is rewritten
  only when its shape changes (the order moves, an empire falls, somebody
  joins). In four seconds of a game that is one rebuild of the standings
  and none of the status bar, against nineteen of each before.


## web@1.4.0 (2026-10-31)

### Features

- standings name one-seat empires, show every seat's stock and bank, and rank by more than tiles
  An empire with one seat says who holds it after its name, so a bot's
  empire reads "Cobalt (steady bot)". Under each empire, every seat shows
  its bank, and the empire's stock is in symbols: diamonds, bridges and
  ladders in hand, and March and Growth once bought, nothing shown at zero.
  It sits on the seat's line when there is one seat and on a shared line
  above them when there are several; everything there is public, since
  every player runs the same simulation.

  The standings can be ranked by tiles, population, the largest cascade,
  coins taken or diamonds collected this game.


## web@1.3.0 (2026-10-31)

### Features

- the tile line sits under the board, and a tap shows it on a phone
  What a tile is and what a click on it would do was a pill floating over
  the bottom of the board, and only for a mouse. It is a line under the
  board now, as wide as it, with its height kept when there is nothing to
  say. A mouse shows the tile under it; on a phone it is the last tile
  tapped, which stays until another is.

### Fixes

- a mine tile shows its population
  The mine was drawn over the tile, hiding the number on it. It is drawn
  beneath the number now, and the diamond of a dug mine sits at the top of
  the tile, clear of it.

- a large screen near 4:3 keeps the two columns
  The tabbed column on the right was for tablets, but it was chosen by
  shape alone, so a laptop window at 1320 by 958 got it too. It now applies
  up to 1180 pixels wide (an iPad held sideways); wider screens of any shape
  keep the side column and the chat under the board.

### Dependencies

- sim: 5.0.0 -> 5.0.1


## web@1.2.0 (2026-10-31)

### Features

- Huge and Vast maps, mines on the board, and v5 words
  Two larger maps, 384 by 256 and 512 by 352 (a snapshot of about 1.3 MB,
  inside a Durable Object's 2 MB value limit). Mines are drawn on the board
  and the minimap, dark until dug and lit while they give, and the hover
  says what one has left or what a dig takes. How to play and the Growth
  item in the store describe the v5 rules.

### Dependencies

- sim: 4.0.0 -> 5.0.0


## web@1.1.0 (2026-10-30)

### Features

- a gear on the start page for your name, backup and devices
  The start page's Settings fold is gone. A quiet gear at the top right of
  the header opens one dialog, You: your name, then Back up, Move between
  devices, Use a backup code and Delete my data, each a step inside it with
  Back to return. A game's Settings has a button to the same dialog.

- your player under Settings: back up, move between devices, use a backup code, delete my data
  Back up shows the player as a QR code, a link (#restore=) and a code;
  opening the link on another device offers to play as that player there.
  Move between devices: one device shows a four-letter code, the other
  types it in, both show the same two pictures, and the player goes across
  sealed with a secret the two devices agreed (copy, or move and sign the
  old device out). Delete my data takes your name out of the records and
  your games, optionally signing the device out. The privacy page says so.

- the wordmark links to the start page; one Start page item in the menu
  Tessera in the status bar, now kept on phones held upright with a
  narrower meter beside it, goes to the start page, and so does the menu's
  Start page, which replaces both Start page and Leave the game. From an
  online game it leaves the room (the game waits under Your games with
  Resume); a solo game is kept, with Back to the game. Population reads Pop
  on a phone, so the second row stays one row on the smallest screens.

- a steadier phone layout, a small map on the board, and a way to find each capital
  On a phone the game is exactly the screen's height: the status bar, the
  board and the tabs stay put and only the open panel scrolls, so the board
  no longer scrolls away and no dark page shows under a short panel. Held
  upright, the status bar is two short rows (empire, meter and menu; then
  tiles, population and the clock), without the wordmark.

  Phones get a small copy of the minimap in the board's bottom-left corner,
  showing where the view is; tap it to jump, or tuck it away (remembered on
  the device). It steps aside while the Map tab is open. The view rectangle
  on both minimaps is now dark on the paper and never too small to find.

  Each empire in the standings has a button that centres the board on its
  capital. The standings redraw every step, so they, like the store, are
  left alone while being pressed, or a tap could be lost.

### Fixes

- stop the page zooming on a double tap or a focused text field
  Pressing a pan or zoom button twice quickly zoomed the page, and Safari
  zoomed in on the chat box and name fields and stayed zoomed. The page now
  ignores double-tap zoom, and the game's viewport has a maximum scale of
  one; the board keeps its own zoom.

### Dependencies

- protocol: 1.0.0 -> 1.1.0
- room: 1.0.0 -> 1.1.0


## web@1.0.0 (2026-10-30)

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

- Resume on any active game you are in; lists appear once loaded
  The public list shows a game you are in with Resume and your empire's
  colour, rather than leaving it out. The start page's lists stay hidden
  until they have loaded, and then appear together, so a load does not
  flash empty boxes. Lists are revalidated on each load, so a game made
  public or joined a moment ago is there.

- show the leaderboard above the finished games

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

- your finished games in Finished, private ones included
  Finished lists your own games that have ended, private or public, as
  well as public games you were not in, newest first, so any game you
  played can be watched back. Your games already listed the private ones
  still running.

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

- people under their empires in the standings, chat under the board
  The standings are the one list of who is playing. An empire with people
  in it opens to list them, indented underneath: names, a dot for whether
  each is here, bots marked, and for your own empire each seat's bank.
  Yours starts open; which are open is kept across redraws. Requests to
  join your empire, your own pending ask, the invite link and who is
  watching follow the list. The separate People and Your seats sections
  go.

  Chat moves to a panel under the board, as wide as it, so lines read as
  lines; with it the left column goes, on every screen. On a phone or a
  tablet the tabs are Map, Standings, Store and, online, Chat.

- a start page and one create page for solo and online games
  The start page is a dark green card with the ways in: Play now (a solo
  game against three steady bots at the default length), New game, and a
  box to paste a game link or code. Under it are the lobby you are in, if
  any, then your games, open games and the leaderboard, then settings.
  "Back to the game" appears only once there is a game you chose to play,
  and goes while you are in another game's lobby.

  The create page replaces the separate solo and online forms. A switch
  picks solo or with other people; for online games a preset (Friends,
  Marathon, Quick) fills everything at once. Then each choice is one tap:
  map, length, teams (empires and seats each), bots (how many, at what
  level). Under More: when it starts, whether it is listed publicly, and
  each bot on its own, with the existing per-bot tuning. The one bot list
  is shared by both modes.

  view/Setup.ts goes; the online card only shows when there is something
  to show (connecting, a lobby, a problem).

- tablets get one column of tabbed panels beside the board
  On a screen 3:2 or squarer that is too wide to count as a phone (a
  tablet, or a narrow desktop window), two side columns left the board
  under half the width in an online game. There the panels are tabs in a
  single column on the right, as on a phone held sideways, and the board
  takes the rest: 680 of 1024 pixels rather than 484. The tabs wrap onto a
  second row there instead of scrolling. 16:10 and wider screens keep both
  columns.

- the store as a command card, with placements and tile info
  - Each store item shows its keyboard shortcut (B, L, M, G), and the keys
    buy from the board unless you are typing.
  - An item you cannot afford says how many more diamonds it needs.
  - While you hold a bridge or ladder, every tile where one can go right
    now is highlighted on the board. Clicking one places it, as before:
    there is still no mode to arm (game/input.ts reads the terrain).
  - The tile under the mouse is outlined, with a line saying what it is
    (owner, terrain, population, a coin or diamond, shielded) and what a
    click there would do, or why it would not.

  The highlights and the outline are drawn on a canvas of their own
  (view/Marks.ts), so they work at every zoom and the tile renderer is
  untouched.

- games default to 15 minutes
  A game created without a length, solo or online, is 15 minutes, and both
  forms start on that. DEFAULT_DURATION_MINUTES overrides it (14400 is ten
  days); it is set in the Cloudflare dashboard rather than in
  wrangler.jsonc, with keep_vars so a deploy does not reset it. The page
  reads it from GET /api/config, and a length the list does not have is
  added to it.

  DEFAULT_DURATION_DAYS, which wrangler.jsonc set to 10, is gone.

- diamonds and owned items at the top of the store
  The store's first line is the diamonds you have to spend, then what you
  already own: bridges and ladders in hand, and March and Growth once
  bought. Both leave the status bar, and the item rows lose their own
  held count.

- standings in the right column, above the store
  The right column is the minimap, the standings and the store; the left
  is an online game's people, seats and chat. A solo game has nothing for
  the left column, so on a wide screen it goes and the board takes the
  width.

- the board is 4:3 on phones too
  On a narrow screen the board is as wide as the screen at 4:3, and the
  open tab's panel takes all the height below it; the two side columns
  share that one panel area. On a phone held sideways the tab row and the
  panel go beside the board instead, the board takes the height, and the
  status bar is one line.

- board controls at the board's edges, and chat in the left column
  The pan buttons sit at the middle of the edge each one moves towards,
  and centre-on-capital and zoom sit in a row at the top right of the
  board, on every screen. The layer they sit in takes no clicks itself, so
  the tiles under its empty space stay clickable. The controls no longer
  move between the board and the side column, so view/Dock.ts goes.

  Chat moves to the left column under standings and people and takes the
  rest of its height (a <details> needs ::details-content told to stretch),
  instead of a small box at the foot of the right column. The right column
  is the minimap and the store.

- the board with docked panels, a ≡ menu, and the Qot. games look
  The game screen is the 4:3 board with a column either side: standings,
  people and seats on the left; the minimap with the pan and zoom
  controls, the store and chat on the right. The controls no longer cover
  the board on a wide screen; on a narrow one view/Dock.ts moves them back
  over the board's corner, where a thumb needs them. On a phone the store
  is one of the tabs under the board.

  The status bar keeps the empire, the bank, tiles, population, diamonds
  and time left (the step number moves to the clock's tooltip). Pause,
  replay speed, the menu screen, Leave and the version go in a ≡ menu.
  The store lists each item with its cost and what it does.

  The look follows the Qot. games page: a forest-green status bar, light
  panels, a dotted green-grey surround for the board, outlined buttons on
  a hard offset shadow, and Fredoka and Nunito, self-hosted through
  @fontsource as in the other Qot. games. The board keeps its cream paper.

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

- serve and link the original prototype again
  The menu links to it once more, and the Worker serves its build at
  /prototype/: `pnpm build` and `pnpm dev` copy apps/prototype/dist into
  the web build's assets. prototype is a package again, so it comes off
  dispat's list of scopes that are not packages.

- chat in an online game
  The right-hand column comes back for online games with a chat panel:
  the history on arriving, each line as it is said, and a box with All or
  Team. Team is offered once you hold a seat. Every line is escaped, a
  team line is marked, and the log follows the conversation unless you
  have scrolled back to read.

- an online game advances on its own clock
  OnlineGame simulates up to now every frame through the room client,
  rather than in the room's quarter-second batches, so the board moves at
  twelve steps a second. A hidden tab gets no frames, so a one-second
  timer keeps the game advancing and the hash reports (and with them the
  seat's presence) going. A seat given mid-game is shown once the step
  that creates it has been simulated.

- join a game that has started
  The standings offer Take it on an empire nobody holds and Ask on one
  somebody does, to anybody watching while the join window is open. A
  People panel lists who is in the game, shows your empire the requests
  it can answer, and makes an invite link to your empire; opening that
  link seats you once the game is on screen. The camera moves to your
  capital when you are seated, and a name changed in settings is sent to
  the game you are in.

- play online
  The menu gains an Online card. Its form creates a game on the Worker
  (map, length defaulting to 10 days, empires, players per empire, bots,
  and a start by hand, straight away or at a set time) and opens the
  game's link, /g/<room>. Pasting a link or code joins one.

  While the game is in its lobby the card shows the share link and the
  empires, with Join and Leave on each; the creator gets the start button,
  and a game created to start straight away starts itself once the
  creator is seated. When the game is running the board takes over,
  driven by OnlineGame: moves go to the room, batches come back, and a
  resync repaints the whole map. A link opened by somebody without a seat
  spectates.

  The socket reconnects on its own with a growing delay, and a reload
  catches up from the room. Flags are bound per game, so an online game's
  banners draw the way its record says.

### Dependencies

- sim: 2.0.0 -> 4.0.0
- protocol: 0.5.0 -> 1.0.0
- room: 0.0.0 -> 1.0.0


## web@0.10.0 (2026-09-04)

### Features

- every bot empire picks its own difficulty
  A count and one difficulty was half a control. One hard opponent beside two
  easy ones is a different game from three of anything, and the more interesting
  one — the easy pair sprawl into thin ground you can take straight back while
  the hard one builds something you have to prepare for. A single dropdown could
  not ask for that.

  So `simbots` is a list of difficulties rather than a number, and its length is
  the count. Both surfaces get the same control: a row per empire showing the
  colour it will play and how hard, an Add button, and a way to change its mind
  about being there.

  Capped at five rivals, or in the lobby at however many colours the human
  empires have left over. There are six themes, and a board you cannot read is
  not a harder game, only a worse one.

  Verified in a browser against the built bundle: a game started from
  [hard, steady x4] comes up with the member caps it asked for, which is the
  picker's whole job.

- pick how hard the bots play
  The difficulty a game is composed with has to be chosen somewhere, and every
  surface that composes a game now offers it, writing it into the genesis record
  with everything else so a replay plays the same bots. HostPlan gains an
  optional level; nothing here is a break.

- an empire is the people in it
  Bot teammates in a solo game and bot seats inside a human empire were both a
  host arranging its own side some extra hands. In a multiplayer lobby that is
  not a feature, it is an unfair setup with a UI.

  So a seat in a human empire is a person who is there, and another one joins the
  way a substitute always has: ROSTER_AMEND, endorsed by a quorum of the empire
  already holding the seats. A headless bot is seated by exactly that route.
  Deterministic SimBot empires are untouched — a default opponent is the one kind
  of bot a lobby should be composing.

  The seat cap replaces them, refused a layer earlier each time: checkPlan while
  the host can still fix it, inspectGenesis for a record born oversized, and the
  simulation for the amendment. Only the last is load-bearing.

  The lobby loses the keypairs it minted for bot seats, and with them the hub
  that divided one connection between several drivers. A page runs one seat.

- the log you played is yours to take away
  A tab already holds every move it fed to the simulation and had no way to let
  go of one. Save log downloads the same signed, replayable file the observer
  writes — genesis record, every move in its envelope, the chat, and the hash it
  arrives at. A tab is not a durable archive and does not pretend to be one.

### Dependencies

- sim: 1.1.0 -> 2.0.0
- net: 0.6.0 -> 0.7.0
- protocol: 0.4.0 -> 0.5.0


## web@0.9.0 (2026-09-03)

### Features

- the side panels become tabs on a phone
  Stacked as accordions under the board they were a strip of headings,
  each costing height whether or not anyone was reading it, and the one
  you opened pushed the board up out of its own stage. Tabs say the same
  thing in one row: exactly one panel, and the rest of the height is the
  board's. Clicking the open tab shuts it and hands the board everything
  — 422px of board becomes 710px on a 390x844 screen.

  The tabs are built from the panels rather than declared beside them, so
  the seats list brings its own tab when an empire gains a second member
  and the chat column brings one when the game is a mesh game. Nothing
  has to be kept in step by hand.

  Two things this cost, both worth writing down. The app element carries
  data-tabbed and data-panel rather than data-tabs and data-tab: a state
  flag on an ancestor that answers the same selector as the thing it
  describes makes every querySelector in the page a coin toss, and it
  matched the app before the button for an afternoon. And the default
  panel is chosen when a narrow screen arrives, never in the sync pass —
  setting an attribute to the value it already has still counts as a
  mutation, so a default chosen there reopened the panel a moment after
  the reader shut it.

- room to pan past the edge, and a board that follows you
  Three complaints with one cause: the map stopped exactly at the
  viewport edge, which is where the zoom and pan controls live. The tiles
  in the bottom-right corner of the world could be seen and never
  clicked.

  So the camera may now be pushed 96px past the map on every side —
  pixels rather than tiles, because what has to be cleared is a button
  and a button is the same size at every zoom. Clicking out there lands
  on nothing and is not a move.

  Clicking near an edge also pans just enough to see around the tile,
  capped at a quarter of the viewport so a narrow board does not move
  under every tap. Clicking two tiles from the edge says where you are
  going, and following you there saves a separate gesture.

  And the arrow pad comes back on mobile, a size larger for thumbs and
  slightly translucent over the board. It was hidden on the theory that
  touch drags the map and the buttons cover tiles you want; a drag on a
  small board competes with a tap, and the tiles under the controls are
  reachable now.

### Fixes

- the minimap jumps where you click
  A canvas has two sizes and they are not the same one. The backing store
  is what the letterbox fit is computed against; the bounding rect is CSS
  pixels, which here is whatever width the sidebar happens to be. Clicks
  were read in one and converted with the other, so a jump landed at
  about a third of where it was aimed, and further out the wider the
  panel got — which is why it was at its most useless on a phone, where
  the minimap is widest relative to the 240x160 it was declared as.

  The backing store now follows the box it is drawn in, at device pixel
  density and at the map's own aspect ratio. That fixes the arithmetic,
  sharpens a blit that was being upscaled, and takes the letterbox bars
  with it.

- stop announcing other empires' team chat
  A team line you cannot read used to appear as "sealed to their empire",
  on the argument that knowing an exchange happened is part of reading
  the game. In play it is not. It is a stranger's private conversation
  announcing itself in your log several times a minute and saying
  nothing, and traffic analysis is not a feature anybody asked for.

  A team line from an empire that is not yours is now dropped outright.
  The sealed rendering stays for the case that is genuinely worth seeing:
  our own team's line that we could not open.


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
