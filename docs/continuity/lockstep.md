# Lockstep

[`Lockstep`](../../packages/net/src/lockstep.ts#L183): moves in, agreed state
hashes out. Peers exchange inputs, never board state, so agreement is a property
of the inputs rather than something anyone arbitrates.

## The three rules

1. **A step is not simulated until every seat that could contribute to it has
   said it will not.** That is the whole of the consensus protocol.
2. **"Could contribute" is decided from the simulation, never from sockets.** A
   seat is live if its last [`HEARTBEAT`](heartbeats-and-liveness.md) is inside
   `livenessWindow` — a deterministic function of the log, identical on every
   peer. Socket state is never consulted, because peers genuinely disagree about
   who is reachable and that disagreement would become a desync.
3. **An input is bound to its step before it is sent**, `inputDelay` steps ahead
   (`DEFAULT_INPUT_DELAY = 3`, ~250 ms at 12 steps/s), so a claim never has to
   arrive in the past.

## No timer — the caller pumps

The driver holds **no timer**. The caller pumps it — `requestAnimationFrame` in a
browser ([web client](../clients/web-client.md)), a `setInterval` in a
[headless peer](../clients/headless-peers.md), a loop in a test. That is what
makes six peers in one process a deterministic experiment rather than a race.

[`pump()`](../../packages/net/src/lockstep.ts#L416):

```
target = targetStep()                    // from the wall clock, genesis-relative
while sim.step < target and budget > 0:   // MAX_STEPS_PER_PUMP = 240
    expireAmendments()
    waiting = blocked(step)               // live seats that have not promised
    if waiting: announceReady(); repeatReady(); stalling(waiting); break
    moves = drain(step) + seatArrivals(step)
    onApplied(step, moves, signed)        // the archive hook
    dirty += sim.advance(moves)
    checkpoint(sim.step); beat(); announceReady()
```

`MAX_STEPS_PER_PUMP = 240` keeps a backgrounded tab from freezing the page when
it returns and catches up.

## Readiness replaces PASS

Instead of a `PASS` per seat per step, one signed cumulative
[`Ready`](../protocol/signed-records.md): "I will send nothing more for steps up
to `upTo`". [`announceReady`](../../packages/net/src/lockstep.ts#L544) broadcasts
`min(sim.step + inputDelay - 1, readyCeiling, amendCeiling)` whenever that
climbs.

- **`readyCeiling`** is held below a move's slot *while the move is being signed*
  ([`submit`, lockstep.ts:476](../../packages/net/src/lockstep.ts#L476)) — a
  `READY` must not overtake the move it was promising about and invite every peer
  past the step it belongs to. Signing is async and the world does not stop for
  it, so `submit` re-announces in a `finally`.
- **`amendCeiling`** is held below the earliest undecided
  [amendment](roster-amendments.md) — a roster append is hashed state, so every
  peer must know the outcome before simulating that step.
- **`repeatReady`** re-broadcasts the standing promise every `READY_REPEAT_MS`
  (1000) while blocked — a `READY` is cumulative and idempotent, and it is the
  only way a peer that was not connected when we last spoke ever learns what we
  are ready for (a full mesh takes a second hop to form). Without it, two peers
  who joined at the same moment wait on each other for a promise broadcast before
  either could hear it.

## Serial lanes

[`receive`](../../packages/net/src/lockstep.ts#L612) processes frames from **one
peer** in a serial lane (`lanes` map). Verification is async, and a `READY` that
overtook the move it was promising about would let this peer advance past a step
whose input had not arrived — a desync produced entirely by our own scheduling.

## Options

| Option | Default | Meaning |
|---|---|---|
| `inputDelay` | 3 | steps ahead a move is stamped |
| `checkpointInterval` | 5 s (60 steps) | broadcast a signed hash this often |
| `snapshotInterval` | 30 s | keep a local snapshot this often |
| `moveHorizon` | 60 s | moves further ahead are discarded (memory-exhaustion guard) |
| `stallTimeout` | 15000 real ms | wait this long on a silent seat before *proposing* a drop |
| `desyncTolerance` | 3 checkpoints | disagreement tolerated before proposing a drop |
| `identity` absent | — | **observer** — follows, verifies, archives; no other peer waits for it |

[`convergence.test.ts`](../../packages/net/src/test/convergence.test.ts) is the
baseline: inputs only, bit-identical peers, an observer following without anyone
waiting.
