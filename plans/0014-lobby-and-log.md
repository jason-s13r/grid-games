# 0014 — The lobby rejig and the game log

Status: built (2026-09-16)
Depends on: 0009 (the proposal it renders), 0010, 0011, 0012, 0013
Branch: `lobby-and-log`

## The problem

Everything 0009–0012 adds is invisible. `LobbyPanel` is a host-composes /
others-wait screen (`apps/web/src/view/LobbyPanel.ts:1`, "deliberately thin"),
and once the game starts there is no surface at all for what the roster is
doing — only `RosterView`'s two small lists (`LobbyPanel.ts:30`) tucked beside
the seat display.

And nothing anywhere tells a player what happened while they were away. A
ten-day game where you sleep for eight hours currently resumes with a
different map and no account of how it got that way.

## Before the game: the proposal screen

The lobby stops being a picker with an audience and becomes a shared sheet.
Rendered from the 0009 proposal, identically for everybody — there is no host
role left to privilege, and any player may post a revision:

1. **Duration** — one control (0002) — common lengths plus free entry, since
   a duration is a step count and not a preset — with the derived numbers shown as
   words: "ends Thursday 19:40 · open to joiners until Tuesday 07:40 · a team
   is abandoned after 36 h quiet". Three rules from one control, and the
   reason is visible.
2. **Empires** — seated players, and a row per **vacancy** (0010) shown as
   what it is: a capital on the map with nobody in it.
3. **Opponents** — SimBot rows with a difficulty select, plus a **Custom**
   entry opening the `BotProfile` editor (0009): population ceiling, and a
   duration-and-rate pair per phase. The floor and the ceiling are shown as
   the constraints they already are, not validated a second time.
4. **Signed** — "3 of 4 signed" against the current revision, and one button
   that signs it. Editing any field posts a new revision, which shows the
   count reset to 1: the cost of a change is visible to whoever is making it.

Nobody's controls are privileged. The screen shows one live count — how many
people have agreed to *this* revision of the world — and the room peer seals
at the start time with whoever signed by then (0009).

## During the game: the roster screen

One tab (`apps/web/src/view/Tabs.ts`), three lists:

- **Applications** to our empire (0011), each with the applicant's
  `name#fingerprint` (0012) and the tally so far. Endorse is a real decision,
  which is why it is a button and never automatic — `lockstep.ts:912` makes
  that argument and this screen must not undo it.
- **Vacancies** (0010), each with a Claim button, live only while we hold no
  seat and the join window is open. A player claiming a vacancy needs no
  approval from anyone, and the screen should not imply otherwise.
- **Watching** — seatless peers present, the existing `RosterView.waiting`
  list, now with names.

## The log

Two streams, and keeping them apart is the whole design.

**World events are derived from the log and therefore identical on every
peer.** An annexation, a capital falling, a coin taken, an upkeep sweep, a
seat arriving by amendment, a seat dropped by quorum, an equivocation proof,
the game ending. Every one of these is already produced by machinery that
exists: `applyMove` and `checkVictory` in the sim, `EVENT` in
`packages/sim/src/events.ts`, and the `onApplied`, `onSeated`, `onAmended`, `onEjection` and
`onViolation` hooks on `Lockstep` (`packages/net/src/lockstep.ts:202-227`). Two players comparing this stream see the same lines in
the same order, which is a property worth having and worth testing.

**Session events are local**: a peer connected, a snapshot was requested, the
transport reconnected, we resumed from a resume point. These are true for this
tab only and are drawn in a visibly different register. A player must never
have to wonder which kind of line they are reading.

Timestamps are step numbers rendered as game time, as chat already does
(`Chat.ts:35`): "the step number is the one clock every peer already agrees
on, so two players comparing screenshots see the same stamp."

Two practical constraints, both learned from the panels that exist:

- **Cap the DOM.** `MAX_LINES = 200` in `Chat.ts:25` is there because a
  multi-day game otherwise accumulates a node per line said since Tuesday. The
  log is noisier than chat; it needs a cap, a filter per category, and a
  "since I was last here" divider rather than an unbounded scrollback.
- **Do not redraw what has not changed.** `LobbyPanel` keeps a `drawn` string
  for exactly this reason (`LobbyPanel.ts:63`): "redrawing an unchanged list
  would cancel the click the player is in the middle of making." A log that
  re-renders at 12 Hz would make every button beside it unusable.

## The terminal (stretch)

A command line over the same driver: `claim 41,17`, `march 43,17`, `buy
bridge`, `say -t regrouping`, `apply 5`. It is a stretch goal and it is
written down because it changes one decision early: commands would become the
game's public vocabulary.

