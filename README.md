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
| [`packages/protocol`](packages/protocol) | `@tessera/protocol` — identities, signed records, the genesis seal, the wire format. |
| [`packages/net`](packages/net) | `@tessera/net` — the mesh, the lockstep driver, the lobby, and the archive. |
| [`packages/headless`](packages/headless) | `@tessera/headless` — running a peer with no browser around it: WebRTC under Node, a key in a file, an archive on disk. |
| [`apps/web`](apps/web) | The browser client: virtualised viewport, LOD renderer, minimap. |
| [`apps/observer`](apps/observer) | An always-on peer with no seat. It keeps a game alive and writes it down. |
| [`apps/bot`](apps/bot) | A headless peer that holds one seat — night cover for an empire that is asleep. |
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

## Peers without a browser

A game that runs for days needs somebody awake in it, and "somebody" should not
have to mean a server with power over the result. Two programs cover it, and
neither can do anything a browser tab could not:

```sh
pnpm --filter @tessera/observer start tsr-abc123 --as tsr-nightwatch
pnpm --filter @tessera/bot      start tsr-abc123
```

The **observer** holds no seat. It validates every move, hashes every step and
writes the game down — and with `--as` it claims a stable peer id, which
matters more than it sounds: a room code *is* a peer id, so a game whose host
has closed their laptop is reachable at whatever peer is still up. It also
checks archives, including ones it did not write:

```sh
tessera-observe export archives/<gameId>     # the directory as one file
tessera-observe verify archives/<gameId>     # genesis, signatures, and the hash
tessera-observe rank   archives              # the table, from every game under it
```

`verify` trusts nothing in the file. It re-hashes the genesis record, rebuilds
the roster from it, checks every signature against that roster, and replays the
log to see whether it reaches the hash it claims — so an edited move, an
invented one, a deleted one and a simply-asserted outcome are four distinct
failures and all four are caught. That is what makes a leaderboard checkable
rather than reported. The browser client hands you the same file: **Save log**.

`rank` is that leaderboard. It verifies every archive in a directory and builds
the table out of the replays — so no figure in it was ever reported by anybody,
and anyone holding the same files computes the same table. The refusals are
printed alongside it, since a leaderboard that silently drops what it could not
check is one nobody can audit. A game counts once however many observers kept
it, and a fragment counts not at all: the stats depend on the part it is
missing.

The **bot** holds one seat, so a team can sleep without losing ground. It is
seated the way any substitute is — it joins as an observer, prints its key, and
an empire votes it in with `ROSTER_AMEND`. There is no bot-shaped mechanism
anywhere in the protocol, and there should not be.

How it plays is yours: `--play` picks defending, expanding, attacking, banking
or cycling through all four, `--target` says whose capital to walk at, and
`--rate` is how long it banks between claims. `--hours 22-07` and `--duty 20/40`
are the balance lever — a seat that never sleeps has reflexes nobody can match
by staying awake, so it can be told to keep to a shift. What it *costs* the
empire is not configurable: accrual and cap are hashed state keyed off the
seat's kind, so the host prices the seat and the bot only decides how to play
it.

The one unpleasant dependency lives here: PeerJS wants a global
`RTCPeerConnection`, so a headless peer needs `node-datachannel`, a native
module with prebuilt binaries per platform. Everything else in this repository
is portable TypeScript.

## Status

- [x] Deterministic simulation core, verified headlessly and in four engines
- [x] Browser client, local play against bots
- [x] P2P mesh: signed moves, hash voting, snapshot resume, team chat
- [x] Observer and archive peers, and logs anyone can verify
- [x] A leaderboard that reads them, and refuses what it cannot check

See [PLAN.md](PLAN.md) for the full architecture.
