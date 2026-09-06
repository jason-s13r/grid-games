# 0013 — Banners: an empire you can play as again

Status: draft
Depends on: 0009 (the proposal is where one is chosen)
Branch: `banners`

## The problem

An empire's identity — its name, its two colours, its star or spiral — is
`EMPIRE_THEMES[(id - 1) % 6]` (`apps/web/src/view/palette.ts:28`). It is a
position in an array, so "I play as Vermilion" means "I was seated first", and
there is no way to be the same thing twice.

That is the wrong shape for a game people come back to. An empire should be a
house you can belong to: **Sping, a red star on black**, available in a game or
not, and yours when it is.

## The one fact that makes this cheap

None of this is consensus data today and none of it needs to become consensus
data. `EmpireTheme` lives entirely in `apps/web`. The simulation has never
heard of it: `createState` copies no such field, `snapshot()` encodes no such
field, and `hashState` cannot see one. Empire identity is presentation, and it
stays presentation.

What is missing is only that **every peer must present the same thing** — two
players comparing screenshots have to be looking at the same board. So the
binding from empire id to banner belongs in the one record every peer already
agrees on byte for byte, and nowhere else.

## The map still speaks in numbers

Nothing about tile ownership changes. `state.owner` is an `Int8Array`, one
entry per tile, holding the empire id — 0 for neutral
(`packages/sim/src/state.ts:26`), encoded a byte at a time into the snapshot
(`state.ts:140`). Every move names `(empire, member)` as two bytes
(`packages/protocol/src/records.ts:74`). The simulation is numeric from end to
end and stays that way.

A banner is a **side table**, `number -> BannerId`, that every peer derives
from records it has already verified — and derives identically, because those
records are ordered. It is never in the state, never in the hash, and never
consulted by a rule.

> **A ceiling worth knowing about while we are here.** `inspectGenesis` refuses
> more than 255 empires, on the grounds that "empire and member ids ride in
> single bytes of every signed move" (`packages/protocol/src/genesis.ts:78-79`).
> But `owner` is an `Int8Array`, so an id above 127 wraps negative the moment it
> is written — live, in `setOwner`, not merely in the snapshot. The real ceiling
> is 127 and the check advertises 255. Nobody has met it because nobody has run
> 128 empires; vacancies are the first feature that makes large empire counts
> ordinary. Fix the bound where it is declared, or widen the layer; either way
> it should not be discovered by a game that quietly repaints itself.

## What ships

`EmpireSpec` gains a field the simulation ignores, exactly as it already
ignores `MemberSpec.key` — "the sim never inspects it"
(`packages/sim/src/types.ts:146`):

```ts
export interface EmpireSpec {
  control?: Control;
  /** Which house this empire flies. Presentation only: the simulation never
   *  reads it. Absent means fall back to the empire's index, which is what
   *  every record written before this field existed does. */
  banner?: BannerId;
  members: MemberSpec[];
}
```

The table moves out of `apps/web` into a shared module — `packages/sim/src/banners.ts`,
beside `specs.ts`, whose stated role is already "empire shorthand for anyone
assembling a genesis" (`packages/sim/src/specs.ts:1`): data used to *compose* a
genesis that the simulation itself never reads. Headless peers gain the ability
to say "Sping won" instead of "empire 4 won", which the observer's output wants
anyway.

## Store the id, never the name

`BannerId` is a stable slug — `"sping"` — and the display name is a lookup on
the client. This is the whole reason the plan exists rather than being a
one-line change.

The genesis is hashed, so anything in it is frozen into the game id forever
(`packages/protocol/src/genesis.ts:41`). Put the *string* `"Vermilion"` in a
record and a later rename forks history: old archives say Vermilion, new games
say Sping, and the two are not comparable. Put the *id* in, and a rename is a
one-line edit to a table that every archive ever written picks up on the next
replay.

Which is the case in front of us: the house currently displayed as Vermilion is
going to be renamed, and more houses are going to be added. Both should be
data-only changes with no effect on any existing record.