Note for whoever picks it up: the internal type is named `Move` and it covers
purchases, heartbeats and roster amendments as well as movement. That is a
known misnomer and renaming it is deliberately deferred — but a terminal is
the first thing that would put those names in front of players, so the DSL
should choose its own words rather than mirroring the enum.

## Verification

- The proposal screen renders identically from the same proposal on every peer
  (a snapshot test over the two DOM trees).
- The world-event stream is deterministic: two harness peers play the same
  recorded game and produce byte-identical world logs. The session streams
  differ, and the test asserts that they may.
- A ten-minute game at full tempo leaves the log at its cap and every button on
  the roster screen still clickable — the redraw constraint, measured rather
  than assumed.
- Claiming a vacancy and endorsing an application both work from the roster
  screen end to end against the harness.
- No test in `packages/sim` or `packages/net` changes. This plan is UI, and
  the recorded-game suite is the tripwire that proves it.

# Implementing it

A plan of action for 0014, written after reading the code it names. Every line
number below was checked against the tree at `docs` HEAD.

The body is right that everything 0009–0012 adds is invisible. It is wrong
about why, and the real reason is worse: the roster UI that exists today is
rendered into an element that is `hidden` for the entire duration of a game.
And the log's central claim — that world events are "already produced by
machinery that exists" — is not true of any machinery in this repository. What
exists is something better, but it is a different thing and it changes where
the code goes.

## What ships

| File | Change |
|---|---|
| `packages/sim/src/journal.ts` | new — `Tally`, `tally(state)`, `journal(before, after)`, `WorldEvent` |
| `packages/sim/src/index.ts` | exports |
| `packages/sim/src/test/journal.test.ts` | new — the diff, and the upkeep metronome |
| `packages/net/src/worldlog.ts` | new — `WorldLog`: the journal plus the net facts that are shared |
| `packages/net/src/index.ts` | exports |
| `packages/net/src/test/worldlog.test.ts` | new — two harness peers, one byte-identical stream |
| `apps/web/src/view/tap.ts` | new — chain a handler onto a `Lockstep` hook, modelled on `Archive.attach` |
| `apps/web/src/view/LogPanel.ts` | new — two streams, a cap, a filter, a divider |
| `apps/web/src/view/RosterPanel.ts` | new — applications, vacancies, watching; the during-game screen |
| `apps/web/src/view/Proposal.ts` | new — `proposalBody(proposal, me)` as a pure string function, plus the panel around it |
| `apps/web/src/view/LobbyPanel.ts` | loses `RosterView` and `rosterBody`; keeps host/join/failed and hands composition to `Proposal` |
| `apps/web/src/view/Chat.ts` | `stamp` is exported and learns about days |
| `apps/web/src/view/Controls.ts` | the standings and the shop stop being rewritten five times a second |
| `apps/web/src/main.ts` | the archive is attached **last**; the log is wired through `tap` |
| `apps/web/index.html` | two `<details data-acc>` panels — roster, log |
| `apps/web/styles/main.scss` | the log's own register; the right column stops assuming chat is the only thing that flexes |
| docs | seven files, below |

## The lead finding: the roster screen is not "tucked beside the seat display" — it is behind the door marked Leave

The body says the roster today is "only `RosterView`'s two small lists
(`LobbyPanel.ts:30`) tucked beside the seat display". Two things are wrong with
that sentence and the second one is a bug.

**They are not beside the seat display.** `[data-roster]` — the panel headed
"Your seats" (`index.html:57`) — is written by `Controls.render`
(`Controls.ts:171-181`) and lists the members of *your own* empire. `RosterView`
is written by `LobbyPanel.rosterBody` (`LobbyPanel.ts:274`) into `[data-lobby]`.
Different lists, different panels, different files.

**And `[data-lobby]` is at `index.html:135`, inside `<section class="screen"
data-menu>`.** `Shell.show` sets `els.menu.hidden = screen !== "menu"`
(`Shell.ts:61`), so from the moment `shell.show("game")` runs the whole setup
screen — lobby panel included — is `display: none`. The only control that goes
back the other way is

```ts
pick<HTMLButtonElement>('[data-action="leave"]').addEventListener("click", () => {
  leaveMesh();
  shell.left();
});
```

(`main.ts:365-368`), and `leaveMesh` closes the lobby, drops the mesh and calls
`panel.detach()` (`main.ts:321-330`). There is no other route to the menu during
a game. `[data-action="resume"]` is a button *on* the menu.

