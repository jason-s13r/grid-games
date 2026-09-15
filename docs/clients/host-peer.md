# The host peer

`apps/host` is a peer that stays. Multi-day games die with the tab that owns them:
a WebRTC room code is the host's peer id, so when the tab closes the door closes.
`tessera-host` is one process that holds the door open and the game's paper trail,
in **either** transport — which is what keeps the decentralised model intact,
because a WebRTC room gets the same persistence as a hosted one.

```
tessera-host [--plan <file> | --auto <n>] [--wait <secs>]
             [--transport wss|rtc] [--room <name>] [--as <id>]
             [--bind 127.0.0.1] [--port 8080] [--ref <wss://…|tsr-…>]
             [--dir ./archives] [--key <path>] [--ice <urls>] [--quiet]
             [--announce <board-url>] [--ttl <secs>] [--reachable <base-url>]
tessera-host import <url> [dir]
```

## A client with a job, never a server of truth

Its authority ends at the genesis: it composes the record and broadcasts it, every
peer runs [`inspectGenesis`](../protocol/genesis.md) on it independently, and
nothing after that point needs a host at all.

*As a peer* it is exactly the [observer](observer.md) that already exists — no
seat, no checkpoints of its own, no vote, no effect on the abandonment rule (which
counts empires by their silence, and a peer with no empire is not in the sum) and
no effect on the stall machinery (which waits on seats). **Its presence changes no
hash.** What its presence does change is the room's membership, which is why
`checkPlan` had to learn about a peer that is deliberately unseated.

*As the relay* it inherits the [room bus](../mesh/room-bus.md) analysis whole, and
the one new capability there is sharper when the relay is not a stranger's server:
it can carry every peer but one, and the seats it silences are proposed for a
`Drop` and ejected by quorum. A malicious host peer's power is **denial of play
escalating to ejection** — never authority, never a forged move, and never
invisible, because the ejection is a quorum-signed record in every archive of that
game.

One property makes serving [resume points](../continuity/resume-points.md) safe: an
observer holds no seat, signs no checkpoints, and can therefore **never be a
witness to the resume point it is keeping.** The host stores and serves an artifact
only the players could have produced, and cannot add itself to the tally at any
price.

## The two transports

| Flag | wss | rtc |
|---|---|---|
| `--room` | the bus room this host serves; minted if absent | ignored — `--as` is the room code |
| `--as` | the peer id inside the room | the PeerJS id, which *is* the room code |
| `--port` / `--bind` | the bus and the reads | the reads only |
| `--ref` | join somebody else's relay instead of serving one | the room code to join |
| `--ice` | ignored | STUN/TURN, replacing PeerJS's own |

`--ref` is the other mode: with it the host is a client of somebody else's room — a
second archiver, or a replacement waiting to take over — and without it the host
serves. It prints the ref players should use, because a room nobody can copy is a
room nobody can join.

