# Running Tessera: the instances, and what to start

What processes exist, who runs each one, how long it lives, and what you need
running before you can test p2p and non-p2p play.

The one idea to hold onto: **only two kinds of instance matter to a game — the
ones that hold a seat and the ones that hold a door.** Everything else is a
convenience that can be switched off without the game noticing.

---

## 1. The instances

```mermaid
flowchart TB
  subgraph pergame["Per game — start these to play"]
    TAB["<b>A user's tab</b><br/>one per player<br/>holds a seat<br/>dies when the tab closes"]
    HOST["<b>A game's host</b><br/>zero or one per game<br/>the door + the archive<br/>runs for days"]
    OBS["<b>An observer</b><br/>zero or more per game<br/>no seat, just keeps the record<br/>runs for days"]
    BOT["<b>A bot</b><br/>zero or more, one seat each<br/>voted in by an empire<br/>runs while it is wanted"]
  end

  subgraph community["Per community — one deployment, many games"]
    API["<b>The API</b><br/>address book + archive store + leaderboard<br/>knows about every game anyone listed<br/>always on"]
    DB[("postgres<br/>under the API")]
  end

  TAB ---|"WebRTC, or one socket each to a relay"| HOST
  TAB --- OBS
  TAB --- BOT

  TAB -->|"list my game, find games"| API
  HOST -->|"keep my row alive"| API
  OBS -->|"hand over a finished game"| API
  API --> DB
```

| Instance | How many | Who runs it | What dies with it |
|---|---|---|---|
| **A user's tab** | one per player | each player | their seat goes quiet; if they were also the door, the door closes |
| **A game's host** | 0 or 1 per game | whoever wants the game to survive | the door, and the HTTP reads — not the game, if anyone else is still in it |
| **An observer** | any number | anyone | one copy of the record |
| **A bot** | one per seat it covers | the empire that voted it in | that seat goes quiet |
| **The API** | one per community | one operator | discovery and the shared leaderboard. No game stops |

The asymmetry to notice: **the API cannot stop a game or change its outcome.**
A game with no API, no host and no observer is a complete game — it just can't
be found by strangers and vanishes when the last tab closes.

Nothing else is an instance. A WebRTC link needs a broker to introduce the two
ends, and about one pair in five needs a TURN relay to carry its packets — but
those are properties of the link, not processes in the system. You don't run
them, they hold nothing, and the diagrams below draw them as what they are: the
line between two peers.

---

## 2. One game over WebRTC

Six instances: three people in browser tabs, and three programs. The host app
composed the game and its address is the room code; the bot holds a second seat
in Bob's empire; the observer just keeps a copy.

```mermaid
flowchart TB
  subgraph game["Game 1 — <b>WebRTC mesh</b> · room code tsr-game1"]
    A["<b>Alice's tab</b><br/>empire 1"]
    B["<b>Bob's tab</b><br/>empire 2"]
    C["<b>Carla's tab</b><br/>empire 3"]
    H["<b>host app</b><br/>no seat<br/>composed the game<br/>is the room code<br/>archives"]
    T["<b>bot app</b><br/>empire 2, second seat<br/>voted in by Bob"]
    O["<b>observer app</b><br/>no seat<br/>archives"]
  end

  A <--> B
  A <--> C
  A <--> H
  A <--> T
  A <--> O
  B <--> C
  B <--> H
  B <--> T
  B <--> O
  C <--> H
  C <--> T
  C <--> O
  H <--> T
  H <--> O
  T <--> O

  RD["<b>host app, HTTP</b> :8080<br/>/room/tsr-game1<br/>/room/tsr-game1/resume<br/>/room/tsr-game1/archive"]
  A -.->|"is it still running?<br/>give me the archive"| RD
  H --- RD
```

**Six peers, fifteen connections.** Every peer holds a direct data channel to
every other peer, and every signed move is sent once per peer. That's the n²
the next diagram replaces.