So: **the invitation and endorsement UI cannot be reached while a game is
running.** `main.ts:399` calls `panel.setRoster(rosterView(mesh))` five times a
second, `rosterBody` builds an "Asked to join your empire" list with an Agree
button on every row, and all of it is painted into a hidden element for the
whole life of the game. The one way to look at it destroys the thing it is
about.

That is the actual state of the art this plan is improving on, and it changes
the shape of the work: **the roster screen is not a rewrite of a thin panel, it
is a move.** Its contents mostly exist and are correct. What they need is a
`<details data-acc>` in the left sidebar, which `Tabs` will then give a tab
without being told (`Tabs.ts:66-82`).

**This half depends on nothing.** Applications (0011), vacancies (0010) and
names (0012) add rows to a list that can be on screen next week.

## The second finding: the client already breaks the archive, on the exact hazard this plan is about to repeat

`Archive.attach` chains rather than replaces, and says why in a comment that
reads like it was written after this went wrong once:

> Existing handlers are chained rather than replaced: the client sets
> `onMessage` to draw the chat log long before anybody asks for an archive, and
> quietly stealing that callback would empty the panel.

(`archive.ts:118-121`.) The client then does it in the other direction:

```ts
archive = new Archive(genesis, driver);
archive.attach(driver);            // main.ts:508 — captures onMessage: undefined
archiveBtn.hidden = false;
driver.onMessage = (message, text) => chat.add(message, text);   // main.ts:511
```

`attach` wraps whatever is there and installs its wrapper; three lines later
that wrapper is overwritten. `Archive.chat(envelope)` is never called again.
**Every archive this client has ever produced contains no chat log.** The
"keeps chat, and keeps a team line sealed" test (`archive.test.ts:75`) passes,
because it wires the harness itself and never runs `main.ts`.

This matters here and not only in passing: the log panel wants `onApplied`, and
`onApplied` is the other hook `attach` wraps. Assign it the way `onMessage` is
assigned today and the downloadable archive loses its **move log** as well — the
"Save log" button would hand the player an empty file that verifies, because
there is nothing in it to refuse.

Two changes, both small:

- **`archive.attach(driver)` moves to the end of `lobby.onStart`,** after every
  UI hook is in place. One line, and it is the fix for the live bug.
- **Nothing assigns a `Lockstep` hook directly after that.** Every hook on
  `Lockstep` is a single optional field (`lockstep.ts:189-227`) and there are
  already four owners competing for six of them: `OnlineGame` takes
  `onEjection`, `onDesync` and `onHalt` in its constructor (`Online.ts:26-42`),
  `main.ts` takes `onMessage` and `onSeated`, and `Archive` takes three by
  chaining. The log wants four that are already spoken for. `apps/web/src/view/tap.ts`
  is fifteen lines that do what `attach` does, for one hook, and returns the
  undo.

## The world log is not derived from machinery that exists — it is derived from the counters, which is better

> Every one of these is already produced by machinery that exists: `applyMove`
> and `checkVictory` in the sim, `EVENT` in `packages/sim/src/events.ts`

None of those three produce anything a reader could log.

- `applyMove(state, move, dirty): void` (`rules.ts:325`) mutates state and adds
  tile indices to a set. It returns nothing and tells nobody what it did.
- `checkVictory(state): void` (`victory.ts:35`) sets `empire.alive = 0` and
  `state.phase` in silence.
- `EventQueue` is a **scheduler**, not an event bus. `runEvents`
  (`sim.ts:148-161`) polls one, calls `upkeep` or `spawnItem`, and drops it.
- `Sim.advance` returns a `DirtySet` — tile indices, with no account of why any
  of them is dirty (`sim.ts:92-117`).

And the hook the body reaches for fires on the wrong side:

```ts
// Before advancing: the hook describes the step about to run, and a
// listener that throws must not leave the simulation half-stepped.
this.onApplied?.(step, moves, signed);
for (const index of this.sim.advance(moves)) dirty.add(index);
```

(`lockstep.ts:441-445`.) `onApplied` is the step's **inputs**, announced before
anything happens. It cannot tell you a capital fell, because when it fires the
capital has not fallen yet.

**What does exist is much stronger than a callback: the outcomes are already in
hashed state.** `bump` and `raise` write into `empire.stats` and
`member.stats` (`stats.ts:10-28`), and the file opens by saying why that is the
design:

> Stats live inside hashed state, so end-of-game figures are consensus by
> construction rather than something a client reports and a server must trust.