## Two ways a banner is bound, and the second is the important one

**Sealed, for empires that exist at genesis.** The proposal (0009) gives each
seated empire a banner picker; first claim wins within the lobby; it goes into
the record and every peer reads it from there.

**Claimed, for vacancies.** A vacancy is *not* pre-branded. Its banner arrives
with the person who claims it, carried in the `Claim` record from 0010 and
broadcast like everything else:

```ts
export interface Claim {
  empire: number; key: MemberKey; step: number;
  banner?: BannerId;      // presentation; verified and gossiped, never hashed
}
```

This is the difference between "you may play as Sping if the host happened to
seal Sping" and "you play as Sping, in whichever house is empty" — and only the
second is the thing you actually asked for. A player who always plays as Sping
brings Sping to the game.

The banner rides in the signed record and **not** in the `Move` derived from
it. `amendmentMove` builds a fixed-width record whose every field is hashed
(`packages/protocol/src/records.ts:505`); presentation must not travel there.
The precedent is exact: a `SnapshotFrame` already carries its `amendments`
alongside the state for the same reason — the receiver re-verifies them, and
they are not part of what was hashed (`packages/protocol/src/wire.ts:134`).

### Deriving the table

Every peer builds `number -> BannerId` the same way, from the same ordered
inputs: the genesis first, then claims in log order. Two claimants asking for
the same banner is resolved the way everything else in this codebase resolves a
race — the earlier record in log order takes it, and the later one falls back
to its empire index. Deterministic, because `seatArrivals` already imposes a
total order (`packages/net/src/lockstep.ts:1071`), and harmless when it fires,
because it changes a picture rather than a world.

A peer that resumes from a snapshot rebuilds the table from the `amendments`
and claims travelling with it. A peer that misses a claim frame entirely draws
one empire under its index and everything else correctly — degraded, never
divergent.

### The rest of it

- **Preference is local.** "I always play as Sping" is `localStorage`, not a
  record: a fact about this browser, not about any game. On joining, the client
  picks Sping automatically when Sping is free and says plainly when it is not.
- **On an application (0011):** you are asking to join a house that already has
  people in it, so the banner is theirs and not yours to bring. "Apply to
  Sping" names an empire that is already flying it.

Availability is therefore exactly what you described: a banner is yours if
nobody in this game is flying it, or if the people who are accept you.

## Uniqueness

Two empires wearing one flag is an unreadable board, so it is refused twice, at
the two places the codebase already refuses composition errors:

- `checkPlan` (`packages/net/src/teams.ts:74`) — early, "while the host can
  still fix it";
- `inspectGenesis` gains a `"duplicate-banner"` problem
  (`packages/protocol/src/genesis.ts:82`), for the same reason the seat cap is
  checked there as well as on every amendment: a record is the one place a game
  could be born malformed.

A claimed banner cannot be checked at either of those points — it arrives hours
later — so it is checked where it is applied: a claim naming a banner already
in use is accepted as a *seating* and ignored as a *branding*, and that empire
keeps its index colours. Refusing the whole claim over a colour would let a
squatter deny somebody a seat, which is a far worse failure than a duplicate
flag.

An older build does not know the field and will not check it, so a hostile host
can hand a v3 peer a board with two red stars on it. That is cosmetic griefing
against a peer that opted out of the feature by not having it, and it costs
nothing but legibility — worth writing down, not worth a mechanism.

## Two things in the way

**The table is too short.** Six banners, and `MAX_RIVALS = EMPIRE_THEMES.length - 1`
(`apps/web/src/view/Rivals.ts:25`) and the SimBot cap
(`apps/web/src/view/LobbyPanel.ts:204`) are both derived from its length — the
palette is currently the real limit on how many empires a game may have.
Vacancies (0010) push straight into it: a game with four players and six empty
houses wants ten. Growing the table is a pure data change once banners are ids.

