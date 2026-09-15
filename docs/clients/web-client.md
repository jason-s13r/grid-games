# The web client

[`apps/web`](../../apps/web) is the browser client. It **renders and takes input.
It decides nothing about the game.** Camera, DOM and zoom are never in the
simulation, never [hashed](../continuity/what-is-hashed.md), never sent — two
peers looking at different corners are in perfect consensus.

Run it: `pnpm dev` → `http://localhost:1234` (Parcel).

## The Driver boundary

[`Driver`](../../apps/web/src/game/Driver.ts) is what the view needs from a game,
whichever kind it is:

```ts
interface Driver {
  readonly sim: Sim;
  readonly empire: number;      // 0 = observer
  readonly member: number;
  readonly running: boolean;
  readonly online: boolean;
  pause(); resume();
  claim(x, y): boolean;
  act(type, x?, y?): boolean;
  tick(): Set<number>;          // advance to wall-clock time; returns dirty tiles
  status(): string;
}
```

Two implementations, and `Controls` / `main.ts` never learn which one they hold:

| | [`LocalGame`](../../apps/web/src/game/Local.ts) | [`OnlineGame`](../../apps/web/src/game/Online.ts) |
|---|---|---|
| Moves come from | one human seat + [SimBot](../gameplay/bots.md) empires | [`Lockstep`](../continuity/lockstep.md) — signed moves from every seat |
| `tick()` | queue due moves → `sim.advance` on a wall-clock target | `lockstep.pump()` |
| `empire` / `member` | fixed (1, 0) | read live from `lockstep.seat` (0 = observer) |
| pause | stops the clock | no-op — the world turns regardless |

`LocalGame` is deliberately shaped like the lockstep driver: input is queued as
moves for a future step and applied by `advance()`, never written straight into
state. Swapping local for mesh means changing *where moves come from*, not how
the game runs.

## input.ts — no modes

[`boardClick(game, x, y)`](../../apps/web/src/game/input.ts): the click says
*where*, the board says *what* — uncrossed `RIVER` → `PLACE_BRIDGE`, uncrossed
`WALL` → `PLACE_LADDER`, non-adjacent + `marchUnlocked` → `MARCH`, else `CLAIM`.
It re-checks neither stock nor adjacency — that is
[validation](../moves/validation.md)'s business. Arming a mode was a step between
deciding and doing that only ever disambiguated something the map already knew,
and it cost a class of bug (a mode left armed with nothing in stock swallowed
every later click).

## The view layer

`src/view/` is a pure view layer with **no framework** — plain class instances, a
tiny `R<T>` observable for control bindings, and the DOM itself for state
(`<details>` panels, `data-*` attributes).

Rendering is **hybrid DOM + canvas**, chosen by zoom
(`Camera.DOM_MIN_ZOOM = 11` px/tile):

- **Close in:** real `<div class="tile">` elements carrying the prototype's
  conic-gradient "flag" art. Elements are pooled in a flat index; only
  sim-reported **dirty tiles** are repainted; panning translates one container.
- **Zoomed out:** the DOM is dropped for a scaled blit of `MapImage` — one
  `<canvas>` at 1 px/tile of the whole map, kept current at one pixel write per
  changed tile. The minimap is a second blit of the same buffer.

| File | Role |
|---|---|
| `palette.ts` | **the single source of truth for colour** — `EMPIRE_THEMES`, `TERRAIN_COLORS`, `ITEM_COLORS`, and `injectThemeCss()` which writes per-empire CSS so no colour is defined anywhere else |
| `Camera.ts` | pure view camera — integer zoom ladder, pan/zoom/clamp, visible-tile culling |
| `MapImage.ts` | the 1px/tile canvas backing the LOD view and the minimap |
| `Renderer.ts` | the two renderers behind one `render(state, dirty)` |
| `Minimap.ts` | scaled blit + capital markers + viewport rectangle |
| `Controls.ts` | the HUD, the item shop, standings, the seats panel, the clock, the win banner |
| `LobbyPanel.ts` | multiplayer setup and in-progress roster |
| `Chat.ts` | signed, attributable, [never-hashed](../protocol/team-chat.md) chat; team lines from other empires show "sealed" |
| `Rivals.ts` | the solo-setup SimBot list with per-empire difficulty |
| `Setup.ts` | which kind of game you are starting, and the one form that configures it |
| `Games.ts` | games read off an [address book](../mesh/address-book.md), and what each row offers |

## The menu screen has three parts

One column, read top to bottom, and each part owns its own root.

1. **Games** (`view/Games.ts`) — rows from an
   [address book](../mesh/address-book.md), when one is configured. A sibling of
   the setup card and emphatically **not** a child of `LobbyPanel`: that panel
   replaces its `innerHTML` wholesale and the frame loop drives it five times a
   second, so a list of games inside it would have its rows rebuilt under the
   player's cursor between the mousedown and the mouseup. `Games` follows
   `Rivals` instead — own root, own listener, `render()` when its own data
   changes.