`STAT` has sixteen slots (`constants.ts:19-37`) and they are exactly the log's
vocabulary: `COINS_BRONZE/SILVER/GOLD`, `DIAMONDS`, `ANNEXED`, `CASCADE_TILES`,
`CASCADE_POP`, `TILES_TAKEN`, `BRIDGES`, `LADDERS`, `MARCHES`. `alive`,
`eliminatedAt`, `tilesOwned`, `popTotal`, `phase`, `winner` and `winReason` sit
beside them. All of it is in the snapshot (`state.ts:127-175`) and all of it is
in the hash.

So the world stream is a **diff of hashed counters between two steps**, and its
determinism is not a property anyone has to arrange — it falls out of the
one invariant. `summarise` (`stats.ts:58`) is the precedent, and its doc comment
is the argument in advance: "Derived entirely from hashed state, so any peer
computes the same awards."

```ts
/** Everything the journal reads, copied flat: ~16 u32 per empire and six
 *  scalars. Cheap enough to keep one per step; nothing here is a tile array. */
export interface Tally { … }
export function tally(state: State): Tally;
export function journal(before: Tally, after: State): WorldEvent[];
```

Take the tally *inside* `onApplied` — that is the last moment before the step
runs — and diff it against the state at the next `onApplied`. `onDirty` is no
use for this: it fires once per `pump`, after as many as 240 steps
(`MAX_STEPS_PER_PUMP`, `lockstep.ts:100`), so it cannot attribute anything to a
step.

Two things the counters cannot say, and both have clean answers:

- **Where.** A coin taken has no coordinates in `stats`. The log says "Vermilion
  took a gold coin", not which tile. Live with it; a coordinate would have to
  come from a sim-side emitter, and that is a hashed-state change for a
  sentence.
- **Upkeep.** No stat counts a sweep. But upkeep is a metronome —
  `scheduleUpkeep` pushes `from + rules.upkeepInterval` with no RNG draw
  (`mapgen.ts:246-250`) — so the queue's head is readable before the step runs
  and "this is an upkeep step" is a fact of state. The population the sweep cost
  is the `popTotal` delta on exactly those steps. Zero sim change.

## Three of the world events are not world events

The body lists "an equivocation proof" and "a seat dropped by quorum" as world
events, identical on every peer. Check them against the code and the line is in
a different place.

| Fact | Source | Same on every peer? |
|---|---|---|
| a seat was ejected, and at which step | `eject`, from a signed record at a fixed step (`lockstep.ts:1099-1117`) | **yes** |
| *why* it was ejected | `dropReason` — "Local, and deliberately not in the record: … the evidence that prompted it is whatever each peer happened to see, and a UI string is not worth a consensus field" (`lockstep.ts:245-249`) | **no** |
| `late` on the same callback | `this.sim.step > atStep` — how far this peer had got when it found out | **no** |
| an equivocation proof | `onViolation`, fired on frame arrival (`lockstep.ts:671-679`) | **no** — two peers receive different frames |
| a desync | `onDesync`, this peer's hash against a majority it can see | **no** |
| a seat arriving by amendment | `onSeated` / `onAmended`, at the step the amendment names | **yes** |

So `onEjection` delivers one shared fact and two local ones **on the same
callback**, and a log line reading "Dave was dropped for desyncing" is not
identical on any two screens. The byte-identical test in the body's verification
section would fail on `reason`, and it would be right to.

This is why the deriver cannot live entirely in `packages/sim`: the shared half
of the ejection is a net fact. `packages/net/src/worldlog.ts` composes
`journal()` with the four net hooks whose *shared* half is deterministic, and
drops `reason`, `late`, `onViolation` and `onDesync` into the session stream
where they belong. The equivocation proof still gets a line — it is worth
seeing — it just gets it in the local register, which is the register this plan
invented for exactly this.

## A peer that was away cannot derive what it missed

This is the sentence the whole log exists for:

> A ten-day game where you sleep for eight hours currently resumes with a
> different map and no account of how it got that way.

A resumed peer will still have no account of how it got that way, and no amount
of UI fixes it. `Lockstep.start`:

```ts
const behind = this.targetStep() - this.sim.step;
if (behind > RESUME_BEHIND) {
  this.holdingForResume = true;
  …
```

(`lockstep.ts:361-366`), with the reason spelled out above it: "the moves that
built it were broadcast before we were listening: nobody will send them again,
so replaying from step 0 would derive a state that agrees with nobody." The peer
adopts a snapshot and **never simulates the intervening steps**, so there are no
diffs to take. `adopt` restores every stat from the snapshot (`state.ts:234`,
`:245`), which means a naive differ would greet the returning player with one
enormous fabricated line: *Vermilion annexed 1,412 tiles.* The tally must be
reset on adopt, not diffed across it.

