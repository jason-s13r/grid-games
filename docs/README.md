# Tessera — system reference

Tessera is a serverless, peer-to-peer recreation of the grid-territory game
*Empire Attack*. Browsers (and headless Node processes) form a WebRTC mesh with
**no authoritative server**. Peers exchange **moves, never board state**: every
peer runs a bit-identical deterministic simulation from a shared seed, and a
periodically broadcast hash of that state is the entire consensus and
compatibility contract.

This `/docs` tree is the detailed reference for **how the game plays and how the
mesh holds it together**. It describes the code as it stands at commit `d0a9d5b`.
It is self-contained: where it overlaps the root [`ARCHITECTURE.md`](../ARCHITECTURE.md)
and [`MOVES.md`](../MOVES.md), it goes further, and you should not need to read
those to follow these.

Out of scope here: CI, the release process, `dispat`, changelogs, deployment and
GitHub Pages. This is about the game.

## Where to start

1. [concepts/moves-not-state.md](concepts/moves-not-state.md) — the one
   requirement the whole design falls out of.
2. [concepts/the-one-invariant.md](concepts/the-one-invariant.md) — the state
   hash, and why it is the compatibility contract.
3. [gameplay/README.md](gameplay/README.md) — a game from a player's chair.
4. [continuity/the-life-of-a-move.md](continuity/the-life-of-a-move.md) — one
   click followed end to end across every layer.

## The map of the tree

| Folder | What it covers |
|---|---|
| [concepts/](concepts/) | The founding ideas: moves not state, the invariant, peers and roles, time |
| [gameplay/](gameplay/) | Every mechanic: board, empires, population, claiming, marching, coins, purchases, capitals, upkeep, victory, map generation, bots, balance |
| [moves/](moves/) | The move record, its encoding, the eleven types, and validation |
| [simulation/](simulation/) | The deterministic core: state model, snapshot/hash, the step, events, determinism discipline, RNG |
| [protocol/](protocol/) | Identity, genesis, roster, signed records, the wire format, team chat |
| [mesh/](mesh/) | Transport interface, the WebRTC mesh, the local hub, the lobby |
| [continuity/](continuity/) | Lockstep, heartbeats, joining, leaving, resume, desync, equivocation, roster amendments, ejection, the life of a move, what is hashed |
| [clients/](clients/) | The web client, headless peers, the observer, the bot |
| [trust-and-verification/](trust-and-verification/) | The trust model, the archive format, verifying an archive, the leaderboard |

## The layers

Dependencies point one way, and the direction is the design:

| Package | Depends on | Knows about |
|---|---|---|
| `packages/sim` | *nothing* | tiles, rules, bots — no DOM, no network, no crypto |
| `packages/protocol` | sim | keys, signed records, the wire format |
| `packages/net` | sim, protocol, peerjs | mesh, lockstep, lobby, archive |
| `packages/headless` | net, node-datachannel | a peer with no browser around it |
| `apps/web` | sim, protocol, net | rendering and input |
| `apps/observer`, `apps/bot` | headless | one program each |

`apps/prototype` is the original single-player game, frozen. Nothing depends on it.

## Conventions in these pages

- Source is cited as links with line anchors, e.g.
  [`rules.ts:251`](../packages/sim/src/rules.ts#L251).
- Numbers are quoted as they stand in
  [`constants.ts`](../packages/sim/src/constants.ts) `DEFAULT_RULES` /
  `DEFAULT_MAP`. Every one of them is a **genesis parameter** — agreed before the
  game starts and fixed for its duration — unless the text says otherwise.
- Where a test file is the clearest statement of a rule, it is linked.