**Two empires already render identically.** `MapImage` builds its colour lookup
with `for (let id = 1; id <= 8; id++)` over a six-entry table
(`apps/web/src/view/MapImage.ts:39`), so empires 7 and 8 are painted as 1 and
2 — on the map image only, while the DOM tiles and the minimap use the same
wrapping and agree with it. Nobody has hit it because nobody has run an
eight-empire game. Fix it here: the lookup is sized from the banner table, and
a game with more empires than banners is refused at composition rather than
drawn wrong.

## Versioning: no bump, and it is the third distinct reason in this series

`PROTOCOL_VERSION` and `LAYOUT_VERSION` are untouched. Game ids change, because
a new field in the genesis is part of the record being hashed — that is what
genesis fields are for, and it affects new games only.

The compatibility argument is neither 0002's nor 0010's:

- **0002** adds a field an old build reads past *and then enforces a different
  rule* — invisible divergence, so it wants the bump.
- **0010** adds a marker an old build already rejects at `inspectGenesis` — it
  declines cleanly, so it does not.
- **0013** adds a field an old build reads past *and nothing downstream of
  `validate()` ever sees it* — the two builds hold identical state and draw
  different pictures.

The rule underneath all three: a bump is owed when two builds would compute
different state from the same log. Not when they render it differently, and not
when one of them refuses to play.

## Verification

- `packages/sim/src/test/banners.test.ts`: ids are unique and stable; the table
  is append-only under a stored fixture, so a future rename cannot silently
  reorder it and repaint every archived game.
- A genesis with banners and one without produce the same state hash for the
  same seed and moves — presentation proven inert.
- `inspectGenesis` refuses duplicate banners; `checkPlan` refuses them first.
- Replay of the recorded fixture (no banner fields) renders today's colours
  unchanged — the fallback path, exercised.
- A ten-empire game paints ten distinguishable colours on the DOM tiles, the
  map image and the minimap alike.

---

# Implementing it

A plan of action for 0013, written after reading the code it names. Every line
number below was checked against the tree at `docs` HEAD.

The argument holds and the versioning section is the best-reasoned page in the
series. What the body gets wrong is the size of the two bugs it stops to
mention on the way past. Both are worse than described, and one of them is not
a rendering bug at all.

## What ships

| File | Change |
|---|---|
| `packages/sim/src/banners.ts` | new — `BannerId`, the table, `bannerOf`, the frozen legacy fallback |
| `packages/sim/src/types.ts` | `banner?: BannerId` on `EmpireSpec` |
| `packages/sim/src/specs.ts` | `simbot(level, banner?)`, `humans(n, banner?)` |
| `packages/sim/src/index.ts` | exports |
| `packages/sim/src/test/banners.test.ts` | new — the append-only fixture |
| `packages/protocol/src/genesis.ts` | `"duplicate-banner"`, `"too-many-empires"`, and the 255 → 127 correction |
| `packages/net/src/teams.ts` | `banners` on `Plan`; two checks in `checkPlan` |
| `packages/net/src/lobby.ts` | thread banners into `makeGenesis` |
| `packages/net/src/banners.ts` or `lockstep.ts` | the derived `number -> BannerId` table |
| `apps/web/src/view/palette.ts` | the table becomes a lookup on a banner id; `injectThemeCss` keys on the slug |
| `apps/web/src/view/Renderer.ts` | `data-banner` instead of `data-empire` |
| `apps/web/src/view/MapImage.ts` | the `id <= 8` loop dies |
| `apps/web/src/view/Minimap.ts`, `Rivals.ts`, `LobbyPanel.ts`, `main.ts` | banner lookups instead of `empireTheme(id)` |
| `apps/web/styles/main.scss` | `.tile` keyed on the slug |
| docs | six files, below |

## The lead finding: past six empires there are three layers and three different wrong answers

The body says:

> `MapImage` builds its colour lookup with `for (let id = 1; id <= 8; id++)`
> over a six-entry table, so empires 7 and 8 are painted as 1 and 2 — **on the
> map image only, while the DOM tiles and the minimap use the same wrapping and
> agree with it.**