Notes on this shape:

- **The host app is not in the middle of anything.** In WebRTC mode it is a
  door, a keeper and a set of HTTP reads — not a relay. Frames between Alice and
  Bob never touch it.
- **The room code is the host app's own peer address.** That's what makes the
  host worth running: Alice can close her laptop and the room is still there.
- **Every line is a WebRTC data channel.** Opening one needs a broker to
  introduce the two ends; once the channel is up the broker is out of the loop,
  and it never sees a move either way. It's part of how a link gets made, not
  something in the picture.
- **The bot and the observer need native WebRTC** (`node-datachannel`) to be in
  this room at all.
- **Some of these lines are secretly relayed.** Roughly one pair in five sits
  behind symmetric NAT and its packets go via TURN. Still peer-to-peer as far as
  the game is concerned: a relay carrying one pair can drop packets and nothing
  else.

What's running:

```sh
pnpm --filter @tessera/host     start --transport rtc --as tsr-game1 --port 8080 --auto 3
pnpm --filter @tessera/bot      start tsr-game1 --apply 2
pnpm --filter @tessera/observer start tsr-game1 --as watcher-1
# three browser tabs join by typing:  tsr-game1
```

---

## 3. The same game over a relay

Identical cast, identical seats, identical signed moves. The host app now also
runs the relay, and every frame goes through it.

```mermaid
flowchart TB
  A["<b>Alice's tab</b><br/>empire 1"]
  B["<b>Bob's tab</b><br/>empire 2"]
  C["<b>Carla's tab</b><br/>empire 3"]
  T["<b>bot app</b><br/>empire 2, second seat"]
  O["<b>observer app</b><br/>no seat, archives"]

  subgraph host["<b>host app</b> — one process, one port"]
    R["<b>the relay</b><br/>holds room → sockets<br/>forwards bytes, parses nothing<br/>keeps no game state"]
    K["<b>the keeper</b><br/>an ordinary seatless peer<br/>composed the game, archives"]
    RD["<b>HTTP reads</b> :8080<br/>/room/game2<br/>/room/game2/resume<br/>/room/game2/archive"]
    K ---|"attached in process —<br/>never dials itself"| R
  end

  A <-->|"ws://…:8080/game2"| R
  B <--> R
  C <--> R
  T <--> R
  O <--> R

  A -.->|"give me the archive"| RD
```

**Six peers, five connections.** Everyone holds one socket. A move is sent once
and the relay fans it out.

Notes on this shape:

- **No broker, no TURN, no NAT problem.** Players connect the way they connect
  to any website. A player behind a corporate firewall who couldn't join the
  first game can join this one.
- **The room is a URL, not a peer.** `ws://your-host:8080/game2` stays valid
  whether or not anyone is in it — including before the game starts and after
  everybody leaves.
- **The bot and the observer load no native WebRTC**, which is the difference
  between an install that works on a small VPS and one that doesn't.
- **The relay is closed by default** to rooms it isn't hosting; a stranger
  asking for another room is told nothing is running there.
- **What the relay can do:** drop, delay, reorder — and one thing a TURN relay
  can't, carry everyone but one player. Silence Carla and the others stall on
  her, then vote her out. Denial of play escalating to ejection, never authority,
  and the ejection is a signed record in every copy of the archive.
- **The host never reconnects to itself.** Its keeper is attached internally, so
  a bug in reconnect handling shows up in all five others and never in the host.

What's running:

```sh
pnpm --filter @tessera/host     start --transport wss --room game2 --bind 0.0.0.0 --port 8080 --auto 3
pnpm --filter @tessera/bot      start ws://your-host:8080/game2 --apply 2
pnpm --filter @tessera/observer start ws://your-host:8080/game2 --as watcher-2
# three browser tabs join by typing:  ws://your-host:8080/game2
```

---

## 4. Both games at once

Two games, twelve instances, sharing exactly one thing — and it isn't the game.