**A browser requires `wss://`**, which means a certificate in front of this process
(Caddy, nginx, Let's Encrypt). `ws://` is fine for headless peers, a LAN or
Tailscale, and `--bind` is loopback until you say otherwise — putting a certificate
in front of it should be a deployment step, not a fork.

In socket mode the host attaches to its own bus **in process**
([`localPair`](../mesh/room-bus.md)). Dialling `ws://127.0.0.1` would exercise the
same code every client runs, which is a real argument, and against it: the one peer
whose entire job is not to go away would be subject to its own rate limit, its own
room cap and its own version check, and its liveness inside its own game would
depend on a TCP connection to itself. The cost is worth knowing — **the host never
exercises the reconnect path**, so a bug in the transport's held buffer or backoff
shows up in every player and not in the host.

## Composing the game

A tab has a team picker; a process does not. Two modes, both explicit, because
there is no safe default number of players:

- **`--plan <file>`** names the roster — empires of member keys, bots, map size,
  duration. It seals when every seated key is present, which is also the only
  reading `checkPlan` accepts: a plan seating an absent key is "a stranger is
  seated" until they arrive.
- **`--auto <n>`** seals as soon as `n` players are here, one empire each. Seats
  *within* an empire are a team's business — an empire arrives at an extra pair of
  hands by [voting one in](../continuity/roster-amendments.md), and nobody composes
  somebody else's team.
- **`--wait <secs>`** seals early at a deadline with whoever is present, because a
  host that waits forever for a fifth player is a room three people gave up on.
- **`--vacancies <n>`** holds `n` empires open for people who have not arrived
  yet — the reason a host peer is the natural place to ask for one, since a
  vacancy is only useful in a game that is still there when the person who wants
  it turns up. The flag overrides `vacancies` in the plan file, so a seat can be
  held open without editing a roster you want otherwise unchanged.

A held-open empire **cannot be the second empire**. It is territory rather than a
player, so it is outside every count victory makes — one player plus one vacancy
is one empire standing, and the game would end before anybody could arrive into
the seat. `--auto 1 --vacancies 1` is refused for that reason, and says so. See
[vacancies](../gameplay/empires-and-seats.md).

When both are given, `--auto` wins and the plan file is the *settings* — bots, map,
duration. A refusal from `checkPlan` is **fatal**, not retried: the reasons are
structural (too few empires, a seat for somebody absent, an empire over the cap), so
a host that composes again would be refused again while printing that it is waiting
for players who have already arrived.

The host's own key goes in `watching`. Without it every plan a headless host could
compose is refused as "somebody here has no seat" — the guard that stops a browser
host sealing a game with somebody's name missing from it.

## The three reads

```
GET /room/:code            { room, gameId, step, peers, ended }
GET /room/:code/resume     the newest resume point it holds, or 404
GET /room/:code/archive    the archive it is writing
```

Read-only, `Access-Control-Allow-Origin: *`, and verified by whoever reads them — a
resume point against its [witnesses](../continuity/resume-points.md), an archive by
[replaying it](../trust-and-verification/verifying-an-archive.md). The archive is
cached per flush and answers `If-None-Match` with a 304, because a multi-day log is
megabytes of JSON parsing per request and a poller should cost nothing.

`:code` is looked up in the map of rooms this process is a peer in, and never joined
to a path. The relay is **closed by default** to rooms this process is not in — an
open relay is a different product, `--open-relay` says so out loud — and a joiner
asking for an unknown room is told "no game is running here" rather than sitting in
an empty room it was quietly given.

Nothing is served that accepts anything: no move submission, no snapshot upload, no
identity, no write of any kind. That is worth enumerating rather than implying,
because this is the first component in Tessera with a URL, and the first thing
anyone will want to add to it is an endpoint that accepts something.

## The resume point is a file

`/resume` is read off disk, not derived from the live driver, and the reason is a
four-minute clock. `resumePoint()` needs the snapshot **bytes** and the
**witnesses**: the snapshot store keeps eight and rolls forward every interval on
every peer whether or not anybody is playing, while witnesses only arrive with a
checkpoint from a seat. Eight intervals after the last player leaves the two maps
are disjoint, and a live answer would be `undefined` forever — in the one process
whose whole purpose is that a dormant game is re-enterable in the morning.

So the host polls `resumePoint()` on the archive's flush timer and keeps the newest
it has ever seen. It survives a restart, and it is exactly the artifact a
replacement host fetches.

## Replacement, and what it costs

- **A live game**: the replacement joins, any peer sends it the genesis (every peer
  keeps it, not only the host), and it requests a snapshot from the present. The
  resume point is not involved — it describes a step minutes old, and `resume()`
  refuses a point behind the simulation anyway.
- **A dormant game**: nobody is there to catch up to. The replacement fetches
  `/resume` and `/archive`, checks them, and cold-starts — the case a witnessed
  resume point is actually for.

`tessera-host import <url> [dir]` fetches a predecessor's archive and lays it out,
so a successor continues one archive instead of starting a second fragment. It
refuses to stitch across a hole: a file that claims to be replayable and is not is
the one archive failure this codebase has been careful never to allow.

**Replacement is not transparent.** The game id is stable and a room name can be
re-claimed, but a room on a relay is `wss://host/room` and a new host is a new host
— so players holding the old ref have to be told the new one. `--announce` is how
that happens without a message to everybody: the replacement posts its own door
for the same game id, the client [merges the rows](../mesh/address-book.md), and a
player who looks the game up is handed whichever door is alive.

## Announcing the door

`--announce <board-url>` posts this game to an [address book](../mesh/address-book.md)
and keeps the row alive with a heartbeat at half the `--ttl` (default 180 s). On
SIGTERM it withdraws, so a board is only wrong for as long as it takes a process
to die badly — and a host that is killed, unplugged or segfaulted withdraws
nothing, which is what the TTL is for.

Each heartbeat rebuilds the row, so its witnesses keep up with the game: the
resume point's signatures, carried without its snapshot. **This host signed none
of them and could not have** — it holds no seat — which is exactly why the proof
on the row is worth something.

Nothing claims `seatsUsed`. A host knows how many peers are connected, not how
many seats are held, and announcing the first as the second would be precisely the
claim a client is right not to trust.

`--reachable <base-url>` is the difference between what this process bound to and
what the outside reaches. A certificate, a tunnel or a proxy means the room is at
one URL and the socket at another, and a row carrying a loopback address is a row
nobody can use. One flag covers both the `wss://` door and the `https://` read,
because one port carries both.

## N hosts is redundancy for more than the door

A host that has adopted a snapshot even once holds a **fragment**, and the
[leaderboard](../trust-and-verification/leaderboard.md) refuses fragments by design.
Asking for a snapshot is now the ordinary response to a socket blink, and a host
peer is the process that runs for days across every blink there is — so run two.
They share a game id, a game is counted once however many archives exist, and the
one that gets refused is the one that was disconnected.
