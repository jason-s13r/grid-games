# Architecture

How Tessera is put together, and why the pieces sit where they do. [README.md](README.md)
says what the thing is; this says how to work on it, and [MOVES.md](MOVES.md)
takes the move vocabulary itself one level deeper.

The whole design falls out of one requirement: **peers exchange moves, never
board state.** Everything below is either a consequence of that or a defence of
it.

## The one invariant

`hash(state) = fnv1a(snapshot(state))`.

[`packages/sim/src/state.ts`](packages/sim/src/state.ts) has a single canonical
serialisation, and both the consensus check and the content address of a
checkpoint are built on it. Two peers agreeing on the hash agree on every byte
of state; a snapshot fetched from a stranger can be verified before it is
trusted. That is why there is no second encoding anywhere, and why `cloneState`
copies *through* the snapshot rather than by hand — a clone is bit-identical by
construction instead of by care.

Three consequences run through the rest of the repository:

- **Anything that moves the hash is a breaking change**, even when no exported
  signature changed. Rule tweaks, spawn weights, RNG draw order and snapshot
  layout all qualify. [`dispat.yaml`](dispat.yaml) states the rule; the semver
  on `@tessera/sim` obeys it.
- **`PROTOCOL_VERSION`** ([`constants.ts`](packages/sim/src/constants.ts)) is
  stamped into every genesis record and checked in the `Sim` constructor and in
  `inspectGenesis`. A mismatched major is refused at the lobby, because the
  alternative is a silent desync three hours in.
