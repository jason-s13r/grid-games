# 0008 — The web client: join, create, watch

Status: steps 1–6 built (2026-09-15); 7–11 draft
Depends on: 0002, 0003, 0007 (uses them all)
Branch: `web-directory-ui`

## The problem

Everything the series builds is headless-shaped; this plan puts it in front of
a player. Three screens change; no game logic and no new transport code.

## Join

The join box takes **any `ConnectionRef`** (0003): `wss://foo.example/tessera/<room>`
or a bare `tsr-…` code. One input, transport chosen by the string — no
transport picker, no probe, no fallback UI to design.

**Games screen** — a third card beside Host and Join, backed by the address
book (0007):

- rows carry: duration, time left, seats, whether the join window is open
  (derived from the record, per 0002), how many refs are live;
- a directory URL lives in settings (default public board, self-hostable);
- a row with no live refs offers rejoin-from-resume-point instead of a dead
  dial — the 0007 `rejoin` flow with its verification badges
  ("endorsed by 3 of 4 seats").

## Create

The host panel gains a **duration control** (0002): a list of common lengths
plus a free-entry field, feeding a step count through `durationRules()` into
`HostPlan.rules`. One control, because the three rules must scale together
(the abandon trap) — and a step count rather than a preset, because there is
no reason a host cannot ask for 45 minutes.

The rest of that screen — the shared draft, vacancies, custom opponents, the
ready count — belongs to **0014**, which rebuilds the lobby around 0009's
draft. This plan owns the *directory* half: how a game is found and how a
created game is announced. Behind the button, three create backends, one
artifact:

1. **This tab** — today's model, unchanged, always available.
2. **My own host peer** — paste the host's ref; the tab composes the plan
   (or the host runs `--auto`) and the host keeps the door.
3. **Managed** — a service that spins host instances up on demand and hands
   back connection params. It is a **factory only**: present at creation,
   absent mid-game. The listing it produces is the same row every other
   announcer posts.

Whichever backend, the client `announce()`s the sealed game to the address
book once genesis exists.

## In game

- Presence heartbeat to the board on a timer; withdraw on leave.
- **Show which transport is in use** ("direct" vs "relayed") — 0003's ref is
  already in the lobby; one status line, worth knowing.
- The host peer appears in the seat list as what it is: an observer peer.
  No new UI concept — "watching" already exists.
- The roster and log screens are 0014's; this plan adds nothing in-game
  beyond the presence heartbeat and the transport line.

## Watch, replay, stats

- **Watch**: joining a game as an observer already works via the seatless
  path; the games screen just makes it reachable.
- **Replay**: `verifyArchive` client-side, then a scrubber over a `Sim`
  driven by the archive's log — `Renderer`/`MapImage` unchanged.
- **Leaderboard**: `rankArchives` over the board's archive index, refusals
  shown beside the table the way `tessera-observe rank` already prints them.

## Verification

- Join box accepts both ref shapes and rejects garbage with the parse error
  inline.
- Host a 3h game with a 1h join window from the tab; the duration lands in
  the record (`inspectGenesis` output shows it); the countdown and join
  window render from the record, not the board.
- Close the host tab; a second browser keeps playing; a third rejoins from
  the resume point with the host gone (0005/0007 flows, end to end).
- Replay scrubber drives the recorded fixture to the same hash as
  `pnpm replay --log`.
- The recorded-game suite still passes — UI-only changes never touch the
  driver, and the suite is the tripwire that proves it.
---

# Implementing it

## What ships, and the four sentences in the body the code does not support

| File | What it is |
|---|---|
| `apps/web/src/net/settings.ts` | the board URL and the factory URL, in the cupboard the identity already uses — **and both halves of the mixed-content rule** |
| `apps/web/src/view/Games.ts` | the third section: rows from the board, and what each row offers |
| ~~`apps/web/src/view/Duration.ts`~~ | **not built.** 0002 shipped the control in `main.ts`; the free-entry field was declined |
| `packages/net/src/lobby.ts` | **`revive()`** — play a record you did not compose, which nothing could do before |
| `apps/web/src/net/announce.ts` | the tab as a door: announce, heartbeat, withdraw, and the cases where it is none of those |
| `apps/web/src/replay/engine.ts` | a worker that owns a `Sim` and a ladder of snapshots |
| `apps/web/src/view/Replay.ts` | the scrubber, which is a `Renderer` and a range input |
| `apps/web/src/main.ts` | `expect` on a row-join, the duration on the plan, the transport line |
| `apps/web/src/view/Controls.ts` | the clock, which today counts the wrong way |
| `apps/web/index.html`, `styles/main.scss` | one more card in a single column — see below; the two-column grid is gone |
| `apps/web/vitest.config.ts` | a third project, `ui`, for views whose output is markup |

