# The lobby

[`Lobby`](../../packages/net/src/lobby.ts#L77) gets from "two peers who found
each other" to "one agreed game". It lives in `net` rather than the client
because a [headless peer](../clients/headless-peers.md) needs exactly the same
handshake — the [observer](../clients/observer.md) and [bot](../clients/bot.md)
join a running game the way a reloading tab does.

## The one question

The lobby exists to answer one question before any simulation starts: **who is
playing, and under which key.** Once the host has that, it builds the
[genesis](../protocol/genesis.md) record — whose hash is the game id — and
broadcasts it. Every peer then finds its own key in the roster and knows which
seat it holds. Nothing after that needs a host at all.

## Phases

`LobbyPhase` = `connecting | hosting | waiting | playing | failed`.

- `Lobby.open(identity, ref?, { id?, iceServers?, connect? })` — static async; a
  transport arrives here on demand, and which one is decided by the
  [ref](connection-refs.md).
- **`undefined` means host.** A ref is a string somebody typed and nobody types
  "host", so absent a ref we are the room. `connect` replaces the opener, which
  is how the lobby is tested without a broker — and how a
  [host peer](../clients/host-peer.md) attaches to the relay it is running.
- **`hosting`** says it outright, for the case a ref cannot express: a socket room
  is hosted by the peer serving it. It means "nobody is going to send me a genesis
  record" — no watchdog, phase `hosting` — and without it a host waiting for the
  players it exists to wait for is killed by the joiner's watchdog after fifteen
  seconds.
- **A joiner greets the room it arrives into.** A mesh introduces peers as they
  dial, so every arrival is an event; a room on a relay is a place you arrive into,
  and its membership arrives with the welcome, before `open` has returned.
- `lobby.code` is the short room token — a peer id on WebRTC, a room name on a
  socket — and is what seeds the map. `lobby.shareable` is what a player sends to
  somebody else: identical for a WebRTC room, a whole link for a socket one.
- **Joining** sends a `HELLO` frame with `gameId: ""` — the one moment in the
  protocol where that is true, and why a lobby hello proves nothing beyond "here
  is a key to seat me under". Everything that decides anything is signed against
  a real game id.
- `JOIN_TIMEOUT_MS = 15000` watchdog. Reaching the broker is **not** the same as
  reaching the host; a symmetric-NAT failure is silent (no error, the channel
  just never opens).

## Hosting: compose, seal, broadcast, then no authority

[`host(plan: HostPlan)`](../../packages/net/src/lobby.ts#L253):

1. [`checkPlan`](#checkplan) — refuse a bad plan while the host can still fix it.
2. Build `EmpireSpec[]` — human empires are the people who are here (one seat per
   key); `plan.simbots: Difficulty[]` become whole [SimBot](../gameplay/bots.md)
   empires.
3. `makeGenesis({ seed: seedFrom(`${code}:${Date.now()}`), startedAt: Date.now(),
   map: { width, height }, empires })`.
4. [`sealGenesis`](../protocol/genesis.md) — stamp the id.
5. Broadcast a `GENESIS` frame, then `adopt` it locally.

Teams are the host's to arrange **because the host composes the genesis** — and
once it is sealed and broadcast, every peer verifies it for itself and the host
has no further authority over anything. The host can leave; a peer that kept
`sealed` re-sends `GENESIS` to a later joiner.

## adopt — check, then find your seat

[`adopt(genesis)`](../../packages/net/src/lobby.ts#L291): run
[`inspectGenesis`](../protocol/genesis.md) (fail on any problem), then scan the
roster for one of this identity's keys → `Seat | undefined`.

**No seat is not a failure.** An unkeyed or unlisted peer is an
[observer by construction](../concepts/peers-and-roles.md) — it validates and
stores the game exactly as a player does, holds nothing, and can be voted a seat
later by [`ROSTER_AMEND`](../continuity/roster-amendments.md). `onStart(genesis,
seat, transport)` fires, and the client / headless peer builds its
[`Lockstep`](../continuity/lockstep.md).

## The lobby owns the connection's only listener

A joiner cannot build its driver until the `GENESIS` frame arrives, and game
frames share the channel with it — so anything that turns up in that gap is
buffered in the lobby's `backlog` (bounded 4096) and replayed into the driver's
transport the moment `listen` is called.

## checkPlan

[`checkPlan(plan, expected)`](../../packages/net/src/teams.ts#L74) → `""` or a
reason: "nobody is seated", "somebody is seated twice", "an empire has no
members", "a stranger is seated", "somebody here has no seat", "an empire may
hold up to 4 seats", "a game needs at least two empires".
[`composeTeams`](../../packages/net/src/teams.ts#L32) compacts empire numbers —
a host who puts everyone on empire 3 has made *one* empire, not four.
`MAX_SEATS = min(DEFAULT_RULES.maxSeats, SEAT_CEILING) = 4`, read from the
defaults so the picker and the simulation cannot drift apart.
[`teams.test.ts`](../../packages/net/src/test/teams.test.ts) holds the compaction
and the refusals.