What the returning peer can honestly show:

- **A tab that stayed open gets everything.** It fast-forwards through every
  step at up to 240 per pump, so the events are derived — in a burst, which is
  the load case the cap is for.
- **A tab that reloaded gets a marker and a number**, not a story: "you were
  away for 8h 12m; the map changed hands 400 times" is derivable from the
  adopted state against the last tally this browser stored.
- **Anything better has to come from a peer that was present**, or from the
  archive — and neither is in this plan. Say so in the body rather than
  promising a scrollback the design cannot produce.

## "Identically on every peer" is not what the proposal screen does

> The proposal screen renders identically from the same proposal on every peer
> (a snapshot test over the two DOM trees).

It must not. The same section asks for "3 of 4 signed" **and one button that
signs it** — a button whose state is whether *this* key has signed. Add the
"(you)" marker `LobbyPanel.seatRow` already writes (`LobbyPanel.ts:250`) and
0010's Claim button, live "only while we hold no seat", and at least three
things on the screen are per-peer by design.

The invariant worth testing is narrower and actually true: **the part derived
from the proposal is identical; the chrome around it is not.** So the render
splits in two, and the split is also what makes it testable:

```ts
export function proposalBody(proposal: Proposal): string;      // pure, tested
export function proposalChrome(proposal: Proposal, me: MemberKey): string;
```

`LobbyPanel` already builds its markup as a string and assigns it in one place
(`body()` at `:155`, assigned at `:151`), so this is the shape the file is
already in.

## Signing is not agreeing, and a revision unseats everybody

The body's fourth item reads as though a revision costs the reviser something:

> Editing any field posts a new revision, which shows the count reset to 1: the
> cost of a change is visible to whoever is making it.

Follow 0009. The room peer "seals at the start time with whoever signed by then"
and an excluded peer "fails the lobby with its own problem rather than
observing" (0009, verification). So a consent is not an opinion about the world,
it is **the thing that puts you in it** — and a revision does not cost the
reviser a signature, it costs everyone else their seat until they sign again.

Two consequences the screen has to carry, because nothing else will:

- The button is not "Agree". It is nearer "Play this game", and the row for an
  unsigned player is not a dissenter — it is somebody who is currently not in
  the game.
- **A revision posted shortly before `startedAt` drops every player who does not
  see it in time**, and on a screen where any player may revise, that is a
  weapon. The countdown 0009's step 10 asks for is the mitigation, and it has to
  be on the same screen as the edit controls, reading against `startedAt` rather
  than against a local stopwatch.

## Ten things the body assumes that the code does not do

1. **`RosterView` is two lists, not "two small lists beside the seat display".**
   See the lead finding: `[data-roster]` (`Controls.ts:171`) and `RosterView`
   (`LobbyPanel.ts:30`) are unrelated, and only the first one is on screen.
2. **There is no fan-out.** Every `Lockstep` hook is one optional field
   (`lockstep.ts:189-227`). Four owners, six hooks, and the log wants four that
   are taken.
3. **`Tabs` gives a panel a tab for free — but only a real one.** It looks for
   `[data-acc]` with a `<summary>`, skips anything inside `[hidden]`
   (`Tabs.ts:66-69`), and labels the tab from the summary's text. Two panels
   means two `<details class="acc" data-acc>`, or no tabs.
4. **There is no clock that can render a ten-day game.** `stamp`
   (`Chat.ts:37`) is module-private and formats `mm:ss` with an unbounded minute
   field — ten days reads `14400:00`. `Controls.clock` (`Controls.ts:16`) does
   `h:mm:ss` and has no days either. This is the plan that needs days; export
   one and use it in all three places.
5. **The chat cap is a per-line forced layout.** `append` reads
   `this.log.scrollHeight` before every insertion to decide whether the reader
   is pinned (`Chat.ts:238-240`). One line at a time that is free; 240 lines out
   of one pump is 240 layouts. The log batches a pump's worth and reads once.
6. **`setRoster` is the cheap half of the right idea.** It stringifies the whole
   view every 200 ms (`LobbyPanel.ts:143`) — which is fine — and then
   `render()` replaces `innerHTML` for the *entire* panel (`LobbyPanel.ts:151`),
   which is what actually cancels the click. A panel that is only ever redrawn
   when its own data changed does not need the guard.
