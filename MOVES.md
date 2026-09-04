# Moves

Everything a peer can say that changes the world.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the shape of the system; this
document is the vocabulary itself — the eleven move types, what each one is
allowed to say, who checks it, and what every other peer knows as a result.

## One kind of state change

There is exactly one. A `Move` is the only thing that ever mutates hashed
state, and `Sim.advance` is the only thing that applies one
([`sim.ts:92`](packages/sim/src/sim.ts#L92)). Everything else that crosses the
wire either carries a move, agrees about a move, or is not hashed at all.

That is narrower than it sounds, and deliberately so. There is no message for
"my empire now has four diamonds", no message for "I bought a bridge", no
message for "here is my board". A peer submits an *intent* — the move — and
every peer, including the sender, derives the consequence from its own copy of
the rules. Nothing about the outcome travels.

## The record

```ts
interface Move {
  step: number;    // the step it lands on, chosen before it is signed
  empire: EmpireId;
  member: MemberIndex;
  seq: number;     // this seat's counter, for ordering within a step
  type: MoveType;
  x: number;
  y: number;
}
```

Seven fields, sixteen bytes on the wire, and the interesting part is what is
*missing*:

- **No key.** A move names a seat, `(empire, member)`; the roster says which
  public key sits there. If the key travelled inside the move, "the signature
  is valid for the key it names" would prove nothing at all
  ([`roster.ts`](packages/protocol/src/roster.ts)).
- **No amount.** A claim does not say how much population it spends. The
  simulation reads `member.popTimer`, which it has been accruing itself since
  step zero.
- **No cost, and no price.** A purchase does not carry what it costs. Costs are
  in the genesis record, agreed before anyone played.
- **No result.** No tile count, no capture list, no "and therefore I own this
  now."

Every one of those absences is the same rule: **a move asserts a decision, never
a quantity.** A field a peer could lie about is a field the rules would have to
be prepared to disbelieve, and the simplest way to be sure a number is right is
never to have received it.

### Encoding

`encodeMove` ([`records.ts`](packages/protocol/src/records.ts)) produces the
bytes that get signed:

```
"tessera/move/1" ‖ u16 len(gameId) ‖ gameId ‖ u32 step ‖ u32 seq
                 ‖ u8 empire ‖ u8 member ‖ u8 type ‖ u8 reserved
                 ‖ u16 x ‖ u16 y
```

The domain tag means a move signature can never be replayed as a chat
signature. The game id means a move signed in one game cannot be replayed into
another — including a game an attacker generated for the purpose. The
fixed-width, range-checked fields mean two different moves can never encode to
the same bytes and so can never share a signature; `moveInRange` rejects
anything out of range *before* the encoder is reached, on both sides, because
a field wider than its slot would silently truncate.

`empire` is range-checked at `>= 1`: zero is neutral ground, and nobody signs
as neutral.

## The eleven types

From [`types.ts:31`](packages/sim/src/types.ts#L31). `validate` in
[`rules.ts`](packages/sim/src/rules.ts) is the whole of the anti-cheat story —
a pure function of state and move, run by every peer, so an illegal move dies
identically everywhere with no trust and no negotiation.

| # | Type | Uses x,y | Validated on | Effect |
|---|---|---|---|---|
| 0 | `PASS` | no | nothing beyond a live seat | nothing. Vestigial: `READY` replaced it |
| 1 | `CLAIM` | tile | passable, `popTimer > 0`, own tile or orthogonally adjacent to one, target not a shielded capital | spends the whole timer × surround multiplier onto the tile; fires any coin under it |
| 2 | `BUY_BRIDGE` | no | `diamonds >= bridgeCost` | `diamonds -= 3`, `bridges += 1` |
| 3 | `BUY_LADDER` | no | `diamonds >= ladderCost` | `diamonds -= 3`, `ladders += 1` |
| 4 | `PLACE_BRIDGE` | tile | `bridges > 0`, terrain is an unbridged `RIVER`, tile adjacent to own territory | terrain becomes `RIVER_BRIDGED`, `bridges -= 1` |
| 5 | `PLACE_LADDER` | tile | `ladders > 0`, terrain is an unladdered `WALL`, tile adjacent to own territory | terrain becomes `WALL_LADDERED`, `ladders -= 1` |
| 6 | `ROSTER_AMEND` | `x` = member kind | `members.length < min(maxSeats, SEAT_CEILING)` | appends a seat at the plain rules |
| 7 | `HEARTBEAT` | no | a live seat | `member.lastBeat = step` — the liveness input the whole mesh reads |
| 8 | `MARCH` | tile | `marchUnlocked`, `popTimer > 0`, passable, *not* adjacent to own territory, a legal via tile exists, target not a capital | splits the spend between the via tile and the target, two tiles out |
| 9 | `BUY_MARCH` | no | `!marchUnlocked` and `diamonds >= marchCost` | `diamonds -= 6`, `marchUnlocked = 1`, permanently |
| 10 | `BUY_GROWTH` | no | `!growthUnlocked` and `diamonds >= growthCost` | `diamonds -= 6`, `growthUnlocked = 1`, permanently |

Four of the eleven carry no coordinates at all. `x` and `y` are still encoded —
the record is fixed-width — and are simply zero, except for `ROSTER_AMEND`,
which is the one move that repurposes `x` as something other than a
coordinate: the new seat's `MemberKind`.

## Purchases

Yes — a purchase is a state change like any other, and it goes through exactly
the same machinery as a claim: signed by the seat, bound to a step three ahead,
gossiped to every peer, validated independently by each of them, applied in
`(empire, member, seq)` order.

Two shapes:

**Consumables buy and place separately.** `BUY_BRIDGE` converts three diamonds
into a bridge in the empire's stock; `PLACE_BRIDGE` spends one from stock onto
a specific river tile. Ladders are the same pair for walls. Splitting them is
what lets an empire bank a bridge before it knows where it will need one, and
it is why the two have entirely different validation: the buy checks a balance,
the place checks terrain and adjacency and touches the board.

**Modifiers buy once and never place.** `BUY_MARCH` and `BUY_GROWTH` are
permanent unlocks, priced at twice a bridge because they change how the empire
works rather than giving it a thing to carry. Both are refused once already
owned — letting an empire spend six diamonds on nothing is a trap, not a
decision — which is also why the client removes them from the shop and shows
them on the HUD instead ([`Controls.ts:109`](apps/web/src/view/Controls.ts#L109)).
Growth is not consumed by using it: it is read once per upkeep pass, twenty
seconds apart, and adds `growthAmount` to every tile the capital can still
reach ([`upkeep.ts:72`](packages/sim/src/upkeep.ts#L72)).

Diamonds themselves are never sent. They are collected inside the simulation —
`collectDiamond` fires when a claim or a cascade passes over one — so an
empire's balance is something every peer computed, not something anyone
reported. A `BUY_MARCH` from an empire holding five diamonds fails `validate`
on every peer at once, including the sender's, and simply does not happen.

Because stock and unlocks are ordinary state, they are inherited: taking a
capital annexes the victim's territory *and* its unspent diamonds, bridges,
ladders and unlocks ([`rules.ts`](packages/sim/src/rules.ts), `annex`). A hoard
nobody got to spend should not evaporate with the empire that saved it.

Neither kind of bot ever buys anything. `policy()` emits `MOVE.CLAIM` and
nothing else ([`policy.ts:256`](packages/sim/src/policy.ts#L256)), for SimBots
and headless PeerBots alike — so every purchase in every game was a person's
decision.

## What every peer knows

All of it. There is no hidden state anywhere in the design.

`snapshot()` is the single canonical serialisation of the world
([`state.ts:114`](packages/sim/src/state.ts#L114)), the state hash is
`fnv1a(snapshot(state))`, and it writes, for **every** empire:

```
capital · bridges · ladders · marchUnlocked · diamonds · growthUnlocked
tilesOwned · popTotal · alive · control · eliminatedAt
16 stat counters, then per member: kind, popMax, popTimer, popAcc,
lastBeat, joinedAt, and 16 more stat counters
```

So each peer holds every rival's diamond balance, bridge and ladder stock,
both unlock flags, every seat's population timer, and all sixteen stat slots
(`PEAK_POP`, `CASCADE_TILES`, `DIAMONDS`, `MARCHES`, `ANNEXED` and the rest —
[`constants.ts:19`](packages/sim/src/constants.ts#L19)). It holds them because
it *derived* them, move by move, from the same log everyone else has.

Two consequences worth being explicit about:

- **The information is available, not hidden by protocol.** What the browser
  client chooses to *display* is a separate question, and today it shows you
  your own diamonds and stock, plus a standings table of tile counts and best
  cascade for everyone ([`Controls.ts:194`](apps/web/src/view/Controls.ts#L194)).
  Nothing stops a peer from rendering every rival's balance; the data is
  already in the tab. A game of hidden information would need a different
  design, because lockstep replication is fundamentally incompatible with one.
- **Divergence is a desync, not an advantage.** Since stock, unlocks and stat
  counters are all inside the hashed bytes, a peer whose numbers differ by one
  fails the next checkpoint comparison and is caught within five seconds.
  There is nowhere to keep a lie: state that is not hashed does not exist, and
  state that is hashed is compared.

A note on wording, since the two are easy to conflate: the **modifiers** are
`marchUnlocked` and `growthUnlocked`, two flags that change what moves are
legal. The **stat slots** are sixteen counters that change nothing and record
what happened — they exist for the leaderboard, which recomputes them by replay
rather than accepting them as reported ([`rankings.ts`](packages/net/src/rankings.ts)).

## Bot moves, which are not messages

A SimBot empire's moves never touch the network. `runSimBots` derives them
inside `advance` from the shared RNG and the profile in the genesis record, so
every peer independently produces the same claim on the same step at zero
bandwidth ([`sim.ts:119`](packages/sim/src/sim.ts#L119)). They are validated on
the same path as anyone's.

A headless PeerBot is the opposite and deliberately so: it holds a real seat
with a real key, and its moves are signed and broadcast like a person's
([`peerbot.ts:215`](packages/net/src/peerbot.ts#L215)). There is no bot-shaped
mechanism in the protocol at all — which is the point, since a seat a host
could conjure would be a seat that dodges the seat cap.

## The other frames

Fourteen frame types exist ([`wire.ts:25`](packages/protocol/src/wire.ts#L25));
only one of them carries a move. The rest are how peers agree about moves, and
none of them can change state on its own:

| Frame | Signed | Says |
|---|---|---|
| `move` | by the seat | one move, bound to a step |
| `ready` | by the seat | "nothing further from me at or before step N" — cumulative, replaces a `PASS` per seat per step |
| `checkpoint` | by the seat | "at step S my state hashed to H" |
| `amendment` | by a quorum of the empire's seats | add this key as a seat — becomes a `ROSTER_AMEND` move locally |
| `drop` | by a majority of all other seats | stop waiting for this seat at exactly this step |
| `equivocation` | carries two seat signatures | proof that one seat sent two different moves for one `(empire, member, step, seq)` |
| `message` | by the seat | chat. Ordered and attributable, and outside the hash |
| `snapshot?` / `snapshot` | content-addressed | the world at a step, safe to take from anyone because the receiver re-hashes it |
| `hello` / `welcome` / `proof` | mutual challenge-response | possession of a key |
| `genesis` | its own hash is the game id | the rules, so a joiner can derive that id itself |
| `bye` | no | a peer leaving |

`ready`, `drop` and `equivocation` change *who a peer waits for*, never what
the world looks like — which is why an ejection is not in the hash while a
roster amendment is. Chat is signed, ordered and attributable but deliberately
unhashed: a message that arrives late, out of order, or never must not be able
to desync a game.

## What happens to a move on arrival

`onMove` in [`lockstep.ts:645`](packages/net/src/lockstep.ts#L645), in order:

1. **Verify the signature** against the key the roster has for that seat. A
   failure is a silent discard — an unverified move must never be fed to
   anything, or a third party could frame a seat.
2. **Check for equivocation.** A second, different move for a
   `(empire, member, step, seq)` already seen is proof of cheating; the proof is
   broadcast and the seat is ejected at a step derived from the proof itself, so
   every peer ejects on the same one.
3. **Drop it if the seat is already ejected** at or before this step.
4. **Reject a move for a step already simulated.** Either the sender broke its
   own readiness promise or this peer advanced when it should not have — both
   consensus failures, not lost packets.
5. **Reject a move too far in the future**, beyond the move horizon, so nobody
   can exhaust another peer's memory by signing a million moves for next week.
6. **Reject a move at a step the sender already declared itself done with.**
7. **Stash it** for its step.

Then, at that step, `Sim.advance` sorts the step's moves by
`(empire, member, seq)` — independent of arrival order — and runs `validate`
on each. Only now do the game's rules get consulted. Signature validity and
rule validity are two entirely separate questions, and keeping them separate is
what lets a peer hold a signed move it will refuse to apply.

An illegal move is not an error condition. It is dropped, identically, by
everyone, and the game continues.
