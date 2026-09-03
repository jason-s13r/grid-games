# Tessera — deterministic core, then a serverless P2P mesh

## Context

Tessera is a recreation of the webgame Empire Attack. The repository began as `grid-games`, a working prototype — one human, one bot, on a CSS-grid board with conic-gradient "flag" tiles. ~600 lines of vanilla JS, no runtime dependencies, bundled by Parcel.

The target is a **literally serverless** multiplayer game: static HTML plus WebRTC, with no server holding authority over the game. It needs to support marathon team games lasting days, where three people may share one empire and rotate shifts, bots can cover the night, and players drop and resume. A server is wanted eventually for metrics, rankings, and durable storage — but never as a referee.

**Consensus model: deterministic lockstep with a signed input log.** Peers exchange only moves, never board state. Everyone runs a bit-identical simulation from a shared seed and periodically broadcasts a hash of its state; mismatch means desync. A CRDT was considered and rejected: CRDTs guarantee *convergence*, not *correctness* — this game's transitions are order-dependent, and a CRDT document has no validation layer to stop a peer writing "I own everything." Under lockstep a peer can only submit *inputs*, and every peer validates every input against its own simulation, so an illegal move dies identically everywhere with no trust and no negotiation.

Determinism is therefore a hard prerequisite for the netcode, and it is also what deterministic bots require — one property buys both. Build order is core-first.

### The one unavoidable server

Signalling is not the problem: PeerJS's public broker introduces peers and never sees a move, and GitHub Pages serves over HTTPS so WebRTC is satisfied. But roughly 10–20% of peer pairs sit behind symmetric NAT and cannot form a direct connection without a **TURN relay**, which by definition forwards packets. It never touches game logic — moves stay signed and state stays hash-verified through it, so a hostile relay can drop packets but cannot forge or alter a single move. "Zero servers" is really **"zero authority servers"**, and that property survives fully intact.

> **Resolved.** PeerJS ships relays of its own and uses them unless it is handed an ICE configuration, so the default path needs nothing built. The trap is that its `config` option is merged one level deep: passing one *replaces* its defaults rather than adding to them, and this repository spent several versions handing it a lone STUN server and silently deleting the relays. `iceServers` now points the mesh at a coturn you run, and is unset otherwise. Self-hosting remains the answer to not depending on someone else's free tier.

---

## Phase A — Deterministic simulation core

The current `cells[x][y]` packs owner and population into one signed integer. That caps the game at two players and leaves nowhere for terrain, coins, or diamonds on the same tile. Replace it with flat typed arrays — also directly hashable for the consensus check, and cheap to snapshot.

### A1. State representation

`src/sim/state.js`. All layers flat, indexed `i = y * width + x`:

| Layer | Type | Meaning |
|---|---|---|
| `owner` | `Int8Array` | `0` neutral, `1..N` empire id |
| `pop` | `Int32Array` | population on tile, always `>= 0` |
| `terrain` | `Uint8Array` | `PLAIN, MOUNTAIN, LAKE, RIVER, RIVER_BRIDGED, WALL, WALL_LADDERED` |
| `item` | `Uint8Array` | `NONE, BRONZE, SILVER, GOLD, DIAMOND` |

Ownership moves out of the sign of `pop` into its own layer — this is what unlocks N empires and neutral-but-populated tiles. At 1024×1024 the four layers total ~7 MB, so "arbitrarily large" is bounded by memory rather than design; map size is a genesis parameter.

Combat generalizes the current `+=`:

```
place(i, empire, amount):
  if owner[i] == empire or (owner[i] == 0 and pop[i] == 0):
      pop[i] += amount; owner[i] = empire
  else:
      pop[i] -= amount
      if pop[i] < 0:  owner[i] = empire; pop[i] = -pop[i]
      if pop[i] == 0: owner[i] = 0
```

**Empires and members.** An empire is not a player — it is a set of authorized member keys:

