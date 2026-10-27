# The eleven types

From [`types.ts:31`](../../packages/sim/src/types.ts#L31). Every type is
validated by [`validate`](validation.md) and, if it passes, applied by
[`applyMove`](../../packages/sim/src/rules.ts#L325). Every applied move also
bumps the seat's and empire's `MOVES` stat.

| # | Type | `x,y` | Validated on | Effect |
|---|---|---|---|---|
| 0 | `PASS` | — | a live seat only | nothing. Vestigial — the `READY` frame replaced it |
| 1 | `CLAIM` | tile | passable; `popTimer > 0`; own tile **or** orthogonally adjacent to one; target not a shielded capital (as a *direct* claim) | spends the whole timer × [surround multiplier](../gameplay/claiming.md) onto the tile; fires any coin under it |
| 2 | `BUY_BRIDGE` | — | `diamonds >= bridgeCost` (3) | `diamonds -= 3`, `bridges += 1` |
| 3 | `BUY_LADDER` | — | `diamonds >= ladderCost` (3) | `diamonds -= 3`, `ladders += 1` |
| 4 | `PLACE_BRIDGE` | tile | `bridges > 0`; terrain is an unbridged `RIVER`; tile adjacent to own territory | terrain → `RIVER_BRIDGED`; `bridges -= 1` |
| 5 | `PLACE_LADDER` | tile | `ladders > 0`; terrain is an unladdered `WALL`; tile adjacent to own territory | terrain → `WALL_LADDERED`; `ladders -= 1` |
| 6 | `ROSTER_AMEND` | `x` = `MemberKind` | `members.length < min(maxSeats, SEAT_CEILING)` (4, 32) | appends a seat at the plain rules (`popMax = rules.popMax`, timers 0, `joinedAt = step`) |
| 7 | `HEARTBEAT` | — | a live seat only | `member.lastBeat = step` — the liveness input the whole mesh reads |
| 8 | `MARCH` | tile | `marchUnlocked`; `popTimer > 0`; passable; **not** adjacent to own territory; a legal via tile exists; target not a capital | splits the spend between the via tile and the target, two tiles out — [marching.md](../gameplay/marching.md) |
| 9 | `BUY_MARCH` | — | `!marchUnlocked` **and** `diamonds >= marchCost` (6) | `diamonds -= 6`; `marchUnlocked = 1`, permanently |
| 10 | `BUY_GROWTH` | — | `!growthUnlocked` **and** `diamonds >= growthCost` (6) | `diamonds -= 6`; `growthUnlocked = 1`, permanently |

Four types (`BUY_*`, `HEARTBEAT`) carry no coordinates; `x` and `y` are encoded
anyway (the record is fixed-width) and are simply zero. `ROSTER_AMEND` is the one
type that repurposes `x` — as the new seat's kind, `HUMAN` (0) or `BOT` (1).

## Notes

- **`BUY_MARCH` / `BUY_GROWTH` are refused once already owned.** They are
  permanent, and letting an empire spend six diamonds on nothing is a trap, not a
  decision ([`rules.ts:272`](../../packages/sim/src/rules.ts#L272)). The client
  removes them from the shop and shows them as HUD badges instead.
- **`ROSTER_AMEND`'s quorum is checked by the net layer**, not the sim — by the
  time the move reaches `applyMove` it is a deterministic roster append. The seat
  *cap*, though, is enforced right here in `validate`, because it is the one
  place an empire cannot argue with it. See
  continuity/roster-amendments.md.
- **Neither kind of bot ever buys anything.** [`policy()`](../gameplay/bots.md)
  emits `CLAIM` and nothing else, for SimBots and PeerBots alike — so every
  purchase in every game was a person's decision.
- **Stock and unlocks are inherited on [annexation](../gameplay/elimination-and-annex.md).**
