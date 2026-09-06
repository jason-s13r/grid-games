# Population

Population is the resource you spend to take ground. Each **seat** has its own
bank — `member.popTimer` — and it fills on its own.

## Accrual

[`accrue(state)`](../../packages/sim/src/rules.ts#L668) runs once per
[step](../concepts/time-and-steps.md), at the end of
[`Sim.advance`](../simulation/the-step.md), for every seat of every live empire:

```
popAcc += popRateNum          // 1 by default
while popAcc >= popRateDen:    // 1 by default
    popAcc -= popRateDen
    if popTimer < popMax: popTimer++
```

With the default `popRateNum/Den = 1/1`, that is **one population per step** —
twelve per second. The `popAcc` remainder makes fractional rates possible without
any float: set `1/2` and a seat gains one every other step, exactly, on every
engine.

Every seat accrues at the same rate — a [bot](bots.md)'s included. What differs
between seats is only the **ceiling**.

## popMax — the ceiling

`member.popMax` is `rules.popMax` (**999**) for a person and for any seat that
did not ask for less; lower for a [bot dialled down](difficulty-and-balance.md)
(easy 333, steady 666, hard 999). It is clamped on creation
([`state.ts:78`](../../packages/sim/src/state.ts#L78)) — a profile may ask for
*less* than the game allows, never more.

`popMax` lives in state, not read from the genesis on demand, because a seat can
arrive by [amendment](../continuity/roster-amendments.md) and a snapshot has to
carry what it grew. A seat voted in mid-game gets `popMax = rules.popMax` — a
substitute plays on the plain rules.

## What a claim spends

The whole timer, in full. [`claim`](claiming.md) and [`march`](marching.md) both
do:

```
spent = member.popTimer
member.popTimer = 0
member.popAcc = 0
```

So **a claim is worth `min(steps waited, popMax)`** (before the surround
multiplier). Wait 999 steps (~83 s) and you land 999. Wait the same 83 s with a
seat capped at 333 and you land 333 — the other 666 you grew in the meantime
simply evaporate. That is the entire mechanism behind bot difficulty, and it is
legible on the board: you can see what a tile cost to take.

`popTimer` is also gated by `popTimer > 0` in [`validate`](../moves/validation.md)
— a seat with an empty bank cannot claim or march (it can still `HEARTBEAT`,
`BUY_*`, `PLACE_*`).

## popTotal

`empire.popTotal` is the sum of population across all the empire's tiles, kept in
step by every `place` / `upkeep` / `annex` operation
([`addPop`, rules.ts:58](../../packages/sim/src/rules.ts#L58)). It is a
tie-breaker in [victory](victory.md) and a column in the standings table.