```
empires[e] = { capital, bridges, ladders, diamonds, tilesOwned, alive,
               members: [ { key, kind: HUMAN|BOT, popTimer, lastActive } ] }
```

Population timers are **per member**, territory is shared. Three teammates means three independent click streams into one empire, which is exactly what produces simultaneous battle fronts and makes a 3v1 numerically meaningful. Shift handover needs no mechanism at all — the incoming player simply has their own timer.

### A2. Determinism discipline

`src/sim/rng.js` — mulberry32, ~6 lines, integer seed in, uint32 out. **This becomes the only source of randomness in the simulation**, replacing every `Math.random()` in [BaseGame.js](src/BaseGame.js), [Player.js](src/Player.js), [Bot.js](src/Bot.js), and [EmpireAttack.js](src/EmpireAttack.js).

Each hazard below is a silent desync that surfaces only between two specific browsers, twenty minutes in:

- **Integers only in game logic.** `Math.sqrt`/`pow`/trig are not guaranteed bit-identical across JS engines. Use squared distances (as [Bot.js:132](src/Bot.js#L132) already does) and explicit `Math.floor` on every division.
- **No iteration-order dependence.** Iterate flat arrays by index; never iterate a `Set`/`Map` whose insertion order could differ per peer.
- **Fixed RNG consumption order.** One stream, consumed in a fixed sequence per step. Never call `rng()` inside a short-circuiting condition that one peer might skip.
- **Fix the `Set`-of-arrays bug.** `path` is `new Set([[x,y]])` with `path.add([x,y])` — arrays compare by identity, so it has never deduplicated, and `Array.from(new Set(outer))` at [Bot.js:114](src/Bot.js#L114) and [Bot.js:137](src/Bot.js#L137) is a no-op. Replace with `Set<number>` of flat indices or a `Uint8Array` mask. Correctness fix and determinism fix at once.

`src/sim/hash.js` — FNV-1a over the four layer buffers plus empire records. This is the value peers compare and the value that content-addresses snapshots.

### A3. Geometry

`src/sim/geometry.js`, replacing [src/utils.js](src/utils.js):

- `orthogonal(x, y)` — the 4 neighbours, **not** including self.
- `vonNeumannBall(x, y, r)` — the pixelated-circle shape, including self.

The existing `getNeighbours` conflates these: it returns a plus of 5 *including the cell itself*, so a fully surrounded tile currently yields a multiplier of 5. Splitting them gives the intended `999 × 4 = 3996` cap.

| Coin | Radius | Tiles |
|---|---|---|
| Bronze | 1 | 5 |
| Silver | 2 | 13 |
| Gold | 3 | 25 |

### A4. Wall-clock time and the event queue

The step number derives from **real elapsed time since genesis**, so the world turns whether or not anyone is watching — coins spawn, timers fill, and you wake to a changed map. This is what makes shift rotation meaningful.

The consequence drives the whole world-update design: **schedule events, never scan the map per tick.** `src/sim/events.js` holds a priority queue keyed by `(step, seq)` — a monotonic `seq` gives a total order so heap tie-breaks can never differ between peers. A coin spawn fires, picks its tile via RNG, and schedules the next spawn at `step + interval(rng)`.

Fast-forwarding six offline hours is then ~a few hundred events rather than 260,000 whole-map scans — milliseconds instead of a minute. Empty steps are skipped entirely.

### A5. Mechanics

**Population timer.** Per member, `+1` per step, capped at 999 (as in [Player.js:27](src/Player.js#L27)). Spent in full by a claim.

**Surround multiplier.** `multiplier = count of the target's orthogonal neighbours owned by the acting empire`, clamped `1..4`; `base = popTimer × multiplier`. This exists informally at [Bot.js:53](src/Bot.js#L53) and [EmpireAttack.js:182](src/EmpireAttack.js#L182) and becomes one shared rule for humans and bots alike.

**Coin claim and cascade.** `perTile = floor(base / shapeSize)`, remainder added to the coin tile so nothing is lost. Cascade is a FIFO queue seeded with the clicked coin:

1. Pop a coin tile, clear its `item`, compute its shape.
2. `place()` `perTile` on every passable tile in the shape, in flat-index order.
3. Any tile in that shape still holding an untriggered coin is pushed onto the queue.

A triggered coin spreads **the same `perTile` value** across its own full shape — population is created by the cascade, not divided. That is what makes farming an enclosed field explosive. Guards: a `visited` mask so each coin fires at most once, and a cap on total tiles touched (start 4096).

**Spawning.** Coins and diamonds spawn via scheduled events onto tiles where `owner == 0 && item == NONE` and terrain is passable, with a weighted rarity roll. Because eligibility requires *neutral* tiles, enclosing an area and leaving neutral pockets inside it is precisely what enables farming.

**Obstacles.** Generated at map-gen from the seed (`src/sim/mapgen.js`): mountain and lake blobs, rivers as edge-to-edge random walks, walls as line segments. `MOUNTAIN` and `LAKE` are permanently impassable; `RIVER` becomes passable once bridged, `WALL` once laddered. Diamonds buy bridges and ladders; placing one converts the terrain permanently and for everyone, keeping it a strategic commitment rather than a private road.

**Noob protection.** A capital cannot be captured until its empire crosses `tilesOwned >= NOOB_TILES` **or** `step >= NOOB_STEPS`, whichever lands first. Enforced in validation, rendered as a ring.

### A6. Moves, validation, and the step loop

`{ step, empire, member, seq, type, x, y, sig }`, where `type ∈ { CLAIM, BUY_BRIDGE, BUY_LADDER, PLACE_BRIDGE, PLACE_LADDER, ROSTER_AMEND, HEARTBEAT, PASS }`.

`validate(state, move)` in `src/sim/rules.js` is a pure function — **this is the entire anti-cheat story.** It rejects: a signing key not in the named empire's member list, target not orthogonally adjacent to a tile the empire owns, target impassable, insufficient member timer, insufficient inventory, and any move against a capital still under protection. Because validation is part of the deterministic simulation, every peer drops an invalid move identically.

`Sim.step()` in `src/sim/sim.js`, in fixed order:

1. Apply moves for this step, sorted by `(empire, member, seq)` — canonical, independent of arrival order.
2. Generate SimBot moves from the seeded RNG.
3. Fire due scheduled events.
4. Advance the counter; return dirty tile indices.

**The interface the mesh will code against** — fixed now, so Phase C drops on without reworking the sim:

```
step(moves) -> dirtyIndices      hash() -> uint32
snapshot() -> ArrayBuffer        restore(buf)
validate(move) -> bool           fastForward(toStep)
```

### A7. Two kinds of bot

Both share one targeting policy — `policy(state, empire, member, rng) -> move` in `src/sim/policy.js`, ported from the real design work already in [Bot.js](src/Bot.js) (`expand`, `attack`, `defendTiles`, `defendHome`, mode cycling), fixing `% this.modes` → `% this.modes.length` at [Bot.js:17](src/Bot.js#L17) on the way. Only *where it runs* and *what limits apply* differ.

| | **SimBot** (Phase A) | **PeerBot** (Phase C) |
|---|---|---|
| Runs | inside every peer's sim | as its own mesh client |
| Controls | a whole bot empire | a member seat in a human empire |
| Bandwidth | zero | one signed move per action |
| Randomness | shared seed | anything — moves are validated, not derived |
| Use | demo, single-player, filler empires | night shift, AFK cover |
| Can it drop? | never | yes, empire simply idles |

**PeerBots cost the empire something**, or night cover is strictly free and therefore overpowered. Proposal, all tunable at genesis: a `BOT` member accrues at **50% rate**, caps at **499** rather than 999, and **cannot chain cascades** (its coin claims fire, but triggered coins do not re-trigger). A bot holds the line; it cannot execute the big farming play. That keeps cascade mastery as the human skill expression while still letting a team sleep.

Genesis picks per empire: `control: HUMAN | SIMBOT`, plus a member list that may include bot keys.

> **Revised.** The genesis record no longer composes bot seats inside human empires, and the lobby has no control for it. A host arranging its own team a couple of extra seats — while every other empire got what it turned up with — is not a feature, it is an unfair setup with a UI. Seats in a human empire are the people who are there, and another one joins the way a substitute always has: `ROSTER_AMEND`, endorsed by a quorum of the empire already holding it. A headless bot is seated by exactly that route, which is also how it plays a whole empire of its own if that is what somebody wants.
>
> What replaces it is **a seat cap, `rules.maxSeats`, defaulting to four**: three people rotating shifts plus a seat to cover the night. An empire is a set of seats sharing territory with a population timer each, so a side that can add seats freely simply out-accrues everyone else — and since a headless bot is an ordinary peer holding an ordinary seat, "add seats" costs nothing but processes. The cap is in the genesis record, uniform across every empire in the game, refused by `inspectGenesis` before a peer agrees to play and again by `validate` on every amendment. No quorum can vote itself a bigger team than the game allows.
>
> The growth modifier stays as it was, and it is the part that was always doing the useful work: a `BOT` member accrues at half rate, caps at 499, and its coin claims never chain. Cover, priced.

### A8. Liveness, win conditions, and stats

**Presence must be derived from the log, not from sockets.** This is the subtle one. "Last player remaining" cannot be evaluated from connection state, because peers genuinely disagree about who is reachable — two peers would compute different winners and desync. So members emit a signed `HEARTBEAT` roughly every 30 s of game time, and **a member is live at step S if their last heartbeat falls within `LIVENESS_WINDOW` steps.** Presence becomes a deterministic function of the log, identical on every peer.

That one move type pays for itself three times: it powers the win check, it gives Phase C's stall detection a deterministic basis instead of each peer guessing, and it drives the AFK indicator in the UI.

**Win conditions**, checked each step, configured at genesis:

| Condition | Rule |
|---|---|
| Timeout | `step >= endStep` — natural under the wall-clock model. Highest score wins. |
| Last empire standing | All other empires eliminated. |
| Last roster standing | All other empires have had **no live member** for `ABANDON_WINDOW` steps. |

Elimination itself is a genesis switch: `CAPITAL` (lose your capital, lose the game) or `ANNIHILATION` (`tilesOwned == 0`).

The abandonment rule needs a deliberately long window — hours of game time, not minutes. Being asleep is not being defeated, and a short window would reward waiting until an opponent's team is offline, which is precisely the behaviour the shift-rotation design exists to avoid.

**Stats live in hashed state**, so end-of-game figures are consensus by construction rather than something clients report and a server has to trust. Tracked **per member as well as per empire**, so individual contribution is visible in a team game:

peak population · peak tile area · largest single cascade (tiles and population) · coins claimed by type · most tiles taken in one move · diamonds collected · bridges and ladders placed · steps holding a capital

Because they are in the hash, `tools/replay.js` reproduces every award exactly — which is what makes the Phase D leaderboard verifiable instead of merely reported.

---

## Phase B — Renderer for an arbitrarily large map

**Not Leaflet.** It is built around raster tile pyramids from a tile server, carries a lat/lng CRS you would fight constantly, and its DOM tile lifecycle assumes tiles are static images — whereas here every cell can change every tick. The pieces needed are small and the data is already in the ideal shape.

`src/view/Renderer.js`, replacing the grid handling in [BaseGame.js](src/BaseGame.js):

- **Virtualized tile window.** Render only tiles in view plus a margin ring — at 24px cells in a 1200×700 viewport that is ~1500 tiles, the same order as today regardless of map size. Recycle elements from a pool while panning instead of creating and destroying them.
- **Element index, not queries.** The current `render()` runs a `querySelector` per cell per frame ([EmpireAttack.js:158](src/EmpireAttack.js#L158)) — 800 DOM queries a frame on a 40×20 grid. Hold a flat array of element refs and touch only the dirty indices returned by `step()`.
- **Level of detail.** Above ~12px per cell, DOM tiles with the full flag art. Below it, swap to a canvas that draws colour blocks — that is the "lower-res approximation" of a zoomed-out view, with no DOM cost at all.
- **Minimap** (the AoE piece). A canvas at one pixel per tile, written directly from the `owner` layer into an `ImageData` buffer and blitted scaled — the flat typed array makes this close to free. Draw terrain shading beneath, the viewport rectangle above; click and drag to jump the camera.
- **Per-empire theming.** Theme by owner id, not by `[title^="-"]` as at [tessera.scss:107](apps/web/tessera.scss#L107). Parameterize the existing conic-gradient flag themes on `--c1`/`--c2` and set them per empire class, so adding an empire is a variable swap rather than a new gradient block.

Camera state (`camX, camY, zoom`) is pure view state: never in the sim, never hashed, never sent. `src/view/Controls.js` keeps [R.js](src/R.js) for counter, inventory, and shop bindings — that part earns its keep as is.

`tools/replay.js` lands here too: given `{ genesis, moveLog }`, run headless under Node and print the final hash. Two tests before any networking exists — **self-determinism** (1000 steps, 4 SimBots, twice from one seed, identical hashes) and **cross-environment determinism** (same log in Node and browser, identical hashes). The second is what catches the A2 hazards.

---

## Phase C — The mesh

### Genesis and authorization

A signed genesis record is the root of trust, and **its hash is the game id**:

```
{ gameId, seed, mapParams, rules, startTimeUTC,
  empires: [ { id, control, members: [pubkey] } ] }
```

Anyone may connect and observe. Only keys in the roster produce accepted moves — so an arbitrary mid-game join is an observer by construction, with no extra mechanism. Adding a substitute later is a `ROSTER_AMEND` move signed by a quorum of that empire's existing members; it goes through the log like any other move, so every peer applies it deterministically.

Identity is a Web Crypto **ECDSA P-256** keypair per member — P-256 purely because Ed25519 support is still patchy in browsers. The public key *is* the member.

### Transport and lockstep

- **`src/net/Mesh.js`** — the host's PeerJS id is the room code; joiners dial the host, receive the roster, and dial everyone into a full mesh. At 6 peers that is 15 connections.
- **`src/net/Lockstep.js`** — input delay of `D` steps (start 3, ~250 ms at 12 steps/s): a click at step `T` is broadcast immediately and applied by all at `T + D`. A step commits when a move-or-`PASS` has arrived from every live peer; on timeout a peer is marked stalled and after `K` steps its seat simply idles. Because timers are per member, one stalled teammate never blocks the empire.
- **Desync detection** — broadcast `hash(state)` every `K` steps; a minority replays from the last agreed checkpoint, and is ejected if it still disagrees.
- **Equivocation** — two validly signed moves sharing `(member, seq)` is cryptographic proof of cheating. The finder broadcasts both, every peer verifies independently, and the member is ejected. Since the mesh gossips every move it sees, sending different moves to different peers is *detected*, not merely suspected.

### Chat

Strategising with teammates and trash-talking opponents both matter, and they fit the log rather than a side channel — but only with one structural rule.

**The log carries two classes of entry: `moves`, which change state and are hashed, and `messages`, which are ordered, signed, and attributable but are *not* hashed.** Keeping chat out of the hash is what makes it safe: a message that arrives late, out of order, or not at all can never cause a desync. It still replays in place, so a recorded marathon game plays back with its banter intact.

- **Public chat** — plaintext, signed, all-empire. Attribution is free, since every entry already carries a member key.
- **Team chat** — the mesh broadcasts everything, so privacy has to be cryptographic. Each empire derives a shared team key at genesis via ECDH over the same P-256 member keypairs, and team messages are AES-GCM encrypted to it. Opponents and archive peers store the ciphertext without being able to read it. A `ROSTER_AMEND` that adds a member rewraps the team key for the new key set.
- **Post-game reveal** — ~~publishing the team key at game end makes an archived replay fully readable, banter and all~~. **Dropped.** The construction that shipped is per-message fanout rather than a group key: a random content key encrypts each message and is wrapped once per teammate over ECDH, which needs no live participant to distribute a key and lets an amended member be written to immediately. The cost is exactly this feature — there is no single team key to publish, so an archived team channel stays sealed. Worth naming as a trade rather than leaving as an unbuilt promise: P-256 cannot do group key agreement without someone online to run it.
- **Muting** is local view state. No consensus, no log entry, nothing to agree on. Clicking a name hides that seat's lines; a bar under the log is the way back, and muting resets with the game, because a seat number is a different person in the next one.

### Checkpoints and resume

Every N steps peers snapshot state, content-addressed by its hash. A returning player fetches `snapshot@S` from **any** peer, verifies `hash(snapshot) == H` against the agreed value, then replays the move log from S and fast-forwards wall-clock time to now.

The hash is the proof, so **a snapshot from an untrusted peer is safe to accept** — which is exactly what lets an archive peer exist without becoming an authority.

---

## Phase D — Observer and archive peers

An observer is a peer with no empire: it validates, hashes, and stores, but cannot move. Run one as an always-on browser tab, a Node process, or a small VPS, and a multi-day game survives everyone being offline at once — the durability gap that genuinely argues for a server, closed without granting one any power.

The same process backs stats and rankings: it holds `{ genesis, moveLog }` and replays it through the identical simulation to verify any claimed outcome. **Cheat-proof leaderboards without trusting a single client**, reusing `tools/replay.js` unchanged.

> **Built.** `@tessera/headless` is the runtime and [apps/observer](apps/observer) and [apps/bot](apps/bot) are the two programs. The archive format is the one `pnpm replay --log` already read, so nothing new had to be taught to check it, and `verifyArchive` adds the half replay never covered: the roster is rebuilt from the genesis record and every signature in the log is checked against it, so a file proves *who* played and not merely that a game did.
>
> Four things turned out to be worth naming rather than assuming:
>
> - **A room code is a peer id.** A game is reachable only at a peer that is still connected, so an always-on observer is not just a witness — with `--as` it is the door back in, and without one a game whose host went to bed has no address at all.
> - **An archive can be a fragment.** A peer that joined an hour in holds a log that does not replay from genesis. `from` records where the log actually starts and verification says so, rather than leaving a reader with an unexplained hash mismatch.
> - **A bot needs no mechanism.** It is seated by `ROSTER_AMEND` like any substitute: it joins as an observer, prints its key, and an empire votes it in. From the mesh's side it is a player who never sleeps.
> - **PeerJS wants globals.** It reads `RTCPeerConnection` off the global object with no injection point, so a headless peer needs `node-datachannel` — the only native dependency in the repository — installed where it looks before it looks. Its own load path needed fixing too: under Node the library resolves to CommonJS, and the interop namespace puts the exports object under `default`, which is not a constructor.
>
> The table is `tessera-observe rank <dir>`, and it turned out to be mostly refusal rather than arithmetic. `rankArchives` verifies every archive it is given and builds the standings out of the replays, so no figure on it was ever reported by anyone; what it declines to count is the part worth designing. A fragment does not count, because the stats depend on the part that is missing. An edited log does not count. And a game counts *once* however many observers archived it — two observers on one game is how an archive is kept safe, not a corner case, so a duplicate is named rather than added twice. `verifyArchive` gained the outcome it was already computing: a second replay to find out who won would have been the only expensive thing in the file, done twice.

---

## Toolchain

Move to pnpm. [package.json](package.json) currently has no `scripts` and no `parcel` dependency — only `@parcel/transformer-sass`, with Parcel resolving through `npx`.

- Add `"packageManager": "pnpm@…"`, `"source": "index.html"`, a pinned `parcel` devDependency (2.16.4, already resolving), and `dev` / `build` / `preview` / `replay` scripts.
- Delete `yarn.lock` in favour of `pnpm-lock.yaml`.
- **Known snag:** Parcel's resolver sometimes trips over pnpm's strict symlinked `node_modules`. If it does, `node-linker=hoisted` in `.npmrc` is the fix.
- **GitHub Pages:** build with `--public-url ./` for the project subpath, add `.nojekyll`, and deploy via a Actions workflow. HTTPS there satisfies WebRTC; the TURN caveat above is the only real limit.

---

## Files

**New:** `src/sim/{constants,rng,hash,state,geometry,mapgen,events,rules,policy,stats,victory,sim}.js`, `src/view/{Renderer,Minimap,Camera,Controls,Chat}.js`, `tools/replay.js`, then `src/net/{Identity,Genesis,Mesh,Lockstep,Snapshots,Chat}.js`

**Kept:** [src/R.js](src/R.js) as is; [tessera.scss](apps/web/tessera.scss) extended for per-empire themes, terrain, and items

**Retired into the new structure:** [src/BaseGame.js](src/BaseGame.js), [src/EmpireAttack.js](src/EmpireAttack.js), [src/Player.js](src/Player.js), [src/utils.js](src/utils.js), and [src/Bot.js](src/Bot.js) (targeting logic ported to `src/sim/policy.js`)

---

## Verification

**Phase A** — headless, via `pnpm replay`:
- Four empires (one human seat, three SimBots) play to a conclusion without exceptions.
- Bronze claims 5 tiles at `floor(base/5)` each; silver 13; gold 25.
- Four-side surround places `999 × 4 = 3996`; one side places 999.
- A coin inside a claim radius triggers, and a chain produces a sudden jump in tile count.
- Mountains and lakes are impassable; a river blocks until bridged, then passes; bridges need diamonds.
- A protected capital rejects attacks, and protection lifts on the tile threshold or the timer, whichever comes first.
- Two members of one empire accrue independent timers and can act on the same step.
- `fastForward()` across six simulated offline hours produces the same hash as stepping through it, in under a second.
- Each win condition fires correctly: a timeout ends on score, a captured capital eliminates, and an empire whose members stop heartbeating is declared abandoned only after `ABANDON_WINDOW` — not before.
- End-of-game stats (peak area, largest cascade, coins by type) are identical across two independent runs of the same log, and attribute to the right *member* in a shared empire.

**Phase B** — the same game is playable on a 512×512 map: panning stays smooth, zooming out swaps to the block renderer, the minimap tracks ownership and moves the camera on click, and Node and browser agree on the hash for one seed and log.

> The hash check runs against **four** engines, not two. Chromium is V8 as Node is, so that pairing catches a bundler or environment difference and never an engine one; WebKit and Firefox are the two that would actually disagree about a float or an iteration order. One environment-blind test file, replayed from a recorded game rather than a seeded one — a seeded game exercises the world's machinery and none of the move path.

**Phase C** — two tabs, then two machines, play with matching hashes throughout; a deliberately corrupted client is caught within `K` steps; a reload rejoins by snapshot plus replay; a PeerBot covers a seat at reduced rate and cannot chain a cascade; a non-roster peer's moves are rejected by every peer. Public chat is readable by all; team chat is ciphertext to an opposing peer and to an observer; and dropping every chat message on one peer changes no state hash — the proof that chat is genuinely outside consensus.