2. **Setup** (`view/Setup.ts`) — solo, host or join, then one shared form (map,
   length, bot empires) and one button. A solo game and a hosted one are the same
   world with different seats in it, which is what lets them share a form;
   joining is a third answer rather than a mode of the second, because a joiner
   configures nothing. `compose` is the fourth mode and the odd one: somebody
   else's room with no game in it yet, and this tab filling the form in. Not a
   kind of `join` (a joiner configures nothing) and not a kind of `host` (the
   door is not ours and we will not be announcing it).

   Two controls in that shared form mean something in only one mode — the
   consent checkbox, and the start button's readiness — so `SetupHandlers` has a
   `moved(mode)` hook that fires on every render and lets `main.ts` hide what
   does not apply. A control that is visibly present and silently ignored is
   worse than one that is absent.
3. **Settings** (`net/settings.ts`) — folded away, because the normal state of
   these is "never touched".

`Games` splits in two on purpose: `rows(listings, now)` produces plain objects
and `render()` turns those into strings. This package has no jsdom, so the view
model is what the Node tests assert on, and the markup is checked separately in
a real engine (below). Every judgement a row makes — a closed join window, a
length read back out of a step count, a game this build cannot play — is an
assertion about that array.

## Announcing, and the three create backends

`src/net/announce.ts` is the whole of what this client posts to a board, and
`doorOf(lobby)` is the whole of its authority: a door is announced only when
`lobby.hosting` and the ref is `rtc`. A tab hosting over WebRTC *is* the room —
its peer id is the room code — so it can promise to keep the door open. A tab
that joined somebody's bus cannot promise that about somebody else's room, and
0006 has already announced it anyway. `Announcer` is a lease, not a
registration: `present()` every ninety seconds carrying whatever
`Lockstep.resumePoint()` has accumulated, `withdraw()` on leave, and a
`pagehide` handler that is explicitly a courtesy — the TTL is the mechanism,
because nothing a browser does on the way out is guaranteed.

The consent checkbox is off and worded as what it sends. Announcing publishes
the sealed record, which carries every player's key; that is a disclosure about
other people rather than a display preference.

Behind the create button there are three backends and one artifact.

| Backend | Where the room is | What this client does |
|---|---|---|
| This tab | the browser | `Lobby.open()` with no ref |
| A host peer | the host process | join its ref, then compose if the room is empty |
| A host service | an instance the service made | `POST /rooms`, then the row above |

The second and third are the same path, which is why `net/factory.ts` has no
composing logic in it: a factory hands back refs, joining them is the ordinary
join path, and `offerToCompose` puts the form up by itself. `net/compose.ts`
holds the guard — `GET /room/:code` (0006) must answer `gameId: ""`, and **not
knowing is a no**, because a host that did not answer might be running a game and
a second record in a room that has one splits it with no error anywhere. That
guard closes the common case and not the race; the race is 0009's.

## Settings

`src/net/settings.ts` — three strings in `localStorage["tessera.settings"]`,
beside the identity, **all empty by default**: the address book, a host factory,
and the host peers a leaderboard would read. Read once at start and written on
change; a settings object that can change under a render is a bug waiting for a
screenshot. Empty means *absent*, not *broken*: with no factory URL the third
create button is not on the screen at all.

It also holds every half of the mixed-content rule — `checkRefForPage` for the
join box, `checkBoardUrl` for the address-book field, `checkFactoryUrl` for the
host-service field — because they are one rule in the three shapes this client
has for it. They are three functions rather than one with a noun passed in: a
board is *read*, a service is *posted to*, and the way out of each is different
(a headless peer will read an `http://` board for you; nothing will use
somebody's factory on your behalf). Neither belongs in `parseRef`
or in `Directory`: a `ws://` ref and an `http://` board are both perfectly good,
and it is *this page*, once served over https, that cannot use them. Both take
the page protocol as an argument rather than reading `location`, which is what
makes the interesting case testable under Node.

## Identity

`src/net/identity.ts` — `myIdentity()` returns an [`Identity`](../protocol/identity.md)
persisted in `localStorage["tessera.identity"]`. **The keypair is the seat.**

## Three test projects

`apps/web/vitest.config.ts` runs three, and the split is about what each can
answer.

- **`node`** — everything that is a pure function of a state or a listing: the
  view models, the clock line, the mixed-content rules. Most of the suite.
- **`ui`** — Chromium only, `src/test/**/*.browser.test.ts`. These views build
  markup by concatenating strings, and a template a parser reads differently from
  how it was written yields a card that is quietly wrong: a stray tag closes a
  list early, an unescaped quote in a game id swallows an attribute and takes the
  button's identity with it. That last one is the reason the project exists — a
  board is allowed to lie, and a game id is a string it chose. One engine is
  enough, because this is a question about the HTML parser and not about
  arithmetic.
- **`browser`** — [`crossenv.test.ts`](../trust-and-verification/verifying-an-archive.md)
  under `@vitest/browser` + Playwright in Chromium, Firefox and WebKit: a
  recorded game must reach the same [hash](../concepts/the-one-invariant.md) in
  all four engines (Node included). `BROWSERS=chromium` narrows it.

Note that `node`'s `src/test/**/*.test.ts` glob matches `*.browser.test.ts` too,
so it carries an explicit `exclude`; without it every browser test runs twice and
fails once.