```mermaid
flowchart TB
  subgraph g1["<b>Game 1 — WebRTC</b>, room code tsr-game1"]
    M(["<b>WebRTC full mesh</b><br/>15 data channels"])
    A1["Alice"] --- M
    B1["Bob"] --- M
    C1["Carla"] --- M
    H1["host app<br/>door + keeper + reads"] --- M
    T1["bot app"] --- M
    O1["observer app"] --- M
  end

  subgraph g2["<b>Game 2 — relayed</b>, ws://your-host:8080/game2"]
    R2["host app<br/><b>relay</b> + keeper + reads"]
    A2["Dan"] --- R2
    B2["Erin"] --- R2
    C2["Femi"] --- R2
    T2["bot app"] --- R2
    O2["observer app"] --- R2
  end

  subgraph api["<b>The API</b> — one deployment, both games"]
    BOARD["<b>address book</b><br/>one row per door, each with a TTL"]
    STORE["<b>archive store</b><br/>replays what it is sent,<br/>keeps what passes"]
    RANK["<b>leaderboard</b><br/>derived from the archives it holds"]
    STORE --> RANK
  end

  H1 -->|"announce tsr-game1,<br/>heartbeat"| BOARD
  R2 -->|"announce ws://…/game2,<br/>heartbeat"| BOARD
  O1 -->|"upload when it ends"| STORE
  O2 -->|"upload when it ends"| STORE

  NEW["<b>a stranger's tab</b><br/>board URL in Settings"]
  NEW -->|"what's running?"| BOARD
  NEW -.->|"then dials the door itself"| R2
  NEW -->|"read the table"| RANK
```

The point of putting them side by side:

- **Transport is a per-game choice, not a deployment mode.** Nothing is
  configured to make game 1 p2p — the room code somebody typed had no scheme on
  it, so it's a peer address. Game 2's had `ws://`, so it's a relay. That string
  is the entire toggle: no probe, no fallback, no setting.
- **The two games share no state, no process and no trust.** Different hosts,
  different bots, different observers, different archives.
- **The API is per-community, not per-game.** It's the only instance that knows
  both games exist. Turn it off and both games keep running — you just can't
  find them or see a combined table.
- **A row on the board is a claim, not a game.** The stranger's tab re-derives
  everything it can from the sealed record attached to the row, then dials the
  door to see whether anybody is actually home. It never takes the board's word
  for who's playing or whether the game is joinable.
- **Uploading an archive isn't reporting a result.** The store replays every
  move against the signatures and reaches the final state itself; anyone holding
  the same files computes the same table.

---

## 5. Lifetimes — why a host instance exists at all

```mermaid
gantt
  title A three-day game
  dateFormat YYYY-MM-DD HH:mm
  axisFormat %a %H:00

  section Players
  Alice plays          :p1, 2026-01-01 18:00, 6h
  Bob plays            :p2, 2026-01-01 20:00, 5h
  Carla plays          :p3, 2026-01-02 09:00, 4h
  Alice comes back     :p4, 2026-01-03 09:00, 8h

  section Cover
  Bot covers Bob's seat :b1, 2026-01-02 01:00, 20h

  section Always on
  The game's host      :active, c1, 2026-01-01 18:00, 72h
  An observer          :active, c2, 2026-01-01 18:00, 72h

  section Community
  The API              :active, d1, 2026-01-01 18:00, 72h
```

Tabs come and go. The seats they hold go quiet and their empires idle, but the
game doesn't stop — the world turns on elapsed time, so a player returning after
six hours has a quarter of a million steps to catch up on and gets handed a
snapshot to do it from.

That snapshot has to come from *someone who's still there*. That is the entire
argument for running a host or an observer instance: not authority, just
presence.

---

## 6. What to start

```sh
pnpm install
pnpm build     # the headless instances run from compiled output
```

### Solo — nothing but the tab

```sh
pnpm dev       # http://localhost:1234
```

