# Bots

One targeting policy ([`policy.ts`](../../packages/sim/src/policy.ts)), two homes.

| | **SimBot** | **PeerBot** |
|---|---|---|
| Runs | inside every peer's simulation | as its own mesh client (`peerbot.ts`) |
| Controls | a whole `SIMBOT` empire | one seat in a human empire |
| Bandwidth | zero | one signed move per action |
| Randomness | the shared seed (`state.rng`) | its **own** `Rng`, seeded from the seat |
| Can it drop? | never — always "present" | yes; the empire simply idles |
| Seated by | the genesis composition | a `ROSTER_AMEND` vote |

A **PeerBot must not touch the shared stream** — a draw made on one peer and
nowhere else is exactly a desync. Its moves are
[validated, not derived](../moves/validation.md), so its private randomness is
harmless. `policy()` takes optional `forced` and `focus` arguments *for the
PeerBot alone*; a SimBot passes neither, which is why adding them moved no hash.

The PeerBot as a program is clients/bot.md; the details of
what a PeerBot costs an empire are in
[empires-and-seats.md](empires-and-seats.md).

## A bot is not handicapped

It accrues at the same rate as a person — one population per step — and its coins
[chain](coins-and-cascades.md) like anybody's. Its strength is **`popMax`
alone**: a claim spends `min(steps waited, popMax)`, so a bot capped at 333 that
waits the full 83 s a person needs for 999 still lands 333. That is legible on
the board, where an accrual penalty would just feel like the bot doing less for
no reason. See [population.md](population.md).

## BotProfile

[`BotProfile`](../../packages/sim/src/types.ts#L192), in the genesis record (so
"the bots were on hard" is a fact of the game, not a memory):

| Field | Meaning |
|---|---|
| `popMax` | population ceiling — the whole of strength |
| `coins` | percent chance of grabbing an adjacent coin instead of following the phase |
| `phases` | per-`BotMode` `{ steps, rate: [min, max] }` — the cycle. **A set of durations, not a sequence** |

`BotMode` = `expand | attack | defend | fortify | heal | sleep`
([`types.ts`](../../packages/sim/src/types.ts)).

**The order phases are written in means nothing.** `turnOf` builds its cycle
from `MODES` ([`policy.ts`](../../packages/sim/src/policy.ts)), a fixed constant
in exactly that order, and a genesis is canonicalised with its keys sorted — so
a declared order could not survive the record even if the simulation honoured
it. A profile is a set of durations. The three presets happen to declare their
phases in `MODES` order, which is why nobody noticed the comment that promised
otherwise.

A hand-tuned profile goes into the genesis record like everything else, so a
custom opponent is as checkable before the first move as a named difficulty is.
`checkProfile(profile, rules)` refuses an empty phase set, a negative duration,
a backwards click rate and a ceiling above `rules.popMax` — **it refuses and
never clamps**, because the clamps that actually bind are elsewhere and stay
there. What it buys is telling a composer before the record is broadcast, for
the same reason `checkPlan` refuses early.

## turnOf — the phase, derived not stored

[`turnOf(state, empire, seat, profile)`](../../packages/sim/src/policy.ts#L78):
the profile's phases add up to a `cycle` of known length, and
`(step + empire.id*97 + seat*31) % cycle` says where in it the bot is — a walk
over at most six entries, **no snapshot fields**, nothing to desync through. The
seat offset keeps two bots on one profile out of lockstep.

The tempo *within* a phase is drawn from the phase's `rate` span by hashing
*which pass through the cycle* this is ([`mix`](../../packages/sim/src/policy.ts#L51))
— a pure integer function of state, **never an RNG draw**. A bot that drew for
its own tempo would move the coin spawns whenever somebody retuned it.

## policy — the move

[`policy(state, empire, member, rng, forced?, focus?, profile?)`](../../packages/sim/src/policy.ts#L179)
always returns a `CLAIM` or `null` — bots never buy, march or place. It
[`scan`](../../packages/sim/src/policy.ts#L119)s the ownership layer once into
`{ owned, frontier, coins, threatened }`, picks a mode, and a target:

- **coin grab** (unless `forced`): a frontier coin, if `rng.int(100) < profile.coins`.
- **expand** → [`alongTheBorder`](../../packages/sim/src/policy.ts#L274) — the
  frontier tile best aligned with a sweep vector rotating through 8 sectors every
  ~48 s, tie-broken toward cheaper tiles, so the whole edge advances together
  instead of growing a finger. Integer cross-products, no `atan2`.
- **attack** → a `focus` empire's capital, else
  [`nearestHeldTile`](../../packages/sim/src/policy.ts#L314); then `closestTo`
  that goal.
- **defend** → the [`weakest`](../../packages/sim/src/policy.ts#L369) threatened
  tile, else the weakest owned. A pinned defender banks rather than falling back
  onto neutral ground.
- **heal** → [`towardsThePocket`](../../packages/sim/src/policy.ts#L343) —
  reconnect a stranded pocket before [upkeep](upkeep.md) decays it.
- **fortify / else** → [`nearCapital`](../../packages/sim/src/policy.ts#L399).

`weakest` / `closestTo` **sample** (8–12 candidates) rather than fully sort —
bounded work, one RNG draw.

Difficulty presets: [difficulty-and-balance.md](difficulty-and-balance.md).
