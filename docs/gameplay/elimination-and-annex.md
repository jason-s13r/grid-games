# Elimination and annexation

## Two elimination rules

`ELIMINATION` ([`types.ts:57`](../../packages/sim/src/types.ts#L57)), a genesis
parameter, default `CAPITAL`:

- **`CAPITAL`** — an empire is out the moment `owner[capital] !== id`. The capital
  is otherwise an ordinary tile (except for [shielding](capitals.md)).
- **`ANNIHILATION`** — an empire is out when `tilesOwned === 0`. The capital is a
  completely ordinary tile and none of the annex machinery below runs.

[`eliminated`](../../packages/sim/src/victory.ts#L28) is checked every step by
[`checkVictory`](victory.md).

## Emptied is not taken

This is the `sim@2.0.0` breaking fix. Emptying a capital and taking a capital
were the same board state but not the same event
([`rules.ts:104`](../../packages/sim/src/rules.ts#L104)):

- An empire is eliminated by *not owning* its home. So a capital reduced to
  exactly 0 population used to strike the empire out via `checkVictory`.
- But [`annex`](../../packages/sim/src/rules.ts#L138) only fires on a **capture**
  — a tile changing hands. Landing exactly level is not a capture, so `annex`
  never ran.
- Result: the victim's territory sat there owned by a dead empire, unreachable
  and unclaimable, and the attacker who had just spent a full bank got **nothing**.
  Landing one population short took everything; landing exactly level took
  nothing.

Now: any other tile goes neutral the instant it empties, but a **capital at 0
stays its empire's** — "a free square with a flag still on it" — until a second
click walks onto it through the ordinary capture path, which fires `annex` and
pays what a capital is worth.

## annex() — taking a capital takes the empire

[`annex(state, victim, toId, dirty)`](../../packages/sim/src/rules.ts#L138), only
under `CAPITAL` elimination. On capturing a live empire's capital:

1. **Every tile** of the victim is reassigned to the heir; its population is
   transferred (`victim.popTotal -= population`, `heir.popTotal += population`).
2. **Unspent stock is spoils:** `heir.diamonds += victim.diamonds`,
   `bridges`, `ladders` likewise; then the victim's are zeroed.
3. **Learned unlocks outlive the empire:** `heir.marchUnlocked ||= victim.marchUnlocked`,
   same for `growthUnlocked`.
4. `victim.alive = 0`, `victim.eliminatedAt = state.step`.
5. Stats: `ANNEXED` (+tiles taken), `PEAK_TILES`, `PEAK_POP` raised on the heir.

Leaving the victim's tiles on the board as an ownerless rump made the decisive
blow feel like nothing — the map barely changed and the population was simply
deleted. Annexing pays the attacker the whole empire, which is what makes a
capital worth the assault and worth defending.
[`annex.test.ts`](../../packages/sim/src/test/annex.test.ts) covers the transfer,
"emptying ≠ taking", the second click, and "a cascade over a capital leaves it
standing".