Four things the body asserts that nothing in the tree can do yet, each with a
section below:

- **"Presence heartbeat to the board on a timer; withdraw on leave."** A tab
  is a door over `rtc` and is never a door over `socket`, so for two of the
  three create backends this heartbeat would advertise somebody else's door
  and then remove it on close. 0007 already says as much about `resolve`'s
  step 4; the in-game section here has not caught up.
- **"`rankArchives` over the board's archive index."** There is no archive
  index. 0007's row carries `refs` and `resume` and nothing else, and its TTL
  removes a game shortly after the last door closes — which is exactly when a
  finished game becomes rankable.
- **"a scrubber over a `Sim` driven by the archive's log."** A three-day game
  is 3,110,400 steps (`constants.ts:39`: twelve a second). `sim.fastForward`
  (`sim.ts:217`) is a `while` loop, so a scrub backwards on the main thread is
  a page that stops answering for minutes.
- **"feeding a step count through `durationRules()` into `HostPlan.rules`."**
  0002 removed `HostPlan.rules` on purpose — it was the hole that let a
  composed genesis carry `abandonWindow: 12` — and the field the control feeds
  is `HostPlan.duration: DurationRules`. One word, and it is the word the
  previous plan spent a section on.

Everything else in the body survives contact with the code.

## What had already changed by the time this was built

The appendix above audits the body against the tree as it stood when 0007 was
still draft. Six of its claims went stale between then and building it, and the
sections below have been corrected in place; they are collected here because the
pattern is the point — **an appendix is only as current as the plan that landed
last**, and 0010 and 0014 both read this one.

- **The duration control already exists.** 0002 shipped `COMMON_DURATIONS`, the
  filled `<select>` and `duration()` feeding `HostPlan.duration` — the right
  field, so the warning below was answered before it was read. Only the
  free-entry minutes field was ever outstanding, and it was **declined**: the
  picker runs 15 minutes to 10 days, and the argument in `main.ts` against
  open-ended entry is most of the argument against a custom box beside it.
- **The menu screen is one column, not two.** 0001's "one setup, one button"
  replaced the Host and Join cards with a single `.card.setup` driven by
  `view/Setup.ts`, inside a 720px `.screen-inner`. There is no `1fr 1fr` grid
  left to avoid becoming a third of; `.card-wide` was never needed. The
  *reasoning* in that section survives untouched and is why `Games` owns its own
  root.
- **There is no default board.** The body says "default public board". 0007 as
  built says the opposite and `docs/mesh/address-book.md` states it outright: no
  board ships with this client and no URL is assumed. Empty is the normal state,
  and the card says so in a sentence rather than showing a broken fetch.
- **Announcing is signed.** `announce(identity, listing)`,
  `present(identity, listing)` and `withdraw(identity, gameId, refs)` all take an
  identity and sign the write; `verifyWrite` is exported for board authors. The
  body's "the board takes a POST from anyone" and the `announce.ts` sketch below
  both predate it. `doorOf` is unaffected.
- **Backend 2's guard is one string comparison.** `GET /room/:code` answers
  `gameId: ""` before a game is sealed, so the check is against the empty string
  and not an absent field. "No other peer has announced a draft" has no signal in
  the tree at all — that is 0009's — so the race is wider than the section below
  admits.
- **Every `file:line` citation had moved.** They are corrected inline. The
  standing instruction from 0007 applies to this plan too: re-check them before
  trusting one.

And three things building it turned up that no reading would have:

- **`Lobby` could not adopt a record it had not composed.** `host()` composes and
  seals; `adopt()` is private; there was no public path from "a verified resume
  point for a game that exists" to "a lobby playing it". So the rejoin branch is
  not UI work alone, and `Lobby.revive(genesis)` was added — four lines, through
  the same `adopt` every joiner uses, granting nothing.
- **A revived game's archive marks itself a fragment, for free.**
  `Archive.attach` wires `driver.onAdopted` to `gap()`, so resuming before
  `start()` records the jump and `toJSON` carries `from`. The honest behaviour
  was already built; it just had to be ordered correctly.
- **The browser project earns its place for markup, not for enforcement.** The
  verification table below wants the mixed-content refusals tested "in the engine
  that actually enforces them". Nothing is: these are *our* checks, run before the
  browser would block anything, and they are pure functions best pinned under
  Node. What only a browser can answer is whether a view's concatenated strings
  parse into the DOM they were written for — so that is what `*.browser.test.ts`
  holds, on chromium alone.

## Three limits a browser has that the rest of the series never had to have

This is the first plan whose artifact runs inside an origin, and the origin has
opinions. All three of these are the client's to hold, because no other peer in
the series is subject to them.