7. **There is no duration control, and 0002 puts one somewhere else.** 0002's
   implementation places `<select data-cfg="length">` in `index.html` beside
   `#cfg-size` and reads it at start, copying `MAP_SIZES`/`mapSize()`
   (`main.ts:71-80`). 0014 wants the same control inside the proposal sheet,
   where any player may revise it and a revision is a consent-resetting event.
   One control, two homes; 0014 owns the sheet and 0002 should stop at the solo
   card.
8. **`Lobby` does not expose peers arriving or leaving.** `onJoin` and `onLeave`
   are consumed inside `Lobby.open` and collapsed into `onChange`
   (`lobby.ts:135-139`). "A peer connected" — the first session event the body
   names — has no source.
9. **Nor does anything expose snapshots.** `onSnapshotRequest` and `onSnapshot`
   are private (`lockstep.ts:1136`, `:1150`) and `resuming()` (`:372`) has no
   hook at all. Three of the four named session events have no source; the
   fourth (`onHalt`) is taken by `OnlineGame`.
10. **`rosterView` reads the lobby, not the mesh.** `lobby?.players() ?? []`
    (`main.ts:455`) — so the Watching list is empty for any peer whose `Lobby`
    has gone, which is every peer that resumed into a game rather than starting
    in one. The roster screen needs the mesh's view of who is present, and that
    is `transport.peers()` crossed with the roster.

## Where the panels go, and the two they must not fight

The left column is `overflow-y: auto` with no flexing child (`main.scss:462-471`),
so panels there take their natural height and the column scrolls. The right
column has exactly one child and it is greedy:

```scss
.acc-chat {
  flex: 1;
  min-height: 0;
```

(`main.scss:522-524`), and the whole column is dropped in a solo game by
`.app[data-chat="off"]` (`main.scss:43`, `main.ts:148`).

So: **roster and log both go in the left column**, beside Map, Standings and
Your seats. Putting the log on the right would make it flex against chat for the
same space and vanish in solo play — and the log is the one panel that is worth
having in a solo game, because a SimBot annexing your capital at 3am is exactly
the thing nothing currently tells you.

Two constraints from the panels already there:

- **Do not write `hidden` unless it changed.** `Controls.render` guards its one
  write for this reason (`Controls.ts:170`): `Tabs` watches the whole app subtree
  with `attributeFilter: ["hidden"]` (`Tabs.ts:55-59`), and writing the same
  value still counts as a mutation.
- **The roster panel is hidden in a solo game, not empty.** An empty panel with
  a tab on a phone is a tab that costs a row of height to say nothing.

## The redraw constraint is already violated, five times a second

> `LobbyPanel` keeps a `drawn` string for exactly this reason: "redrawing an
> unchanged list would cancel the click the player is in the middle of making."

Correct, and the panel that does it is not the one doing the damage.
`Controls.render` runs from the same 200 ms block as `setRoster`
(`main.ts:387-400`) and rewrites three subtrees unconditionally on every call:
`hud.innerHTML` (`Controls.ts:99`), `acts.innerHTML` (`Controls.ts:124`) and
`standings.innerHTML` (`Controls.ts:199`). No guard, no diff.

The standings hold no buttons, so nobody noticed. **`[data-acts]` is the shop**,
and its tiles are `<button data-buy>` (`Controls.ts:46`). Replace a button
between `pointerdown` and `pointerup` and the browser fires `click` on the
nearest surviving ancestor — `.acts` — where the handler's
`closest("[data-buy]")` finds nothing and the purchase is silently dropped
(`Controls.ts:68-69`). At 200 ms and a typical press, a meaningful fraction of
every purchase in the game is being thrown away right now.

That is this plan's business twice over: it is the measured version of the
constraint the body states, and the roster screen puts a second set of buttons
in the same render loop. Both get the `drawn` treatment — a cheap key per
subtree, compared before writing — and the shop click becomes the measurement
in the verification table rather than an assumption.

## Testing a screen in a package with no DOM

`apps/web`'s node project has no DOM environment: `vitest.shared.ts` sets none,
`apps/web/vitest.config.ts` adds none, there is no `jsdom` or `happy-dom` in any
manifest, and the one existing test stubs the DOM by hand —

> Controls only needs somewhere to hang a listener and somewhere to write
> markup; the DOM itself is not what is under test here.

(`apps/web/src/test/input.test.ts:21-25`.) The browser project exists, but it
runs one file across Chromium, Firefox and WebKit, and a panel snapshot does not
need three engines.