The DOM tiles do not wrap. `injectThemeCss` emits one rule per entry in the
table — `EMPIRE_THEMES.map((theme, i) => '.tile[data-empire="${i + 1}"] ...')`
(`palette.ts:59-63`) — so there are exactly six rules and empire 7 matches none
of them. `Renderer.paintTile` still writes `data-empire="7"` (`Renderer.ts:197`)
and still adds a pattern class, because `empireTheme(7).pattern` wraps
(`Renderer.ts:183`). And the base rule is

```scss
.tile {
  --c1: transparent;
  --c2: transparent;
```

(`main.scss:174-176`.) So a seventh empire's tiles get a star gradient drawn in
transparent over transparent: **its territory is invisible on the main board**,
indistinguishable from neutral ground, while carrying the right pattern class
and the right `data-empire`. Not a duplicate — a disappearance.

Three layers, three behaviours:

| Layer | Empire 7 | Empire 9 | Empire 13 |
|---|---|---|---|
| DOM tiles (`Renderer` + injected CSS) | invisible | invisible | invisible |
| Map image (`MapImage.ts:39`, `:52`) | painted as 1 | painted as 1 — the `?? this.empireRgb[1]` fallback | painted as 1 |
| Minimap (`Minimap.ts:107`) | painted as 1 | painted as 3 | painted as 1 |

So the zoomed-out view and the minimap disagree with each other *and* with the
board, and the board shows enemy territory as empty. `Rivals.ts:22-25` already
carries the belief that got this wrong — "Beyond this two empires wear the same
colour" — and it is worth fixing that comment in the same commit as the code,
because it is the sentence that made the bug plausible.

**And it is reachable today, at seven, with nobody running an unusual game.**
`composeTeams` says so in its own doc comment: "A player with no entry in
`wanted` gets an empire of their own — the default before anybody touches
anything, and the only sensible reading of silence" (`teams.ts:30-31`). The
palette cap at `LobbyPanel.ts:204` limits **SimBots**, not people. Seven players
who join and press start get seven empires, and the seventh plays an invisible
game. Vacancies are not the first feature to make this ordinary; a seventh
friend is.

## The 127 ceiling is a simulation bug, not a repaint

The body's boxed aside says an id above 127 "wraps negative the moment it is
written" and closes with "it should not be discovered by a game that quietly
repaints itself". It is worse than a repaint. Follow the value:

```ts
export function setOwner(state: State, i: number, next: EmpireId): void {
  const prev = state.owner[i]!;
  if (prev === next) return;
  if (prev > 0) state.empires[prev - 1]!.tilesOwned--;
  if (next > 0) state.empires[next - 1]!.tilesOwned++;
  state.owner[i] = next;
}
```

(`rules.ts:19-25`.) Call it with `next = 128`. The argument is a plain number,
so `next > 0` is true and empire 128's `tilesOwned` increments. The store into
the `Int8Array` writes **-128**. From that moment:

- every `owner > 0` test in the simulation reads that tile as **neutral** — so
  empire 128's territory is unowned to combat, to upkeep, to cascades and to
  claiming, and any opponent may take it for free;
- the next `setOwner` on that tile finds `prev === -128`, skips the decrement,
  and `tilesOwned` **never comes back down**;
- `isProtected` and `checkVictory` both read `tilesOwned`, so empire 128 sits
  on a fictitious count that only grows, and can satisfy a victory condition
  over tiles that are drawn as empty.

`state.winner` is `i8` in the snapshot too (`state.ts:129`), so an empire past
127 cannot even be recorded as having won. This is a divergence between the
rules and the board inside one peer, which is a different class of thing from
everything else in this series.

It does not belong in 0013. It is three lines — widen `owner` to `Uint8Array`
(a `LAYOUT_VERSION` move) or correct the bound in `inspectGenesis` from 255 to
127 (free) — and 0013 should do the free half, because it is already editing
that function, and file the other half as its own plan. What 0013 must not do
is leave the box in the body implying this is cosmetic.