### P2P — two tabs, no servers

```sh
pnpm dev
```

Tab A hosts a game and shows a room code. Tab B — a different browser profile or
a private window, since identity is per-profile — pastes it into the join box.

Add long-lived instances to the same room:

```sh
pnpm --filter @tessera/observer start <room-code> --as nightwatch --dir ./archives
pnpm --filter @tessera/bot      start <room-code> --apply 2 --play defend
```

`--as nightwatch` is what makes that observer a second door. `--apply 2` makes
the bot ask empire 2 for a seat and keep asking until they vote it in.

### Non-p2p — a relay you own

```sh
# terminal 1: relay + keeper + reads, one process
pnpm --filter @tessera/host start \
  --transport wss --bind 127.0.0.1 --port 8080 --room dev \
  --auto 2 --wait 120 --dir ./archives

# terminal 2
pnpm dev
```

It prints `ws://127.0.0.1:8080/dev`. Paste that into the join box in two tabs.
`--auto 2` seals a two-empire game as soon as both players are present;
`--plan <file>` instead names an exact roster, and `--propose <secs>` puts a
world on the table and seats whoever signs it.

Headless instances join the same string:

```sh
pnpm --filter @tessera/observer start ws://127.0.0.1:8080/dev --as second-keeper
pnpm --filter @tessera/bot      start ws://127.0.0.1:8080/dev --apply 2
```

### The API

```sh
docker compose -f apps/api/compose.yaml up --build     # board + store + postgres
```

or, with rows in memory and no database:

```sh
pnpm --filter @tessera/api start --bind 127.0.0.1 --port 8081 --archives ./store
```

Then in the tab's **Settings** (served over `http` by `pnpm dev`, so a plain
`http://` board is readable):

- Address book → `http://127.0.0.1:8081/games`
- Archive URLs → `http://127.0.0.1:8081/archives/<gameId>`, or
  `http://127.0.0.1:8080/room/dev/archive` straight from the host instance

Tick **List this game publicly** when creating a game and it shows up in the
other tab's Games card. Or have the host keep its own row alive:

```sh
pnpm --filter @tessera/host start --transport wss --port 8080 --room dev \
  --auto 2 --announce http://127.0.0.1:8081/games --ttl 180
```

### No instances at all

```sh
pnpm test      # six peers in one process, deterministic delivery order
pnpm replay    # a whole game headless, prints the resulting state hash
```

---

## 7. What you need running, per thing you want to test

| To exercise | Instances to start | What players type |
|---|---|---|
| Solo play, rendering, input | dev server | — |
| **P2P** | dev server, two browser profiles | the room code |
| **Non-p2p** | dev server + a host | `ws://127.0.0.1:8080/<room>` |
| A seat covered by a program | + a bot | either |
| Archives, verification, local leaderboard | + an observer | either |
| Discovery, listing, joining a stranger's game | + the API, board URL in Settings | either |
| A game outliving the tab that started it | a host, or an observer with a fixed name | either |
| Resuming a game nobody is in | a host serving its resume endpoint | relayed is easiest |
| Reconnect after a network blip | host, then suspend it briefly | `ws://…` |
| NAT traversal / TURN | two machines on different networks | the room code |

Two asymmetries worth knowing before you go hunting bugs:

- **The host never reconnects to itself.** Its keeper attaches to its own relay
  internally, so any bug in reconnect handling shows up in players and never in
  the host.
- **A tab is not a process.** A swiped phone, a crashed tab and a closed lid all
  skip every cleanup hook, so an address book row expires rather than being
  withdrawn.

---

## 8. Instances that don't exist yet

- **A host service** — something you'd POST to and get a fresh room back. Only
  the request shape ships; the Settings field for it stays empty and hides the
  option.
- **A default address book.** None ships, none is assumed.
- **A game composed by more than one person.** Whoever presses start seals it
  alone, so two people in one empty room can each start a game. Agree who
  presses it.