So **do not snapshot a DOM tree.** `proposalBody` returns a string; compare
strings, in the node project, for nothing. The same goes for the log: `WorldLog`
produces `WorldEvent[]`, and the byte-identical test belongs in
`packages/net/src/test/worldlog.test.ts` against the harness, where `Peer`
already collects `chat`, `desyncs`, `ejections` and `violations`
(`harness.ts:41-55`) and adding a `world` array is one line. That is also the
argument for the deriver living in `net` rather than in `apps/web`: **a test
that proves two peers agree cannot be written in a package that cannot hold two
peers.**

## Order of work

| # | Step | Half | Green? |
|---|---|---|---|
| 1 | `archive.attach(driver)` moves to the end of `lobby.onStart`; a test in `apps/web` that a chat line reaches the archive through the client's own wiring. **Fixes a live bug and nothing else.** | fix | yes |
| 2 | `tap.ts`, and every `Lockstep` hook in `apps/web` goes through it. `OnlineGame`'s three stop being exclusive. | fix | yes |
| 3 | `Controls`: a `drawn` key per subtree. The dropped-purchase measurement is the test. | fix | yes |
| 4 | `stamp` exported from one place, with days; `Chat` and `Controls` both use it. | fix | yes |
| 5 | `journal.ts`: `Tally`, `tally`, `journal`, and the upkeep metronome. No callers. | log | yes |
| 6 | `worldlog.ts`: compose the journal with `onSeated`/`onAmended`/`onEjection`'s shared half. The harness test is the point of the step. | log | yes |
| 7 | `LogPanel` + the `<details>` + styles. Two registers, the cap, the filter, the divider, and the tally reset on adopt. | log | yes |
| 8 | `RosterPanel`: `rosterBody` moves out of `LobbyPanel` into the left column, unchanged in content. **The endorse button becomes reachable.** | roster | yes |
| 9 | The Watching list reads the mesh rather than the lobby. | roster | yes |
| 10 | *After 0011, 0010, 0012:* applications with tallies, vacancies with Claim, names on every row. Three lists, one panel. | roster | — |
| 11 | *After 0009:* `Proposal.ts` — `proposalBody` pure and tested, chrome around it, the countdown against `startedAt`. `LobbyPanel` keeps host/join/failed. | proposal | — |
| 12 | *After 0002, 0013:* the duration control moves into the sheet; banners replace theme names in the empire rows. | proposal | — |

Steps 1–9 depend on **nothing in 0009–0013** and are most of the value: the
archive stops losing chat, the shop stops losing clicks, the endorsement button
becomes reachable, and a solo player finds out why their capital changed hands.
The index's "0009–0013" dependency line describes steps 10–12 only, and the row
should say so.

Step 6 before step 7 is the ordering that matters: the stream is proved
identical between two peers before anything draws it, so a disagreement is
about the diff and not about a `<div>`.

## Docs

| File | What changes |
|---|---|
| `docs/clients/web-client.md` | the panels, where each lives, and which column; the two registers of the log |
| `docs/mesh/the-lobby.md` | the proposal sheet — with 0009, which rewrites this file anyway |
| `docs/continuity/resume.md` | what a resumed peer can and cannot be told about the gap |
| `docs/continuity/ejection.md` | the shared half of an ejection and the local half, and why only one is logged as a world fact |
| `docs/simulation/events-not-ticks.md` | `EventQueue` schedules; the reader's event stream is a diff of hashed counters |
| `docs/continuity/what-is-hashed.md` | stats are hashed state, which is what makes the world log agree without arranging anything |
| `docs/clients/observer.md` | the headless peer can print the same stream, and should |

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| **a chat line sent through the client's own wiring reaches the archive** | `apps/web/src/test/archive-wiring.test.ts` — fails today |
| **a purchase clicked across a render boundary is not dropped** | `apps/web/src/test/input.test.ts`, extended: render between down and up |
| two harness peers playing one recorded game produce byte-identical world streams | `packages/net/src/test/worldlog.test.ts` |
| the session streams differ, and that is asserted rather than tolerated | the same file — peer counts, snapshot requests, desyncs |
| **an ejection's `seat` and `atStep` are in the world stream and its `reason` is not** | the same file: eject one seat for desync on one peer and for a stall on another; streams still match |
| adopting a snapshot emits no world events at all | the same file — the tally resets, and the 1,412-tile line never appears |
| an upkeep sweep is logged on the steps the metronome names | `packages/sim/src/test/journal.test.ts` |
| a coin, an annexation, an elimination and a game ending each produce exactly one line | the same file |
| `journal` over two identical tallies is empty | the same file — the guard against a log that narrates every step |
| `proposalBody` is identical for two peers holding one proposal | `apps/web/src/test/proposal.test.ts`, string equality, no DOM |
| the chrome differs, and the test says which fields are allowed to | the same file |
| a ten-day stamp renders as days rather than `14400:00` | `apps/web/src/test/stamp.test.ts` |
| the log holds at its cap through a 240-step pump and reads `scrollHeight` once | `LogPanel`, measured — the constraint stated as a number |
| **claiming a vacancy and endorsing an application both work from the roster screen** | the harness, end to end — and step 8 is when "reachable" first becomes true |
| no existing test in `packages/sim` or `packages/net` changes | the diff. New files are added; not one line of the recorded-game suite moves |