## The dependency line is wrong

The header says `Depends on: 0009`. The section the body calls "the important
one" is:

> **Claimed, for vacancies.** ... Its banner arrives with the person who claims
> it, carried in the `Claim` record from 0010

`Claim` does not exist. 0010 builds it, and 0010 is the largest plan in the
series. So 0013 depends on **0009 and 0010**, and `0000-index.md` carries the
same gap in its dependency column.

The split is clean and it is the right way to build this:

- **Sealed banners** need 0009 only, and carry every bug fix above — the
  invisible seventh empire, the three-layer disagreement, the 127 bound, the
  duplicate check. That is most of the value and all of the urgency.
- **Claimed banners** need 0010's `Claim`, its frame and its gossip, and add
  one optional field to a record that will not exist for another two plans.

Ship the first half against 0009 and leave the second as a paragraph 0010's
implementation picks up — 0010's `Claim` gaining an ignored-if-taken `banner?`
is a two-line change *there* and an entire dependency *here*.

## The CSS is injected before there is a game

`injectThemeCss()` runs at module scope in `main.ts:36`, at import time, long
before a genesis exists. It writes six static rules keyed
`.tile[data-empire="N"]`. A banner binding is per-game and per-empire-id, so
nothing about that shape survives.

Do not re-inject after genesis. **Key the CSS on the banner slug and let the
renderer write the slug:**

```scss
.tile[data-banner="sping"] { --c1: #ff2600; --c2: #1a0400; }
```

with `paintTile` setting `el.dataset.banner` from the derived table instead of
`el.dataset.empire`. Three things fall out:

- the stylesheet goes back to being static and complete — one rule per banner
  in the table, all of them, injected once, with no dependence on how many
  empires this game has;
- the per-game binding lives entirely in one attribute write, on a line that
  already guards against redundant writes (`Renderer.ts:196-197`), so the hot
  path costs the same;
- growing the table is a pure data change *for the CSS too*, which the body
  claims and the current shape does not deliver.

The `.swatch[data-empire]` rule beside it (`palette.ts:62`) moves the same way.

## Growing the table repaints the past, unless the fallback stops wrapping

> Growing the table is a pure data change once banners are ids.

Not with the fallback as the body defines it. "Absent means fall back to the
empire's index" is implemented today as `EMPIRE_THEMES[(id - 1) % length]`
(`palette.ts:28-29`), and **the modulus is a function of the table's length**.
Grow the table from six to twelve and every record without a banner field —
which is every record ever written — renders differently for any empire past
six: empire 7 was banner 1 and becomes banner 7.

That is precisely the failure "store the id, never the name" exists to prevent,
arriving through the other door.

Two changes make the claim true:

- **The fallback indexes, it does not wrap**: `banners[id - 1]`, undefined past
  the end.
- **A game with more empires than banners is refused at composition**, which
  the body already asks for in the `MapImage` section. Put it in `checkPlan`,
  on the line that already computes `plan.empires.length + plan.simbots.length`
  for the two-empire rule (`teams.ts:107`), and in `inspectGenesis` beside the
  seat cap.

Then no existing record's rendering depends on the table's length, and
appending really is free. Note that the legacy six *must keep their positions
forever* — which is what the body's append-only fixture test is for, and it is
now load-bearing rather than tidy.

## Ten things the body assumes that the code does not do

1. **`Plan` has nowhere to put a banner.** `{ empires: MemberKey[][]; simbots:
   readonly Difficulty[] }` (`teams.ts:55-62`), so `checkPlan` cannot refuse a
   duplicate it cannot see. It needs a parallel array, and SimBot empires need
   entries in it too — they are empires on the board and `Rivals.ts:79` already
   names them by theme.
2. **`simbot()` has no slot either.** `simbot(level)` returns a fixed
   `EmpireSpec` (`specs.ts:129-132`) and `lobby.ts:270` pushes the result
   straight into the genesis. Both need the field threaded.
