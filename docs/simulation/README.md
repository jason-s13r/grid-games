# The simulation

[`packages/sim`](../../packages/sim) is the deterministic core: the rules, the
RNG, the snapshot format, the bots, victory. It depends on **nothing** — no DOM,
no network, no crypto — and is written in erasable TypeScript syntax so it runs
under Node's native type stripping with no build step.

Its job: given the same [genesis](../protocol/genesis.md) and the same sequence
of moves, produce a **bit-identical** world on every peer, verifiable by a
32-bit hash. That is the [one invariant](../concepts/the-one-invariant.md), and
this folder is how the code keeps it.

| Page | Covers |
|---|---|
| [state-model.md](state-model.md) | The four typed-array layers, empire and seat records |
| [snapshot-and-hash.md](snapshot-and-hash.md) | The canonical byte serialisation and `fnv1a` over it |
| [the-step.md](the-step.md) | `Sim.advance` — the fixed order of one step, `fastForward`, dirty sets |
| [events-not-ticks.md](events-not-ticks.md) | The scheduled-event heap and why the world is not swept per step |
| [determinism-discipline.md](determinism-discipline.md) | The rules a contributor must keep so two engines never diverge |
| [rng.md](rng.md) | mulberry32: one uint32 of state, snapshotted, the only randomness |

## The public surface

`Sim` ([`sim.ts:48`](../../packages/sim/src/sim.ts#L48)) is the class the mesh
codes against:

| Member | Does |
|---|---|
| `new Sim(genesis)` | throws on a `PROTOCOL_VERSION` major mismatch; runs map generation |
| `advance(moves) → DirtySet` | simulate exactly one step; returns changed tile indices |
| `fastForward(toStep, moves?)` | advance many steps, skipping empty ones |
| `hash() → uint32` | `fnv1a(snapshot(state))` |
| `snapshot() → ArrayBuffer` / `restore(buf)` | the canonical form |
| `validate(move) → boolean` | would this move be accepted at the current state |
| `summary() → EmpireSummary[]` | readable end-of-game figures, all derived from hashed state |
| `step`, `ended` | getters |

`makeGenesis(init)` ([`sim.ts:36`](../../packages/sim/src/sim.ts#L36)) fills
`DEFAULT_MAP` / `DEFAULT_RULES` and stamps the protocol version.