## What came out differently

Written after building it. The appendix's two lead findings were both right and
both live bugs — the roster UI was painted into a hidden element for the whole
duration of every game, and `archive.attach` was clobbered three lines later so
every archive this client wrote carried an empty chat log. It was also right
that the world stream is a diff of hashed counters rather than anything a
callback produces. Five things it did not have.

**The journal's vocabulary was missing the commonest event.** The body lists "an
annexation" first and the appendix takes the list at face value — but `ANNEXED`
is bumped only when an empire *inherits* a fallen one's ground. Ordinary
captures bump `TILES_TAKEN`, and nothing in the plan's vocabulary reads it. The
first run of the two-peer test agreed perfectly on an **empty** stream, which is
the most convincing way to discover that a log says nothing. `took` is now the
first kind, and it is also the reason the panel needs a cap and a filter rather
than a scrollback.

**`onDirty` cannot even be the flush it looks like.** The appendix rules it out
as a shutter, correctly, because it fires once per pump after as many as 240
steps. What it does not say is that the same fact breaks the *adoption guard*: a
differ armed on `onApplied` and fired on `onDirty` sees a step delta of up to
240 on every ordinary pump, which is indistinguishable from a snapshot being
adopted. So the diff-and-retally happens entirely inside `onApplied` — which
makes it idempotent, which is what lets `onDirty` be chained harmlessly as a
tail flush so the last step of a game is not left unjournaled.

**Steps 10–12 were not blocked.** The order of work marks them "after 0011,
0010, 0012" and "after 0009" — all of which had landed by the time this plan was
built, so applications, vacancies, names, banners and the proposal sheet all
shipped here rather than waiting.

**The proposal sheet's split is what made it testable, and the plan's own
verification asked for the wrong test.** "Renders identically on every peer" is
a property this screen cannot have: the same section asks for a button whose
state is whether *this* key has signed. `proposalBody` / `proposalChrome` is the
appendix's shape and it is right; the tests then assert the narrower true thing
— the derived half is byte-identical, the chrome differs, and the test names
which fields are allowed to.

**`escape` and `stamp` both had to leave the files that owned them.** Three
panels now build markup from strings a stranger chose and two render game time;
the appendix asks for the second and not the first. Neither is interesting, and
both are the kind of thing that is a duplicated four-character replace until
somebody adds a fifth panel with a subtly different one.

One thing deliberately not done: the appendix's step 3 asks for the shop fix and
its measurement, and the measurement only means anything in a real engine —
`getComputedStyle` and a live `click` after a node swap have no equivalent in
the hand-stubbed DOM the existing Controls test uses. It is a `*.browser.test.ts`
for that reason, and it fails without the guard, which was checked rather than
assumed.

## What this plan does not settle

- **Where the account of the missing hours comes from.** The log cannot derive
  it, and the two things that could — a peer that was present, or the archive —
  are each a plan. This one should say plainly that a reloaded tab gets a marker
  and a number.
- **Whether the observer prints the world stream.** It is the peer that is
  always present, it already has `summarise`, and `worldlog.ts` would give it
  the commentary for free. Out of scope; obvious next.
- **Whether `onApplied` firing before the step is the right shape.** It is
  correct for an archive and wrong for a reader, and the journal works around it
  by tallying on the way in. If a third consumer wants the other side, the hook
  should be split rather than worked around twice.
- **Who owns the duration control.** 0002 puts it on the setup screen and this
  plan puts it in the sheet. Both are right for their phase; one of the two has
  to write down that there are two.
- **The terminal.** Still a stretch, and the note in the body stands: the DSL
  should choose its own words rather than mirroring `MOVE`, whose eleven entries
  (`types.ts:31-45`) include `HEARTBEAT` and `ROSTER_AMEND` and are not a
  vocabulary anybody would say out loud.
