# Architecture

How Tessera is put together, and why the pieces sit where they do. [README.md](README.md)
says what the thing is; this says how to work on it, and [MOVES.md](MOVES.md)
takes the move vocabulary itself one level deeper.

The design falls out of one requirement: **clients exchange moves, never board
state.** Every client runs the same deterministic simulation from a shared seed,
so the same ordered moves always produce the same world.

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
  layout all qualify, and bump `PROTOCOL_VERSION`.
- **`PROTOCOL_VERSION` and `SUPPORTED_PROTOCOLS`**
  ([`constants.ts`](packages/sim/src/constants.ts)) are two ideas that used to
  share a name. `PROTOCOL_VERSION` is stamped into every genesis this build
  composes; `SUPPORTED_PROTOCOLS` is every version it can play, verify and
  replay. The `Sim` constructor and `inspectGenesis` check membership in the
  set, not equality with the constant — a version nobody supports is refused at
  the door, because the alternative is a silent desync three hours in.
- **A build supports N and N-1, and no more.** A superseded version is dropped
  once no game can still be running on it; `PROTOCOL_SUNSET` carries the date
  and a test fails the day it passes. A running game is never upgraded — its
  protocol is inside its own game id, so changing it would invalidate every
  signature already cast.
- **Nothing outside the simulation may enter it.** Camera, chat, signatures,
  socket state and wall-clock stopwatches are all deliberately outside the
  hash. See [What is hashed](#what-is-hashed-and-what-is-not).

## Layers

| Package | Depends on | Knows about |
|---|---|---|
| [`packages/sim`](packages/sim) | *nothing* | tiles, rules, bots. No DOM, no network, no crypto |
| [`packages/protocol`](packages/protocol) | sim | keys, signed moves and messages, the genesis record |
| [`apps/web`](apps/web) | sim, protocol | rendering and input |

Online play is being rebuilt around Cloudflare. A Durable Object per game will
order moves into steps, keep the log and snapshots, and keep the game running
while nobody is connected; every client still runs the full simulation and
validates every move. That adds `packages/room` (the sequencer and its client)
and `apps/worker` (the Worker that serves the client and hosts the rooms).

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

The step number is derived from real elapsed time since genesis, so the world
turns whether or not anyone is watching — and a client returning after six hours has
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

| | **SimBot** | **Bot client** (planned) |
|---|---|---|
| Runs | inside every client's sim | as its own program, connected like a player |
| Controls | a whole bot empire | one seat in a human empire |
| Bandwidth | zero | one signed move per action |
| Randomness | the shared seed | its own — moves are validated, not derived |

A bot client must **not** touch the shared stream: a draw made on one client and
nowhere else is precisely a desync. `policy()` takes optional `forced` and
`focus` arguments for it, and a SimBot passes neither.

Difficulty is a `BotProfile` in the genesis record, so "the bots were on hard" is
a fact of the game rather than something someone remembers. A bot is not
handicapped: it accrues like anybody and its coins chain like anybody's. Its
strength is `popMax` alone, since a claim spends `min(steps waited, popMax)`.

## The client

[`apps/web`](apps/web) renders and takes input. It decides nothing about the
game.

`Driver` ([`game/Driver.ts`](apps/web/src/game/Driver.ts)) is the boundary:
`LocalGame` queues moves for a future step and applies them through `advance()`
exactly as an online driver will apply the batches a game room sends. Solo play
is the same simulation with a different source of moves, which is why
`Controls` and `main.ts` never learn which one they have.

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

## Verification

| Suite | Holds |
|---|---|
| [`sim/test/rules`](packages/sim/src/test/rules.test.ts), `march`, `annex`, `upkeep`, `mapgen` | the rules themselves, as numbers rather than reasoning |
| [`sim/test/determinism`](packages/sim/src/test/determinism.test.ts) | same seed, same log, same hash — twice, over thousands of steps |
| [`sim/test/crossenv`](packages/sim/src/test/crossenv.test.ts) | a *recorded* game reaching one hash in Node, Chromium, Firefox and WebKit |
| [`protocol/test`](packages/protocol/src/test) | signatures bound to their seat, record type and game |

The cross-environment check is the load-bearing one, and it is deliberately run
in four engines: Chromium is V8 as Node is, so that pairing catches a bundler
difference and never an engine one. WebKit and Firefox are the two that would
actually disagree about a float or an iteration order.

`pnpm replay` is the same check as a tool. `--record` writes the fixture the
suites read.

## Build

pnpm workspace, TypeScript 5.6, ES2022, `verbatimModuleSyntax` — the sim is
written in erasable syntax only, so it runs under Node's native type stripping
and under any bundler with no transform. Vitest resolves `@tessera/*` to `src`
through [`vitest.shared.ts`](vitest.shared.ts), so a test run compiles nothing
and a stack trace lands on the line you are about to edit.

## Known constraints

- **Byte widths bound the roster.** Empire and member ids ride in single bytes of
  every signed move, so 255 empires and `SEAT_CEILING` of 32 are hard limits
  rather than tunables.
- **Map size is bounded by memory, not by design.** At 1024×1024 the four layers
  are ~7 MB; map size is a genesis parameter.