- **Nothing outside the simulation may enter it.** Camera, chat, signatures,
  socket state and wall-clock stopwatches are all deliberately outside the
  hash. See [What is hashed](#what-is-hashed-and-what-is-not).

## Layers

Dependencies point one way, and the direction is the design:

| Package | Depends on | Knows about |
|---|---|---|
| [`packages/sim`](packages/sim) | *nothing* | tiles, rules, bots. No DOM, no network, no crypto |
| [`packages/protocol`](packages/protocol) | sim | keys, signed records, the wire format |
| [`packages/net`](packages/net) | sim, protocol, peerjs | mesh, lockstep, lobby, archive |
| [`packages/headless`](packages/headless) | net, node-datachannel | a peer with no browser around it |
| [`apps/web`](apps/web) | sim, protocol, net | rendering and input |
| [`apps/observer`](apps/observer), [`apps/bot`](apps/bot) | headless | one program each |

The sim knowing nothing about the network is what makes the network testable:
[`transport.ts`](packages/net/src/transport.ts) defines the four methods
`Lockstep` needs, and `LoopbackNetwork` implements them well enough to run six
drivers in one Node process with deterministic delivery order. "Do peers
converge" is therefore a CI check rather than two browser tabs and a squint.

[`apps/prototype`](apps/prototype) is the original single-player game, frozen.
Nothing depends on it.

## The simulation

### State

Four flat typed arrays indexed `i = y * width + x`, plus empire records:

| Layer | Type | Meaning |
|---|---|---|
| `owner` | `Int8Array` | `0` neutral, `1..N` empire |
| `pop` | `Int32Array` | population, always `>= 0` |
| `terrain` | `Uint8Array` | plain, mountain, lake, river, bridged, wall, laddered |
| `item` | `Uint8Array` | none, bronze, silver, gold, diamond |

Ownership lives in its own layer rather than in the sign of `pop`, which is what
allows N empires and neutral-but-populated tiles. An empire is not a player: it
is a set of seats sharing territory, each with its own population timer. Three
teammates are three independent click streams into one empire, and shift
handover needs no mechanism — the incoming player simply has their own timer.

### One step

`Sim.advance(moves)` in [`sim.ts`](packages/sim/src/sim.ts), in fixed order:

1. **Moves**, sorted by `(empire, member, seq)` — canonical, independent of
   arrival order. Each is re-validated here; an invalid one is dropped
   identically by every peer.
2. **SimBots**, derived from the shared RNG, costing zero bandwidth.
3. **Scheduled events** due at this step.
4. **Accrual, victory check, clock.**

It returns the set of dirty tile indices, which is the only thing a renderer is
ever handed.

### Why events instead of ticks

The step number is derived from real elapsed time since genesis
([`Lockstep.targetStep`](packages/net/src/lockstep.ts)), so the world turns
whether or not anyone is watching — and a peer returning after six hours has
~260,000 steps to cover. Scanning the map per tick would take a minute.

So world updates are scheduled, not swept:
[`events.ts`](packages/sim/src/events.ts) is a binary heap ordered by
`(step, seq)` with a monotonic `seq`, which is a *total* order and therefore one
heap tie-breaks cannot resolve differently on two peers. Coin spawns reschedule
themselves; upkeep is a metronome that deliberately consumes no RNG. Empty steps
cost nothing, and `fastForward` skips straight to the next thing that happens.

The one periodic sweep is [`upkeep.ts`](packages/sim/src/upkeep.ts) — a flood
fill from each capital that decays what it cannot reach and, once the empire has
bought growth, feeds what it can. Two mechanics from one walk, every 20 s of game
time rather than every step.

### Determinism discipline

Every hazard here is a desync that surfaces only between two specific browsers,
twenty minutes in. The rules a contributor has to keep:

- **One RNG.** [`rng.ts`](packages/sim/src/rng.ts) (mulberry32) is the only
  source of randomness in the simulation, its state is one uint32, and it is
  snapshotted — so a restore resumes the exact stream. Never call it inside a
  short-circuiting condition one peer might skip, and never let the number of
  draws depend on anything outside state. `spawnItem` takes four draws per probe
  *whatever branch it takes*, for exactly this reason.
- **Integers only.** No `Math.sqrt`, `pow` or trig in game logic — not
  guaranteed bit-identical across engines. Use `dist2`, and put an explicit
  `Math.floor` on every division. `policy.ts` wants an angle for its expansion
  sweep and compares integer cross-products instead of calling `atan2`.
- **No iteration-order dependence.** Iterate flat arrays by index. Where a `Set`
  or `Map` is used it must not be iterated for anything that reaches state.
- **Derive, don't store.** A bot's phase is `step % cycle` over its declared
  durations, so bots hold no snapshot fields and cannot desync through their own
  bookkeeping. Its tempo is hashed from which pass through the cycle it is —
  drawing from the shared stream would move the coin spawns whenever somebody
  retuned a bot.

### Two kinds of bot

One targeting policy ([`policy.ts`](packages/sim/src/policy.ts)), two homes:

| | **SimBot** | **PeerBot** |
|---|---|---|
| Runs | inside every peer's sim | as its own mesh client ([`peerbot.ts`](packages/net/src/peerbot.ts)) |
| Controls | a whole bot empire | one seat in a human empire |
| Bandwidth | zero | one signed move per action |
| Randomness | the shared seed | its own — moves are validated, not derived |
| Can it drop? | never | yes; the empire simply idles |

A PeerBot must **not** touch the shared stream: a draw made on one peer and
nowhere else is precisely a desync. `policy()` takes optional `forced` and
`focus` arguments for it, and a SimBot passes neither — which is why adding them
moved no hash.

Difficulty is a `BotProfile` in the genesis record, so "the bots were on hard" is
a fact of the game rather than something someone remembers. A bot is not
handicapped: it accrues like anybody and its coins chain like anybody's. Its
strength is `popMax` alone, since a claim spends `min(steps waited, popMax)`.

## The protocol

[`packages/protocol`](packages/protocol) is everything a peer can *say* that
another peer must believe.

- **Identity** ([`identity.ts`](packages/protocol/src/identity.ts)) — an ECDSA
  P-256 keypair; the public key *is* the member. P-256 rather than Ed25519 only
  because browser Web Crypto support for Ed25519 is still patchy. The same
  keypair is re-imported as ECDH for team chat; the two uses are separated by
  domain-tagged payloads and per-use HKDF, so neither can produce something the
  other would accept.
- **Genesis** ([`genesis.ts`](packages/protocol/src/genesis.ts)) — the root of
  trust, and **its hash is the game id**. `canonicalJson` sorts keys and drops
  `undefined` so two peers derive byte-identical bytes; `gameIdOf` hashes the
  record with its own id removed, because a hash cannot contain itself.
  `inspectGenesis` is everything a peer checks before agreeing to play,
  including the seat cap — a peer that only checked amendments would join an
  unfair game and then faithfully enforce fairness for the rest of it.
- **Roster** ([`roster.ts`](packages/protocol/src/roster.ts)) — a signed move
  carries `(empire, member)` and **no key**. The roster says which key sits
  there. If the key travelled in the move, "signature valid for the key it
  names" would prove nothing at all.
- **Records** ([`records.ts`](packages/protocol/src/records.ts)) — every signed
  payload carries a domain tag (so a move signature cannot be replayed as a chat
  signature), the game id (so it cannot be replayed into another game), and
  fixed-width range-checked fields (so two different moves cannot encode to the
  same bytes).
- **Wire** ([`wire.ts`](packages/protocol/src/wire.ts)) — JSON framing,
  deliberately. Frames are not signed, so nothing here needs to be canonical,
  and reading a session in a console is worth the bytes. `decodeFrame` returns
  null rather than throwing: a peer may send anything, and none of it should
  raise on the receiving side.

## The mesh

### Transport

[`mesh.ts`](packages/net/src/mesh.ts) is a full mesh of WebRTC data channels
introduced by PeerJS's public broker. The broker is signalling and nothing else
— it never sees a move. The host's peer id is the room code.

Two traps are documented in the file because both cost real versions:

- PeerJS's `config` is merged **one level deep**, so passing one *replaces* its
  defaults, TURN relays included. It is now sent only when a caller actually
  asks for a relay. [`ice.test.ts`](packages/net/src/test/ice.test.ts) holds it.
- PeerJS refuses an oversized JSON message on the *sender*, silently. Frames
  above 15 kB are sliced and reassembled here, with a bounded number of partials
  per peer so a hostile peer cannot exhaust memory.

[`hub.ts`](packages/net/src/hub.ts) is the loop-back for several drivers in one
page — a locally seated PeerBot would otherwise sign moves every remote peer
applied and its own tab never heard. Ports look exactly like a `Transport`, so
`Lockstep` never learns that some seats are local.

### Lockstep

[`lockstep.ts`](packages/net/src/lockstep.ts) is the largest file in the
repository and the one to read first. Three rules make agreement hold:

1. **A step is not simulated until every seat that could contribute to it has
   said it will not.** That is the whole of the consensus protocol.
2. **"Could contribute" comes from the simulation, never from sockets.** A seat
   is live if its last `HEARTBEAT` is inside the liveness window — a
   deterministic function of the log, identical on every peer. Peers genuinely
   disagree about who is reachable, and that disagreement would otherwise become
   a desync.
3. **An input is bound to its step before it is sent**, `inputDelay` steps ahead
   (3, ~250 ms at 12 steps/s), so a claim never has to arrive in the past.

The driver holds no timer; the caller pumps it. That is what makes six peers in
one process a deterministic experiment rather than a race.

**Readiness** replaces a `PASS` per seat per step: one signed cumulative
assertion, "I will send nothing more for steps up to here". Submitting a move
holds readiness below the move's slot until the signature is actually out, or a
`READY` could overtake the move it was promising about and invite everyone past
the step it belongs to. Frames from one peer are verified in a serial lane for
the same reason.

**Recovery paths**, all four decided by a record rather than by a stopwatch:

| Failure | Detected by | Resolved by |
|---|---|---|
| Silent seat | wall clock (proposal only) | quorum-signed `Drop` naming an exact step |
| Desync | checkpoint hash comparison | minority rebuilds from a snapshot; persistent disagreement is proposed for a drop |
| Equivocation | two valid signatures on one `(empire, member, step, seq)` | ejection at `max(step) + EJECTION_DELAY`, derived from the proof |
| Arriving late | `targetStep() - sim.step` at start | snapshot request, then replay |

The asymmetry in the desync path is deliberate: **detection is symmetric,
escalation is not.** A peer that disagrees with everybody is likelier to be the
broken one than everybody is, so a minority rebuilds and says nothing. Proposals
are staggered by `proposerRank` so two peers cannot each fall short of a
majority and leave a seat neither dropped nor trusted.

Ejection steps and drop steps live *inside* the record. Everyone who accepts it
stops waiting on precisely that step, whether they learned of it a second or a
minute later — which is what keeps a local stopwatch from becoming a consensus
input.

### Snapshots and resume

[`snapshots.ts`](packages/net/src/snapshots.ts) keeps a short tail of
checkpoints content-addressed by state hash. `adopt()` restores, hashes, and
puts the old state back if the number disagrees — so **a snapshot from an
untrusted peer is safe to accept.** That single property is what lets an archive
peer exist without becoming an authority, and what lets a player who closed the
tab three hours ago rejoin from whoever happens to be online.

A snapshot travels with the amendments and drops behind it, because the
simulation inside one knows members by index and nothing about keys; both are
re-verified against their quorums on arrival.

### Chat

The log carries two classes of entry: **moves, which change state and are
hashed**, and **messages, which are ordered, signed and attributable but are
not**. Keeping chat outside the hash is exactly what makes it safe — a message
that arrives late, out of order, or not at all can never desync a game, and
[`chat.test.ts`](packages/net/src/test/chat.test.ts) proves it by dropping every
message on one peer and checking the hash is unchanged.

Team chat is per-message fanout, not a group key
([`secrets.ts`](packages/protocol/src/secrets.ts)): a random content key
encrypts the text and is wrapped once per teammate over ECDH. Nobody has to be
online to receive a key and an amended member can be written to immediately. The
honest cost is that there is no single team key to publish afterwards, so an
archived team channel stays sealed.

### Archive and rankings

[`archive.ts`](packages/net/src/archive.ts) writes `{ genesis, moveLog,
amendments, messages, steps, hash, from }` in the format `pnpm replay --log` has
read since the beginning, so an archived game is checked by the tool that has
been guarding determinism all along.

`verifyArchive` trusts nothing in the file: it re-hashes the genesis, rebuilds
the roster from it, checks every signature against that roster, and replays the
log to the hash it claims. `from` records where a partial log starts — a peer
that joined an hour in holds a fragment, and saying so is the difference between
an honest partial archive and an unexplained hash mismatch.

[`rankings.ts`](packages/net/src/rankings.ts) is a *derivation* rather than a
record: every figure is read out of hashed state after replaying a verified log.
The interesting part is refusal — a fragment does not count, an edited log does
not count, and a game counts once however many observers kept it.

## The client

[`apps/web`](apps/web) renders and takes input. It decides nothing about the
game.

`Driver` ([`game/Driver.ts`](apps/web/src/game/Driver.ts)) is the boundary:
`LocalGame` queues moves for a future step and applies them through `advance()`
exactly as `OnlineGame` hands them to `Lockstep`. Solo play is the same
simulation with a different source of moves, which is why `Controls` and
`main.ts` never learn which one they have.

Rendering is two renderers behind one interface, chosen by zoom:

- **Close in**, real DOM tiles carry the conic-gradient flag art. Elements live
  in a flat index and are recycled through a pool; only tiles the sim reported
  dirty are touched. (The prototype ran a `querySelector` per cell per frame.)
- **Zoomed out** (below `DOM_MIN_ZOOM`, 11 px/tile), the DOM is dropped for a
  scaled blit of [`MapImage`](apps/web/src/view/MapImage.ts) — one image of the
  whole map at one pixel per tile, kept current at one pixel write per changed
  tile. The minimap is a second blit of the same buffer, which makes it close to
  free.

Zoom is a ladder of whole pixels per tile, because fractional tile sizes mean
sub-pixel seams. Camera state is pure view: never in the sim, never hashed,
never sent. Two peers looking at different corners are in perfect consensus.

## Peers without a browser

[`packages/headless`](packages/headless) is thinner than it looks, because
everything below the lobby already ran under Node — that is what the test
harness is. It installs a WebRTC implementation where PeerJS expects one, keeps
a key in a file at `0600`, pumps on a timer instead of an animation frame, and
appends the archive to disk a line at a time.

`node-datachannel` is the only native dependency in the repository, and it is
here because PeerJS reads `RTCPeerConnection` off the global object with no
injection point. `shutdownWebRTC` exists because libdatachannel keeps threads
alive after the last connection closes, which looks exactly like a hang.

## The life of a move

Worth following end to end, because it crosses every layer:

1. A click on a tile reaches [`input.ts`](apps/web/src/game/input.ts), which
   decides what it *means* — there are no modes, so the click says where and the
   board says what: bridges go on rivers, ladders on walls, a claim one tile too
   far is a march. It deliberately re-checks neither stock nor adjacency; that is
   validation's business, and stating it twice is how the two drift apart.
2. `OnlineGame.act` asks the local sim to validate — **UI feedback only** — then
   calls `Lockstep.submit`.
3. `submit` stamps the move for `step + inputDelay`, takes the next `seq`, drops
   the readiness ceiling to that slot, signs, stashes locally and broadcasts.
4. Every peer receives a `MOVE` frame, verifies the signature *against the seat
   the roster names* (never against a key in the move), feeds it to the
   equivocation watch, and stashes it under its step.
5. When the wall clock reaches that step and no live seat is still owed a
   promise, every peer sorts the step's moves by `(empire, member, seq)` and
   calls `sim.advance`.
6. `validate` runs again inside the simulation — this time authoritatively. An
   illegal move dies identically everywhere, with no trust and no negotiation.
7. Dirty indices come back; the renderer repaints them and `MapImage` updates
   one pixel per tile.
8. Every `checkpointInterval` steps each peer broadcasts a signed hash. Every
   `snapshotInterval` it keeps a checkpoint. An observer appends the signed move
   to `log.jsonl`.

The two validations are not redundancy. The first is so a rejected click feels
rejected; the second is the one that decides, and it is the entire anti-cheat
story — `validate()` in [`rules.ts`](packages/sim/src/rules.ts) is a pure
function of state, so every peer reaches the same verdict without asking anyone.

Every move takes that path, a purchase included: `BUY_BRIDGE` and `BUY_MARCH`
are signed, gossiped and validated exactly as a claim is, and no message
anywhere reports a diamond balance — every peer derives every empire's stock,
unlocks and stat counters, because all of it is inside the hashed snapshot. The
eleven move types, their fields and their validation are catalogued in
[MOVES.md](MOVES.md).

## What is hashed, and what is not

| In the hash | Outside it |
|---|---|
| Board layers, empire and member records | Signatures (randomised; two peers signing one move differ) |
| Scheduled events, RNG state | Chat messages, public and team |
| Stats, per member and per empire | Camera, zoom, muting, panel state |
| Roster *size* and member kinds | Member keys — the sim addresses seats by index |
| Win state and elimination step | Socket state, peer lists, stopwatches |

Stats being in hashed state is what makes end-of-game figures consensus by
construction: no client reports them, so no server has to be trusted not to
believe a lying one.

## Trust model

Anyone may connect and observe. Only keys in the roster produce accepted moves,
so an arbitrary mid-game join is an observer **by construction** — there is no
mechanism to configure and nothing to switch off.

What an attacker cannot do: forge a move for a seat they do not hold (signature
against the roster), replay a move into another game or as another record type
(domain tag and game id), submit an illegal move (every peer validates), lie
about the outcome (stats are hashed and archives are replayed), hand out a
poisoned snapshot (content-addressed, verified before adoption), or vote
themselves a bigger team (seat cap in genesis *and* on every amendment).

What they can do: equivocate — and because the mesh gossips every move it sees,
that is *detected* rather than merely suspected, with a self-contained proof any
peer can check. And a relay can drop packets, which is why TURN is a bandwidth
dependency and never an authority one.

## Verification

The suites are organised by invariant rather than by file:

| Suite | Holds |
|---|---|
| [`sim/test/rules`](packages/sim/src/test/rules.test.ts), `march`, `annex`, `upkeep`, `mapgen` | the rules themselves, as numbers rather than reasoning |
| [`sim/test/determinism`](packages/sim/src/test/determinism.test.ts) | same seed, same log, same hash — twice, over thousands of steps |
| [`sim/test/crossenv`](packages/sim/src/test/crossenv.test.ts) | a *recorded* game reaching one hash in Node, Chromium, Firefox and WebKit |
| [`net/test/convergence`](packages/net/src/test/convergence.test.ts) | the baseline: inputs only, bit-identical peers |
| `net/test/{desync,stalls,equivocation,forgery,resume}` | each recovery path above |
| `net/test/{amendment,peerbot,chat,teams,archive,rankings,hub,ice,chunking,readiness}` | the rest of the mesh's contracts |

The cross-environment check is the load-bearing one, and it is deliberately run
in four engines: Chromium is V8 as Node is, so that pairing catches a bundler
difference and never an engine one. WebKit and Firefox are the two that would
actually disagree about a float or an iteration order. It replays a recorded
game rather than a seeded one, because a seeded game exercises the world's
machinery and none of the move path.

`pnpm replay` is the same check as a tool. `--record` writes the fixture the
suites read.

## Build and release

pnpm workspace, TypeScript 5.6, ES2022, `verbatimModuleSyntax` — the sim is
written in erasable syntax only, so it runs under Node's native type stripping
and under any bundler with no transform. Vitest resolves `@tessera/*` to `src`
through [`vitest.shared.ts`](vitest.shared.ts), so a test run compiles nothing
and a stack trace lands on the line you are about to edit.

[`dispat.yaml`](dispat.yaml) drives releases from conventional commits in
dependency order. Libraries ship as tarballs on their GitHub release; apps ship
as zips of the exact bundle deployed. [`pages.yml`](.github/workflows/pages.yml)
is called by the release workflow rather than triggered by a push to main — what
Pages serves is always a version that was actually cut.

## Known constraints

- **TURN.** Roughly one peer pair in five sits behind symmetric NAT and needs a
  relay. PeerJS ships relays and uses them unless told otherwise; `--ice` points
  at one you run. "Serverless" means zero *authority* servers, and that property
  survives a relay intact.
- **`node-datachannel`** is native, so a headless peer needs prebuilt binaries
  for its platform. Everything else here is portable TypeScript.
- **An archived team channel stays sealed.** Per-message fanout has no group key
  to publish afterwards — a deliberate trade, not an unbuilt feature.
- **Byte widths bound the roster.** Empire and member ids ride in single bytes of
  every signed move, so 255 empires and `SEAT_CEILING` of 32 are hard limits
  rather than tunables.
- **Map size is bounded by memory, not by design.** At 1024×1024 the four layers
  are ~7 MB; map size is a genesis parameter.
