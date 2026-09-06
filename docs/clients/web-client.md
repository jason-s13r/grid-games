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

## Identity

`src/net/identity.ts` — `myIdentity()` returns an [`Identity`](../protocol/identity.md)
persisted in `localStorage["tessera.identity"]`. **The keypair is the seat.**

## The cross-environment test

`apps/web` runs [`crossenv.test.ts`](../trust-and-verification/verifying-an-archive.md)
under `@vitest/browser` + Playwright in Chromium, Firefox and WebKit — a recorded
game must reach the same [hash](../concepts/the-one-invariant.md) in all four
engines (Node included). `BROWSERS=chromium` narrows it.