**Mixed content.** The client is served over `https` (`pnpm site` publishes to
Pages). A page on `https` cannot open a `ws://` socket and cannot `fetch` an
`http://` board: the browser blocks both before a byte leaves, and the failure
arrives as a `TypeError` with no useful message. 0003 accepts `ws://` and 0006
keeps it legal on purpose — LAN, Tailscale, a host bound to `127.0.0.1` — so
the ref is right and the *page* is the thing that cannot use it. So `parseRef`
is not where this belongs. The join box catches it after parsing:

```ts
// A ws:// ref is a valid ref and is not one this page can open. Said here
// rather than in parseRef, because the ref is fine everywhere else: a headless
// peer on the same LAN joins it happily, and so does this same client served
// from http://localhost during `pnpm dev`.
if (ref.kind === "socket" && new URL(ref.url).protocol === "ws:" && location.protocol === "https:") {
  return `this page is served over https, so it can only open wss:// rooms. ` +
    `A headless peer (pnpm --filter @tessera/observer …) can join ws:// directly.`;
}
```

The same check gates the board URL in settings, with the same reason and a
different sentence.

**CORS.** 0006 already puts `Access-Control-Allow-Origin: *` on its three GETs
for this client's benefit. The board needs the same on `GET` and on the `POST`
that `announce`/`present` use, and a board that does not send it is
indistinguishable from a board that is down — the response never reaches the
page. `Directory` cannot tell those apart either, so the games card says "could
not read that board" and shows the URL it tried, rather than "no games".

**A tab is not a process.** `withdraw` on leave is `beforeunload`, which does
not fire on a phone that was swiped away, on a crashed tab, or on a laptop lid.
`fetch(..., { keepalive: true })` makes it likely and never certain. So the TTL
is the mechanism and `withdraw` is the courtesy: `expiresAt` is set to a little
over two heartbeat intervals, and the row disappearing within a minute of the
tab closing is a property of the board, not of the unload handler.

## The third card is not a third column

**Corrected: there is no second column any more.** When this was written
`index.html` held a two-column grid whose two cells were a solo setup and the
lobby, and the section below argued against making it three. 0001's
"one setup, one button" removed that grid: the menu is now a single
`.screen-inner` at 720px holding one `.card.setup`, and `view/Setup.ts` drives
the whole flow inside it. So `.card-wide` and `grid-column: 1 / -1` are
unnecessary and were not added. The directory is simply another `.card`, above
the one that starts a game, because finding a game is the first question now
that there is somewhere to find one:

```html
<section class="card games" data-games></section>
```

Its empty state is a sentence rather than an absence — with no board configured,
which is the default, it says so and points at Settings. A card that vanished
would be a feature nobody discovers.

The half of the original argument that still stands, and is the reason the card
is where it is:

It is a sibling of the lobby panel, not a child of it. `LobbyPanel.render`
(`LobbyPanel.ts:167`) replaces its own `innerHTML` wholesale, and `main.ts`'s
frame loop calls `setStatus` on every render tick; a directory list inside that root would
have its rows rebuilt under the player's cursor several times a second, and its
`<input>` cleared with them. The panel is right to work that way — it has three
short phases and no text to preserve — and it is precisely why this does not
go in it. `Games` follows `Rivals` (`view/Rivals.ts`) instead: its own root,
its own listener, `render()` when its own data changes.

## Announcing publishes a game, so the tab has to ask first

Today "Start the game" tells the people already in the room. `announce()` tells
a server, and what it sends is the sealed genesis record — every member key in
the roster, which is every player's stable public identity. That is not a
detail of how the game is found; it is a change in what the button does.

So the create panel carries a checkbox, defaulted **off**, and the wording says
what is sent rather than what the feature is called:

```html
<label class="field">
  <input type="checkbox" data-cfg="list" />
  List this game publicly — posts the room code and the sealed record
  (including every player's key) to <span data-cfg="board-host"></span>.
</label>
```

Unchecked is the client Tessera has today: a code you send to people yourself.
Checked is the address book. Nothing about the game differs between them —
which is the point, and is why this is a checkbox rather than a mode.

A host peer (0006) announcing is a different question and is already answered
in that plan: a process started with `--plan` was started in order to be found.

## Which door a tab may announce, and which one it may withdraw

Rows are keyed by `(gameId, ref)` — 0007 settled that so two announcers do not
delete each other's doors. The consequence for this client is a rule with three
cases, and only the first has a door in it:

| Backend | The door | What the tab announces | What it withdraws |
|---|---|---|---|
| This tab | itself, over `rtc` | `{gameId, genesis, refs: [formatRef(lobby.ref)]}` | that row, on leave |
| My own host peer | the host process | nothing — 0006 announces its own room | nothing |
| Managed | the instance the factory made | nothing — same reason | nothing |

`announce.ts` is therefore about forty lines and one guard. **Corrected:** every
write is signed now — `announce(identity, listing)`, `present(identity, listing)`
and `withdraw(identity, gameId, refs)` — because a board that cannot tell a
heartbeat from a hijack lets anyone clear it. That is access control over rows
and says nothing about whether a row is true; `read()` never looks at the
signer. The guard below is unchanged by it:

```ts
/** A door, or nothing at all.
 *
 *  A tab hosting over WebRTC is genuinely dialable — its peer id *is* the
 *  room — so it announces and heartbeats like any other announcer. A tab that
 *  joined somebody's room bus is a guest in it: the door is the host peer's,
 *  it is already on the board, and re-posting it would put a row on a TTL that
 *  this tab happens to keep alive and takes down when it closes. */
export function doorOf(lobby: Lobby): ConnectionRef | undefined {
  return lobby.hosting && lobby.ref.kind === "rtc" ? lobby.ref : undefined;
}
```

Presence is `present()` on a timer while the tab holds a door, and the timer is
cleared in `leaveMesh` beside the rest of the teardown. It does
not run in a backgrounded tab — browsers clamp timers, and a phone in a pocket
may not run it for an hour — which is another way of saying the TTL is the
mechanism.

## Joining a row is not joining a string

Two things separate a row from the join box, and the current entry point can
express neither.

`begin(code?)` opened with `if (lobby) return;`. Clicking a
directory row while a lobby is open — which is the normal state of the menu
screen once you have hosted anything — does nothing at all, silently. The games
card is the first place a join can be *clicked* rather than typed, so this stops
being a theoretical dead end:

```ts
async function begin(input?: string | { ref: ConnectionRef; expect: string }): Promise<void> {
  // Leaving is the player's decision, so it is asked for rather than assumed:
  // a click on a game while already in one offers to leave the one you are in,
  // and the row stays where it is until they say so.
  if (lobby) return void panel.setStatus("Leave the game you are in first.");
```

And the row names a game, which the typed string does not. 0007 built `expect`
for exactly this: a ref from a board is a claim that *this* game is behind that
door, and arriving in a different one is the failure that looking a game up
introduces. So a row-join passes `expect: listing.gameId` to `Lobby.open`; a
typed ref passes nothing, because the person typing it was told what it was by
someone they know. `LobbyHandlers.join` keeps taking a
plain string — the panel stays free of network types — and the games card gets
its own handler that does not go through the panel at all.

**What this section missed.** `resolve`'s `resume` route ends at a verified point
for a game whose doors have all closed, and there was no way to sit down in it:
`Lobby.host` *composes* a record, `adopt` is private, and nothing public took a
genesis that already existed. So the rejoin branch is not UI work alone.
`Lobby.revive(genesis)` is the missing four lines — broadcast, then the same
`adopt` every joiner runs, with the same `inspectGenesis`, the same `expect`
comparison and the same seat lookup. It grants nothing: reviving a game you
invented gets you a room with you in it, which is what hosting already was. The
state that follows is `Lockstep.resume`'s to check, and it counts the witnesses
and hashes the bytes before it keeps anything.

Order matters once, and the tree already had it right: attach the `Archive`
*before* resuming, and `driver.onAdopted` fires `archive.gap()`, so the log this
tab keeps carries `from` and every reader refuses to replay it from the start.
A revived game's archive is a fragment, and says so without being asked.

`resolve()` (0007) is what turns a row into one of those: `dial` gives a ref to
open with `expect`, `resume` gives a verified point and a tally to render as
"endorsed by 3 of 4 seats" before the player commits to anything, `gone` gives
the problems to print. The card renders all three; it decides none of them.

## The duration control

**Corrected: 0002 built this, and the free-entry field was declined.**
`COMMON_DURATIONS`, the `<select>` filled from it, and `duration()` reading it at
start time are all in `main.ts` already, and they feed `HostPlan.duration` — the
right field, so the warning at the top of this appendix was answered before
anyone read it. Nine lengths from 15 minutes to 10 days ship today.

What was left was the custom-minutes box below, and it is not being added: the
comment beside `COMMON_DURATIONS` argues that a game's end date is what makes a
version's sunset derivable rather than a judgement call, and most of that
argument tells against a free-entry field beside the list too. A host who wants
45 minutes is one line in the table away, which is exactly what the table is for.

The sketch is kept because it is the shape any later custom field should take —
and because the `duration`/`rules` correction under it is the one part of this
section that was load-bearing and is still right.

`MAP_SIZES` / `mapSize()` is the pattern, as 0002 says: a
table beside the picker, read when the game starts rather than cached. The
free-entry field is the only part that is not a copy of it, and it is the part
worth writing down:

```ts
// A select of COMMON_DURATIONS plus "custom", and a number of minutes beside
// it. Minutes rather than steps: the step count is the protocol's unit and
// nobody hosting a game thinks in twelfths of a second.
const duration = (): DurationRules => {
  const choice = pick<HTMLSelectElement>('[data-cfg="length"]').value;
  if (choice !== "custom") return durationRules(Number(choice));
  const minutes = Number(pick<HTMLInputElement>('[data-cfg="length-custom"]').value);
  // NaN, blank and negative all mean "they have not finished typing", and the
  // start button is disabled until it parses rather than composing a game with
  // a length nobody asked for.
  return durationRules(Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * STEPS_PER_SECOND : 0);
};
```

and in `main.ts`, which today reads:

```ts
void lobby?.host({ empires: panel.seating.empires, simbots: rivals.list, ...mapSize(), duration: duration() });
```

`duration`, not `rules` — see above, and note it already says `duration`. One control feeding one field of three
numbers is the whole of what 0002 left for this plan to do, and the reason it
is one control is in that plan.

The solo card gets none of this, also per 0002: `joinWindow` and
`abandonWindow` are both about people who are not there.

## The clock counts the wrong way

`Controls.render` wrote `${clock(state.step)} · step ${state.step}` in both
branches, and `clock()` formats steps as elapsed time. In an open-ended game that is the only honest
reading. In a game with an `endStep` it is the wrong number on screen: a player
three hours into a three-hour game wants to know they have minutes left, and
what they are shown is "3:00:00" counting up.

```ts
// Remaining, when the record says there is an end; elapsed when it does not.
// Both are derived from the genesis rules and this peer's own step — never
// from a listing, which is a claim, and never from a clock, which is the
// thing the step number already is.
const end = state.genesis.rules.endStep ?? 0;
const label = end > 0 ? `${clock(end - state.step)} left` : clock(state.step);
```

The join window goes on the same line and only while it is open — `joinWindow`
steps in, then it stops being news:

```ts
const window = state.genesis.rules.joinWindow ?? 0;
const joining = window > 0 && state.step < window ? ` · seats open for ${clock(window - state.step)}` : "";
```

This is the sentence the body's verification is actually asking for ("the
countdown and join window render from the record, not the board"), and it is
four lines in the file that already owns the clock.

Built as `clockLine(state, online)`, exported so `clock.test.ts` can drive it at
a dozen step values without a DOM. Three details the sketch leaves out and the
implementation needs: the remaining time is floored at zero, because a peer can
be a step or two past `endStep` before the sim ends the game and "-0:02 left" is
not a thing to put on a screen; and the join window is read the way
`rosterView` already reads it — `protocol >= 4` first, since a v3 record predates
the field and a number that means nothing should not be counted down.

The third only showed up on screen. 0002 says the solo card gets no join window
because it is "about people who are not there" — but a solo game is composed by
the *shared* form and carries the same `DurationRules`, join window and all,
which is right and is what makes the two kinds of game the same world. The
consequence is that an unguarded clock line advertises "seats open for 1:59:59"
in a game nobody can join. Hence the `online` argument, which is about that one
line and nothing else.

## The transport line says something the client cannot know

The body asks for "direct" versus "relayed". The client cannot tell those
apart. What it holds is a `ConnectionRef`, and `Connection` (0003) is
deliberately four verbs, an id and a `close` — no `kind`, no route. The ref
distinguishes *peer-to-peer* from *a room bus*, and a WebRTC connection running
through TURN is peer-to-peer by the ref and relayed in fact, which is the one
case where the word would matter and the one case it would be wrong.

So the line names what is known:

```ts
const transportLine = (ref: ConnectionRef): string =>
  ref.kind === "rtc" ? "Connected peer to peer" : `Connected through ${new URL(ref.url).host}`;
```

The true answer is available — `RTCPeerConnection.getStats()`, the selected
candidate pair, `type: "relay"` — and it costs a poll and a reach through
PeerJS into a connection object it does not expose. It is not worth it for a
status line, and a status line that is wrong about TURN is worse than one that
never claimed to know.

## Backend 2, and who presses start

"Paste the host's ref; the tab composes the plan" works today, mechanically,
and the reason is worth stating because it is also the problem. `Lobby.host`
checks the plan and nothing about the phase: any peer in a room
may seal a genesis and broadcast it, and `adopt` accepts
whichever GENESIS frame arrives while `phase !== "playing"`.
Nothing makes a host special except being the only one with a button.

Give every tab in a host peer's room the button and two people pressing it seal
two different games; each peer plays whichever frame reached it first, and the
room splits with no error anywhere. That has never been reachable, and this
plan is where it becomes reachable.

0009 is the answer — a genesis composed together and co-signed, so there is no
"first frame wins" to lose to. Until it lands, this plan takes the narrow
version and says so:

- the tab that dialled a host peer may compose **only** while the room's
  `GET /room/:code` (0006) reports no game. **Corrected:** that endpoint answers
  `gameId: ""` before a record is sealed, so the check is against the empty
  string, not an absent field. And "no other peer has announced a draft" cannot
  be checked at all — there is no draft to announce until 0009 — so the guard is
  narrower than this bullet reads and the race correspondingly wider;
- `--auto` (0006) is the recommended shape for a shared host, because a host
  that seats joiners as they arrive has no button for anyone to race for;
- the race is not closed here. A disabled button is a UI convention, not a
  rule, and the rule arrives in 0009.

## Backend 3 is a seam, not a service

Nothing in the series builds a managed factory. 0006 describes one in a
paragraph and is careful to make it optional: spin up a host, hand back
connection params, get out of the way.

So what ships here is the shape of the request and no server to answer it:

```ts
// POST <factory>/rooms  { protocol, plan }  ->  { refs: string[], resume?: string }
//
// A factory is a convenience and never an authority: what comes back is a set
// of refs, which is the same thing a friend sends you in a message. The game
// it ends up hosting is composed by this tab and verified by every peer, so a
// factory that lies hands back a door into a room that will refuse us.
```

The URL lives in settings beside the board URL and is empty by default; the
third create option is hidden while it is empty rather than shown broken. When
the field is filled the tab POSTs, parses the refs it gets back, and joins them
exactly as if they had been typed — including `expect`, once genesis exists.

## Replay, and the two things that make it not a `for` loop

`verifyArchive` (`archive.ts:225`) client-side is right and is cheap enough:
signature checks over a few thousand moves, and a replay to the claimed hash.
The replay is the expensive half, and the scrubber is the expensive half twice.

Two problems, one answer:

- **Forwards is a loop; backwards is the whole game again.** `Sim` has no undo,
  by design — a step is a hash, not a diff. Scrubbing to step 900,000 and then
  to 899,000 replays 899,000 steps unless something was kept.
- **It cannot happen on the main thread.** Twelve steps a second means a
  1-hour game is 43,200 steps (fine), a 3-day game 3,110,400 (seconds to
  minutes), a 10-day game 10,368,000 (not a thing a page does). The page would
  simply stop answering, with no way to cancel.

So the engine is a worker that owns the `Sim` and a ladder of snapshots, and
the scrubber talks to it in one message each way:

```ts
// apps/web/src/replay/engine.ts — inside a Worker.
//
// One pass forward at full speed, keeping a snapshot every LADDER steps; after
// that a seek is `restore(nearest below)` plus at most LADDER advances, which
// is milliseconds. SnapshotStore already does the keeping (net/snapshots.ts)
// and already answers "the newest at or before this step" — it wants a longer
// tail than its default of eight, and nothing else.
const LADDER = 4096;                       // ~5.7 minutes of game per rung
const store = new SnapshotStore(512);      // ~48 hours of game at that spacing
```

Numbers, because they decide whether this is a feature or a wish: a snapshot is
about seven bytes per tile plus the empires, so 45,056 tiles (`large`) is
roughly 320KB, and 512 rungs is ~160MB — too much. At 96×72 it is ~48KB a rung
and 512 rungs is 25MB, which is fine. So the ladder is chosen from the map
size and the game length rather than fixed: `LADDER = max(4096, ceil(steps /
256))`, a fixed 256-rung budget, and a seek that costs at most `LADDER`
advances. A 10-day game on a large map lands at ~40,000 steps a rung — about
three seconds to seek, which is honest for a ten-day game and is the reason the
scrubber shows progress rather than pretending.

The first forward pass is the long one and it is the one the player waits
through, with a progress bar driven by the worker's step count and a cancel
that terminates it. `Renderer` and `MapImage` are untouched, as the body says:
the worker posts back a snapshot buffer, the page restores a `Sim` from it and
paints. A `ReplayDriver` implements `Driver` (`game/Driver.ts:12`) with
`tick()` returning an empty set and `act()` returning `false` — the scrubber
drives the step, not the clock — so `mount()` (`main.ts:125`) takes it exactly
as it takes the other two.

## The leaderboard has no index to read

`rankArchives` (`rankings.ts:112`) takes archives, and the board holds none.
0007's row is `{gameId, genesis, refs, resume?, witnesses?, …}` — the doors into
a live game — and its TTL removes the row shortly after the last door closes,
which is exactly the moment a game becomes rankable. "The board's archive index"
names something that does not exist, and adding it means changing 0007's row and
giving the board a second job (holding megabytes, indefinitely) that the plan
was written to refuse.

What is actually available: `GET /room/:code/archive` on any host peer (0006),
and whatever the player has downloaded with the Save log button
(`main.ts:340`).

So the leaderboard ships scoped, and says what it is scoped to:

- settings hold a list of host peers to read from, empty by default;
- the table is over the archives those serve plus any file the player drops
  onto the page — `verifyArchive` on each, `rankArchives` over the survivors;
- refusals are printed beside the table with the path or URL that produced
  them, the way `tessera-observe rank` already does
  (`apps/observer/src/main.ts:200`) — a leaderboard that silently drops what it
  could not verify is one nobody can audit, and that sentence is load-bearing
  in the observer for the same reason.

A public, cross-host leaderboard needs an index of finished games, and that is a
plan, not a paragraph in this one.

## Settings, and the cupboard they go in

Three strings: the board URL, the factory URL and the list of host peers to rank
from. **Corrected: all three default to empty.** The body's "default public
board" did not survive 0007, which ships no board and assumes no URL — a board
is a URL that arrives the way a room code used to, and shipping one would make
this client's author the operator of the place every game is announced to. Only
the board field is on screen so far: a field that configures a feature which does
not exist yet is a field that configures nothing. They go in
`localStorage` beside the identity (`net/identity.ts:13`), under
`tessera.settings`, as one JSON object read once at start:

```ts
// The same cupboard as the identity, and the same honest consequence: a
// private window is a different player with a different address book. Read
// once and written on change — nothing here is worth a reactive store, and a
// settings object that can change under a render is a bug waiting for a
// screenshot.
```

Each is validated on entry, not on use: a board URL that is not `https` on an
`https` page is refused in the field with the mixed-content sentence, rather
than failing later as an unreadable board.

Both halves of that rule live here, in `checkBoardUrl` and `checkRefForPage`,
because they are one rule in the client's only two shapes for it. Both take the
page protocol as an argument rather than reading `location`, which is what makes
the interesting case — an https page, an http board — testable in Node at all.

## Sizes, and what falls out of 1–2 sessions

The index says 1–2 sessions. The body describes five features, and the replay
scrubber alone is a worker, a snapshot ladder and a `Driver` implementation.
Honestly ordered, the first session is the one that makes the rest reachable:

1. **Session one** — settings, the games section, join-from-a-row with
   `expect`, the duration control, the countdown, the transport line. This is
   the plan's title: join, create, watch. Everything in it is small, and
   together it is the first build where a player finds a game without being
   sent a code.
2. **Session two** — announce/present/withdraw with the consent checkbox, and
   backend 2 with its narrow composition rule.
3. **Replay and the leaderboard are a third**, and would be better as their own
   plan: they share nothing with the directory but a screen, they are the only
   part of this that needs a worker, and the leaderboard is blocked on an index
   that does not exist. Watching a live game — which is the "watch" in the
   title — already works and is one row's button.

Splitting it that way is a recommendation, not a change to the series: the
numbering stays, and 0009–0014 depend on none of the three.

## Order of work

1. ✅ `settings.ts` and the settings fields in the menu footer. Nothing else can
   be tested against a board without a place to put its URL.
2. ✅ `Games.ts` rendering a fixed array of `GameListing`s — the view model first,
   with no fetch behind it, which is what makes it testable under Node.
3. ✅ Wire `Directory.list()` in behind it, with the CORS/unreachable sentence.
4. ✅ Row → `resolve()` → `begin({ref, expect})`; the `if (lobby)` dead end;
   the rejoin branch with its tally badge — and `Lobby.revive`, without which
   that branch has nowhere to land.
5. ✅ The countdown and the join window in `Controls`. (The duration control was
   already built, and the free-entry field was declined — see above.)
6. ✅ The transport line.
7. `announce.ts` + the consent checkbox + `doorOf`'s guard, and the withdraw in
   `leaveMesh`.
8. Backend 2: the composition guard against `GET /room/:code`.
9. Backend 3: the POST shape, hidden while the factory URL is empty.
10. Replay: worker, ladder, `ReplayDriver`, scrubber.
11. Leaderboard: scoped, with refusals.

Steps 1–6 leave the tree green and shippable on their own, which is the
property every plan in this series is written to keep — and did: 83 tests in
`apps/web`, 294 in `packages/net`, the full typecheck clean, the bundle built.
A player with a board URL can now find a game, read what is claimed about it and
what is proven, knock on its doors, and take up a dormant one from a point a
quorum of its seats signed for. Nothing yet lists a game *to* a board; that is
step 7.

## Docs

- `docs/clients/web-client.md` gains a third `Driver` row for `ReplayDriver`
  (the table at line 33 says "two implementations, and `Controls` / `main.ts`
  never learn which one they hold" — a third is the strongest evidence that
  boundary was worth having) and a section on the menu screen's three parts.
- `docs/mesh/the-lobby.md`: joining from a listing passes `expect`, and why.
- A new `docs/clients/finding-a-game.md`: the board, the consent, the three
  create backends, and the three browser limits above. It is the page to hand
  someone who asks "how do I play with a stranger", and there is currently no
  answer to that question anywhere in `docs/`.
- `README.md`'s quick start still says host-and-send-a-code, which stays true
  and is no longer the only way in.

## Verification, mapped to files

The web package tests run under Node with hand-built element stubs
(`src/test/input.test.ts:21`) and there is no jsdom in the tree. That works for
`Controls` because nothing reads its markup back. It cannot test a card whose
whole job is markup. Two answers, both already paid for:

- **Pure view models, tested under Node.** `Games.rows(listings, now)` returns
  `{title, length, timeLeft, seats, doors, action}` objects and `render()` turns
  them into strings. Every claim in the body about a row — a closed join window,
  a row with no live refs offering rejoin, a "3 days" label read back out of a
  step count — is an assertion about that array.
- **`apps/web/vitest.config.ts` already runs a real browser project** with
  Playwright, currently for exactly one file. A `*.browser.test.ts` glob in it,
  restricted to `chromium`, leaves the three-engine sweep to the determinism
  fixture it exists for.

  **Corrected: not for the reason given.** "The engine that actually enforces
  them" describes nothing here — the mixed-content refusals are *our* checks,
  run before the browser would block anything, and they are pure functions with
  the page protocol as an argument, so Node is both sufficient and better
  (`settings.test.ts`). What genuinely needs an engine is the thing no assertion
  about an array can see: these views build markup by concatenating strings, and
  a template a parser reads differently from how it was written yields a card
  that is quietly wrong. So the `ui` project asks parser questions — does the row
  count survive, does a clicked button hand back the game that was clicked, does
  a hostile game id stay inside its attribute — and that last one is the reason
  to keep it, because a board is allowed to lie and an id is a string it chose.

  One trap worth recording: the `node` project's `src/test/**/*.test.ts` glob
  matches `*.browser.test.ts` too, so it needs an explicit `exclude` or every
  browser test runs twice and fails once.

Mapped:

| Claim | Where |
|---|---|
| Join box accepts both ref shapes; garbage shows the parse error inline | `packages/net`'s `ref.test.ts` already pins the parse; the panel prints its message |
| `ws://` on an https page is refused with its own sentence, and accepted on http | `src/test/settings.test.ts` — `checkRefForPage` over both protocols, and `checkBoardUrl` for the board's half |
| A row's markup survives a real HTML parser, and a hostile game id stays in its attribute | `src/test/games.browser.test.ts` |
| A 3h game with a 1h join window lands in the record | `src/test/duration.test.ts` — `durationRules` → `host()` → `inspectGenesis` clean, `rules.endStep` read back |
| The countdown counts down; the join-window line disappears at `joinWindow` | `src/test/clock.test.ts`, over a real `Sim` state at nine step values |
| A row with no live refs offers rejoin, with the tally rendered | `src/test/games.test.ts` for the derivation, `games.browser.test.ts` for the tally on screen and the commit going to the resume handler |
| A row this build cannot play is shown as unplayable, not hidden | `src/test/games.test.ts` |
| A claim is never rendered as a fact | `src/test/games.test.ts` — `seatsUsed` reads "the board says", seat totals do not |
| The tab announces only the door it holds | `src/test/announce.test.ts` — `doorOf` over hosting/joined × rtc/socket |
| Replay reaches the same hash as `pnpm replay --log` | `src/test/replay.test.ts`, over `packages/sim/src/test/fixtures` — **and** a seek test that scrubs backwards and forwards and asserts the hash at each stop, which is the assertion the body's version is missing |
| The recorded-game suite still passes | unchanged; it is the tripwire, and this plan touches nothing it covers |

The scrub-backwards assertion is the one worth insisting on. "Replay reaches the
same hash" passes on a fixture of a few hundred steps with no ladder at all,
which is to say it would pass against an implementation that cannot do the thing
the feature is for.

## What this plan does not settle

- **Two tabs, one game, two doors.** 0007 named the fork: two peers resume the
  same dormant point and each announce. This client will show one game with two
  refs and dial whichever is first. Correct, and not the same as resolved.
- **Who may announce.** The board takes a POST from anyone, which is what makes
  it hostile and what the reader's verification is for. Rate limiting is the
  board's, and a board with none will fill with well-formed fiction that only
  the witnesses (0007) distinguish from games.
- **The composition race in backend 2**, closed by 0009 and not here.
- **An index of finished games**, without which the leaderboard is scoped to
  hosts the player names.
- **Whether the games section belongs on the menu screen at all** once 0014
  rebuilds the lobby around a shared draft. This plan puts it beside the two
  cards because that is where the screen is today; 0014 owns what that screen
  becomes.
