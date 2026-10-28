# Tessera

A browser recreation of the grid territory game **Empire Attack**.

> **Credit where it's due.** Empire Attack was conceived by
> [Ian Andrew](https://www.ianandrew.com/empire-attack), jointly designed with
> Jon Grove, who programmed it. It ran from 2008 to 2017. Tessera is an
> independent recreation built out of affection for it, not affiliated with or
> endorsed by its creators.

## How it works

Clients exchange **moves, never board state**. Every client runs a bit-identical
simulation from a shared seed, so the same ordered moves produce the same world
everywhere, and a hash of the state shows whether two clients agree. Every
client validates every move against its own simulation, so an illegal move dies
identically everywhere.

The state hash is therefore the compatibility contract: **any change that moves
the hash is a breaking change**, even when no exported signature changed.

[ARCHITECTURE.md](ARCHITECTURE.md) is how the pieces fit together;
[MOVES.md](MOVES.md) is the move vocabulary; [docs/](docs/) is the detailed
game and simulation reference.

## Where it's going

Online play is being rebuilt on Cloudflare and will be served from
**tessera.qot.nz**:

- One Worker serves the web client and the API.
- A Durable Object per game orders moves into steps, keeps the move log and
  snapshots, and keeps the game running while nobody is connected.
- Every client still runs the full simulation and validates every move.
  Cloudflare keeps time and records; the players keep the rules.

The menu creates an online game or joins one by link, shows its lobby while
people pick empires, and switches to the board when it starts. A reload, or a
link opened tomorrow, catches up to wherever the game has got to; a link opened
by somebody without a seat spectates.

## Layout

| Package | What it is |
|---|---|
| [`packages/sim`](packages/sim) | `@tessera/sim` — the deterministic core. Rules, RNG, snapshots, bots, victory. No DOM. |
| [`packages/protocol`](packages/protocol) | `@tessera/protocol` — identities, signed moves and messages, the genesis record. |
| [`packages/room`](packages/room) | `@tessera/room` — the game room that orders moves, and the client side of it. |
| [`apps/web`](apps/web) | The browser client: virtualised viewport, LOD renderer, minimap. |
| [`apps/worker`](apps/worker) | The Cloudflare Worker: serves the client, creates games, hosts each one in a Durable Object. |
| [`apps/prototype`](apps/prototype) | The original single-player prototype, frozen as reference and served at `/prototype/`. |

## Running it

```sh
pnpm install
pnpm dev            # everything at http://localhost:8787: client, API, game rooms
pnpm dev:solo       # the client alone at http://localhost:1234, solo play only
pnpm test           # rules, determinism, protocol, room, client
pnpm replay         # headless: run a game, print the state hash
pnpm --filter @tessera/worker smoke   # two players through a running `pnpm dev`
```

`pnpm dev` builds the packages and the client, then runs Parcel in watch mode
beside `wrangler dev`, which serves the client's build, the API and the
Durable Objects on one port. Game state lives in `apps/worker/.wrangler/`
between runs.

`pnpm replay` is the load-bearing tool. Node and a browser must agree on the
hash for the same seed and move log. `--log <file>` replays a recorded game
rather than a seeded one, and `--record <file>` writes one.

That check is also a test. A recorded game is replayed in Node, Chromium,
Firefox and WebKit, and all four must reach the same hash. The browsers come
from Playwright; `pnpm --filter @tessera/web exec playwright install` fetches
them, and `BROWSERS=chromium pnpm --filter @tessera/web test` narrows the loop.
