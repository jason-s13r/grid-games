# Tessera — game reference

Tessera is a browser recreation of the grid-territory game *Empire Attack*.
Every client runs a bit-identical deterministic simulation from a shared seed,
and clients exchange **moves, never board state**.

This `/docs` tree is the detailed reference for **how the game plays and how the
simulation works**. Networking is being rebuilt around Cloudflare (a Durable
Object per game orders moves and keeps the game running); the pages that
described the old peer-to-peer mesh were removed and live in git history.

## Where to start

1. [concepts/moves-not-state.md](concepts/moves-not-state.md) — the one
   requirement the whole design falls out of.
2. [concepts/the-one-invariant.md](concepts/the-one-invariant.md) — the state
   hash, and why it is the compatibility contract.
3. [gameplay/README.md](gameplay/README.md) — a game from a player's chair.

## The map of the tree

| Folder | What it covers |
|---|---|
| [concepts/](concepts/) | The founding ideas: moves not state, the invariant, time |
| [gameplay/](gameplay/) | Every mechanic: board, empires, population, claiming, marching, coins, purchases, capitals, upkeep, victory, map generation, bots, balance |
| [moves/](moves/) | The move record, its encoding, the eleven types, and validation |
| [simulation/](simulation/) | The deterministic core: state model, snapshot/hash, the step, events, determinism discipline, RNG |

## Conventions in these pages

- Source is cited as links with line anchors, e.g.
  [`rules.ts:251`](../packages/sim/src/rules.ts#L251).
- Numbers are quoted as they stand in
  [`constants.ts`](../packages/sim/src/constants.ts) `DEFAULT_RULES` /
  `DEFAULT_MAP`. Every one of them is a **genesis parameter** — agreed before the
  game starts and fixed for its duration — unless the text says otherwise.
- Where a test file is the clearest statement of a rule, it is linked.