3. **`GenesisProblem` is a closed union** (`genesis.ts:52-59`). Adding
   `"duplicate-banner"` and an empire-count problem means the callers that
   render problems get two new strings to say something about.
4. **Nothing derives the table, and there is no home for it.** Every caller
   today goes through `empireTheme(id)`, a pure function of a number, from six
   files. All six become lookups against per-game state, which has to be built
   from the genesis and handed to the view layer — and to a headless peer,
   which is the stated reason for moving the table down.
5. **`Claim` does not exist.** See the dependency section.
6. **`main.ts` hardcodes the theme name in two player-visible strings** —
   `"You are ${empireTheme(seat.empire).name}. Say hello."` (`:446`) and `"You
   have been seated as ..."` (`:518`).
7. **The lobby already presents empires by theme name.** `LobbyPanel.ts:257-258`
   builds the team `<select>` from `empireTheme(i + 1).name`, so a player
   already picks their team by choosing "Vermilion". That is 0009's banner
   picker in embryo, and the two plans should agree on which one owns it.
8. **`MapImage` hard-codes eight.** `for (let id = 1; id <= 8; id++)`
   (`MapImage.ts:39`) with a `?? this.empireRgb[1]` fallback at `:52`. Size it
   from the table.
9. **The recorded fixture pins `protocol: 3`.**
   `packages/sim/src/test/fixtures/recorded.json` carries no banner fields, so
   it exercises the fallback path for free and is exactly the tripwire the body
   asks for. It also has to be regenerated when 0002 moves the protocol to 4 —
   not this plan's problem, but this plan's test depends on it.
10. **`canonicalJson` drops `undefined` and keeps `null`** (`genesis.ts:29-30`).
    The field must be *omitted* when unset. A spec that writes `banner: null`
    changes the game id of a record that means exactly what it meant before.

## Why no version number moves, and the one line that makes it true

The body's three-way comparison with 0002 and 0010 is right, and there is a
mechanical reason underneath it worth adding, because it is what makes the
additive field genuinely transparent rather than transparent-by-agreement:

`canonicalJson` walks whatever object it is handed and sorts the keys it finds
(`genesis.ts:27-35`). It has no schema. So an **older** build handed a genesis
carrying `banner` serialises the field it has never heard of, hashes it, and
computes the same game id as a new build. It does not skip it, and it does not
choke. That is why an additive genesis field costs nothing here and would cost
everything in a format that encoded a fixed field list.

| Artefact | Verdict |
|---|---|
| `PROTOCOL_VERSION` (`sim/src/constants.ts:8`) | No move. Nothing downstream of `validate()` sees the field. |
| `LAYOUT_VERSION` (`sim/src/state.ts:20`) | No move — `snapshot()` encodes no genesis field at all, which is a stronger statement than "banners are not hashed". Unless the `owner` widening is done here, in which case it does move and that is the argument for doing it separately. |
| `ARCHIVE_FORMAT` (`net/src/archive.ts:25`) | No move. An archive stores the genesis whole. |
| Game ids | Change, for records that carry the field. Records without it are byte-identical, which `crossenv.test.ts` already proves on every run. |

## Order of work

| # | Step | Half | Green? |
|---|---|---|---|
| 1 | `inspectGenesis`: 255 → 127, with the comment corrected to say why. Free, and it is the honest half of the boxed aside. | fix | yes |
| 2 | `banners.ts`: `BannerId`, the table seeded with today's six **in today's order**, `bannerOf`, and the append-only fixture test. No callers. | sealed | yes |
| 3 | `palette.ts` becomes a lookup keyed on `BannerId`; `injectThemeCss` emits one rule per banner keyed `data-banner`; `.tile` in `main.scss` follows. | sealed | yes |
| 4 | `Renderer` writes `data-banner`; `MapImage` and `Minimap` size from the table. Still `bannerOf(id)` with the index fallback, so nothing renders differently yet — **except empire 7, which stops being invisible.** | sealed | yes |
| 5 | `banner?` on `EmpireSpec`; `simbot`/`humans` accept one. Nothing sets it. | sealed | yes |
| 6 | `banners` on `Plan`; the two `checkPlan` refusals; `"duplicate-banner"` and the empire cap in `inspectGenesis`. | sealed | yes |
| 7 | The derived `number -> BannerId` table, from the genesis only. Every view call site moves onto it. | sealed | yes |
| 8 | 0009's picker writes banners into the plan; local preference in `localStorage`; the two `main.ts` strings. **Sealed banners work here.** | sealed | yes |
| 9 | *After 0010:* `banner?` on `Claim`, claims folded into the derived table in log order, ignored when taken. | claimed | — |

