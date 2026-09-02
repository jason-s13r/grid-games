# Tessera

A serverless, peer-to-peer recreation of the grid territory game **Empire Attack** —
static HTML and WebRTC, with no server holding authority over the game.

> **Credit where it's due.** Empire Attack was conceived by
> [Ian Andrew](https://www.ianandrew.com/empire-attack), jointly designed with
> Jon Grove, who programmed it. It ran from 2008 to 2017. Tessera is an
> independent recreation built out of affection for it, not affiliated with or
> endorsed by its creators.

## How it works

Peers exchange **moves, never board state**. Every peer runs a bit-identical
simulation from a shared seed and periodically broadcasts a hash of its state;
a mismatch means desync. A CRDT was considered and rejected — CRDTs guarantee
*convergence*, not *correctness*, and offer no place to reject an illegal move.
Under lockstep a peer can only submit inputs, and every peer validates every
input against its own simulation, so a bad move dies identically everywhere.

The state hash is therefore the compatibility contract, which makes versioning
stricter than usual: **any change that moves the hash is a breaking change**,
even when no exported signature changed. See [`dispat.yaml`](dispat.yaml).

## Layout

| Package | What it is |
|---|---|
| [`packages/sim`](packages/sim) | `@tessera/sim` — the deterministic core. Rules, RNG, snapshots, bots, victory. No DOM. |
| [`apps/web`](apps/web) | The browser client: virtualised viewport, LOD renderer, minimap. |
| [`apps/prototype`](apps/prototype) | The original single-player prototype, frozen as reference. |

## Running it

```sh
pnpm install
pnpm dev            # the game at http://localhost:1234
pnpm test           # the suites: rules, determinism, protocol, mesh
pnpm replay         # headless: run a game, print the state hash
```

`pnpm replay` is the load-bearing tool. Two peers — or Node and a browser —
must agree on the hash for the same seed and move log, and that check is what
the whole networking design rests on. `--log <file>` replays a recorded game
rather than a seeded one, and `--record <file>` writes one.

That check is also a test. A recorded game is replayed in Node, Chromium,
Firefox and WebKit, and all four must reach the same hash — Chromium alone
would prove little, since it is V8 as Node is. The browsers come from
Playwright; `pnpm --filter @tessera/web exec playwright install` fetches them,
and `BROWSERS=chromium pnpm --filter @tessera/web test` narrows the loop.

## Status

- [x] Deterministic simulation core, verified headlessly and in three browsers
- [x] Browser client, local play against bots
- [x] P2P mesh: signed moves, hash voting, snapshot resume, team chat
- [ ] Observer/archive peers and verifiable rankings

An observer already works in the browser: a peer whose key is not in the roster
validates and follows the game and simply holds nothing. What is missing is the
*durable* half — a headless peer that keeps a multi-day game alive while every
player is asleep, and the recorded log that makes a leaderboard checkable
rather than reported. Snapshots today are a short in-memory tail.

See [PLAN.md](PLAN.md) for the full architecture.
