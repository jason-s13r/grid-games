// One source of truth for colour, shared by the DOM tiles, the zoomed-out
// canvas and the minimap.
//
// The flag patterns come straight from the prototype's conic-gradient art —
// both were already parameterised on --c1/--c2, so they generalise to N empires
// by swapping two variables rather than writing a new gradient per empire.
//
// The table itself now lives in `@tessera/sim` as `BANNERS`, because a headless
// peer wants to say "Sping won" rather than "empire 4 won" and the id-to-name
// half of that is not a client concern. What is left here is the client's half:
// how a banner is painted, and the CSS that paints it.

import { BANNERS, MAX_EMPIRES, TERRAIN, ITEM, bannerAt, bannerById } from "@tessera/sim";
import type { Banner, BannerId } from "@tessera/sim";

export type Pattern = "star" | "spiral";
export type EmpireTheme = Banner;

export { BANNERS, MAX_EMPIRES };

/** The banner an empire is flying in *this* game.
 *
 *  A per-game table, because the binding is per game: a record says which house
 *  each empire flies and a record that does not say falls back to the index.
 *  Built once from the genesis and handed to the views — which is the whole
 *  reason `empireTheme(id)`, a pure function of a number, could not survive.
 */
export class Flags {
  private readonly flown = new Map<number, Banner>();

  constructor(empires: ReadonlyArray<{ banner?: BannerId }> = []) {
    empires.forEach((empire, at) => {
      const banner = bannerById(empire.banner) ?? bannerAt(at + 1);
      if (banner) this.flown.set(at + 1, banner);
    });
  }

  /** Bind a banner arriving after step 0 — a vacancy's claimant brings its own.
   *  Ignored when the house is already flown, which is how a race resolves: the
   *  earlier record in log order keeps it and the later empire keeps its index
   *  colours. It changes a picture rather than a world. */
  fly(empire: number, banner: BannerId | undefined): boolean {
    const wanted = bannerById(banner);
    if (!wanted) return false;
    for (const [at, held] of this.flown) {
      if (held.id === wanted.id && at !== empire) return false;
    }
    this.flown.set(empire, wanted);
    return true;
  }

  of(empire: number): Banner {
    // Past the end is a game that should have been refused at composition. The
    // first banner is a last resort so a view cannot crash on a record it
    // should never have been handed.
    return this.flown.get(empire) ?? bannerAt(empire) ?? BANNERS[0]!;
  }

  /** What to call an empire, for a sentence a player reads. */
  nameOf(empire: number): string {
    return this.of(empire).name;
  }
}

/** The fallback binding, for anything drawing before a genesis exists — the
 *  setup form's swatches, mostly. Index order, which is what every record
 *  written before banners existed means. */
export const DEFAULT_FLAGS = new Flags();

/** The binding in force.
 *
 *  Module state, and deliberately: `empireTheme(id)` was already a global
 *  lookup keyed on a number, called from seven view files and two dozen sites.
 *  What changes is not where the answer comes from but **what it depends on** —
 *  a per-game table rather than a modulus — so the seam stays exactly where it
 *  was and the per-game part is one assignment when a game starts.
 *
 *  A view that caches colours (`MapImage`) must be told; one that reads per
 *  frame (`Minimap`, `Controls`) need not be. */
let current: Flags = DEFAULT_FLAGS;

export function setFlags(flags: Flags): void {
  current = flags;
}

export const flags = (): Flags => current;

export const empireTheme = (id: number): Banner => current.of(id);

export const NEUTRAL = "#fffbe8";
export const GRID_LINE = "#dedbdb";

export const TERRAIN_COLORS: Record<number, string> = {
  [TERRAIN.PLAIN]: NEUTRAL,
  [TERRAIN.MOUNTAIN]: "#6b6255",
  [TERRAIN.LAKE]: "#2f6b8f",
  [TERRAIN.RIVER]: "#4a90b8",
  [TERRAIN.RIVER_BRIDGED]: "#9a7f52",
  [TERRAIN.WALL]: "#8a8178",
  [TERRAIN.WALL_LADDERED]: "#b09a6a",
};

/** A key for a mine that is giving, in the colour tables. Not an item value:
 *  a dug mine's item value counts down what it has left. */
export const MINE_DUG = 256;

export const ITEM_COLORS: Record<number, string> = {
  [ITEM.BRONZE]: "#cd7f32",
  [ITEM.SILVER]: "#d8d8d8",
  [ITEM.GOLD]: "#ffd700",
  [ITEM.DIAMOND]: "#7fe8f0",
  // Mines: dark rock waiting for a dig, and lit up while it gives.
  [ITEM.MINE]: "#3d3a52",
  [MINE_DUG]: "#5ad1e0",
};

export function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Per-banner colours, generated rather than written out in SCSS.
 *
 *  **Keyed on the banner slug, not the empire id**, and that is what makes the
 *  stylesheet static and complete again. It used to emit one rule per entry
 *  keyed `.tile[data-empire="N"]`, which meant exactly six rules — so a seventh
 *  empire matched none of them, inherited `--c1: transparent` from the base
 *  rule, and had its territory drawn *invisible on the main board*, carrying
 *  the right pattern class and the right attribute the whole time. Not a
 *  duplicate colour: a disappearance, reachable by seven friends pressing
 *  start.
 *
 *  One rule per banner in the table, injected once at import time with no
 *  dependence on how many empires this game has. The per-game binding is a
 *  single attribute write in `paintTile`, and growing the table is a pure data
 *  change for the CSS too. */
export function injectThemeCss(): void {
  const rules = BANNERS.map(
    (banner) => `
.tile[data-banner="${banner.id}"] { --c1: ${banner.c1}; --c2: ${banner.c2}; }
.swatch[data-banner="${banner.id}"] { background: ${banner.c1}; }`,
  ).join("");

  const style = document.createElement("style");
  style.textContent = rules;
  document.head.appendChild(style);
}