Step 4 before step 5 is the point of the ordering: the rendering bugs are fixed
against the fallback, with no new field in play, so a red test at step 4 is
about the palette and nothing else.

## Docs

| File | What changes |
|---|---|
| `docs/gameplay/empires-and-seats.md` | An empire is a house you can fly again, not a position in an array |
| `docs/protocol/genesis.md` | The additive field, why the id is stored and never the name, `"duplicate-banner"` |
| `docs/simulation/state-model.md` | `owner` is `Int8Array` and the real empire ceiling is 127 |
| `docs/clients/web-client.md` | Where a banner is chosen and where the preference lives |
| `docs/clients/observer.md` | Headless output names houses |
| `docs/mesh/the-lobby.md` | The picker refuses duplicates while the host can still fix it |

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| **a seven-empire game paints seven distinguishable colours on all three layers** | the lead finding. Fails today, invisibly, on the layer players actually look at |
| the banner table is append-only and its first six keep their positions | `banners.test.ts` against a stored fixture of ids in order |
| the fallback does not depend on the table's length | append two banners to a copy of the table; a record with no banner field renders identically |
| a game with more empires than banners is refused | `checkPlan` first, `inspectGenesis` second — the two-place rule the seat cap already follows |
| `checkPlan` refuses two empires flying one banner | `teams.test.ts` |
| `inspectGenesis` refuses the same in a sealed record | `genesis.test.ts` |
| **a genesis with banners and one without produce the same state hash** | almost free — `snapshot()` encodes no genesis field — but keep it as the tripwire against someone copying the field into `State` |
| a record with no banner field keeps its game id | `crossenv.test.ts` already asserts this on every run, against `recorded.json` |
| a banner explicitly set to `null` is refused rather than silently re-hashing | `genesis.test.ts`, per `canonicalJson`'s undefined-vs-null rule |
| replay of `recorded.json` renders today's colours unchanged | the fallback path, exercised by a fixture that predates the field |
| `inspectGenesis` refuses 128 empires | `genesis.test.ts` — one line, and it closes the aside |
| *after 0010:* two claims for one banner resolve to the earlier in log order | `packages/net` — and the later claimant is still **seated** |
| *after 0010:* a peer that missed a claim frame draws one empire under its index and agrees about everything else | `agreed(t)` stays true |

## What this plan does not settle

- **Whether `owner` should be widened.** The free half of the fix is in step 1.
  The real half is a `LAYOUT_VERSION` move and a plan of its own, and it is the
  only thing in this series that would break a snapshot in flight.
- **Where the table lives.** `packages/sim/src/banners.ts` is defensible —
  `specs.ts` sets the precedent for composition data the sim never reads — but
  it does put hex colours and CSS pattern names in the simulation package. If
  that reads wrong later, the seam is between the id-and-name (needed by
  headless output) and the colours (needed only by a client).
- **Who owns the picker.** 0009 builds the proposal screen and
  `LobbyPanel.ts:257` already picks a team by theme name. One of the two plans
  should own that control and the other should reference it.
- **What a banner looks like beyond six.** Growing the table is a design
  exercise — six two-colour flags that are distinguishable at one tile is
  already the hard part, and twelve is harder than twice as hard.
- **Whether a banner should be reserved across games.** It is explicitly local
  preference here, and that is right, but it is the obvious next request from
  anyone who plays as Sping twice.
