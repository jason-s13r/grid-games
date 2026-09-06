# What is hashed, and what is not

The [state hash](../concepts/the-one-invariant.md) is the compatibility contract,
so what is *in* it is exactly what every peer must agree on byte-for-byte — and
nothing else is allowed in, because everything else genuinely differs between
peers.

| In the hash | Outside it |
|---|---|
| Board layers (`owner`, `pop`, `terrain`, `item`) | Signatures — randomised; two peers signing one move differ |
| Empire records: `capital`, `diamonds`, `bridges`, `ladders`, `marchUnlocked`, `growthUnlocked`, `tilesOwned`, `popTotal`, `alive`, `control`, `eliminatedAt` | Chat messages, public **and** team |
| Seat records: `kind`, `popMax`, `popTimer`, `popAcc`, `lastBeat`, `joinedAt` | Camera position, zoom, panel state, muting |
| 16 stat counters, per empire **and** per seat | Member **keys** — the sim addresses seats by index; the [roster](../protocol/roster.md) maps index → key, outside the sim |
| Scheduled [events](../simulation/events-not-ticks.md), RNG state, `itemCount` | Socket state, peer lists, `blockedOn`, stopwatches |
| Roster **size** and member kinds | [Ejections and drops](ejection.md) — they change *who a peer waits for*, not the world |
| `phase`, `winner`, `winReason` | `RESUME_BEHIND` and every other real-time constant |

Source: [`snapshot()`, state.ts:114](../../packages/sim/src/state.ts#L114).

## The two revealing cases

**Chat is signed, ordered and attributable — but not hashed.** That is exactly
what makes it safe: a message that arrives late, out of order, or not at all can
never desync a game. [`chat.test.ts`](../../packages/net/src/test/chat.test.ts)
proves it by dropping every message on one peer and checking the hash is
unchanged.

**An [ejection](ejection.md) is not hashed, but a
[roster amendment](roster-amendments.md) is.** An ejection stops a peer *waiting*
for a seat — the simulation still runs that seat's already-valid moves, so the
world bytes do not change. An amendment *appends a member* to the sim, which
changes the bytes, so every peer must agree on its outcome before simulating that
step. Both records travel with a [snapshot](resume.md) so an adopting peer's
"who do I wait for" matches, but only one is in the number that is compared.

## Why stats being hashed matters

End-of-game figures are **consensus by construction**: no client reports them, so
no server has to be trusted not to believe a lying one. The
[leaderboard](../trust-and-verification/leaderboard.md) recomputes them by replay,
and any peer whose stats differ by one fails the next
[checkpoint](desync.md) within seconds. State that is not hashed does not exist;
state that is hashed is compared.
