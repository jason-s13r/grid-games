// One source of truth for colour, shared by the DOM tiles, the zoomed-out
// canvas and the minimap.
//
// The flag patterns come straight from the prototype's conic-gradient art —
// both were already parameterised on --c1/--c2, so they generalise to N empires
// by swapping two variables rather than writing a new gradient per empire.

import { TERRAIN, ITEM } from "@tessera/sim";

export type Pattern = "star" | "spiral";

export interface EmpireTheme {
  name: string;
  c1: string;
  c2: string;
  pattern: Pattern;
}

export const EMPIRE_THEMES: EmpireTheme[] = [
  { name: "Vermilion", c1: "#ff2600", c2: "#1a0400", pattern: "star" },
  { name: "Verdant", c1: "#72e21f", c2: "#044012", pattern: "spiral" },
  { name: "Cobalt", c1: "#3d8bff", c2: "#04173f", pattern: "star" },
  { name: "Amber", c1: "#ffb300", c2: "#3d2400", pattern: "spiral" },
  { name: "Amethyst", c1: "#b45cff", c2: "#26043f", pattern: "star" },
  { name: "Cyan", c1: "#00d5c8", c2: "#00332f", pattern: "spiral" },
];

export const empireTheme = (id: number): EmpireTheme =>
  EMPIRE_THEMES[(id - 1) % EMPIRE_THEMES.length]!;

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

export const ITEM_COLORS: Record<number, string> = {
  [ITEM.BRONZE]: "#cd7f32",
  [ITEM.SILVER]: "#d8d8d8",
  [ITEM.GOLD]: "#ffd700",
  [ITEM.DIAMOND]: "#7fe8f0",
};

export function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Per-empire colours are generated rather than written out in SCSS, so the
 *  palette above stays the only place a colour is defined. */
export function injectThemeCss(): void {
  const rules = EMPIRE_THEMES.map(
    (theme, i) => `
.tile[data-empire="${i + 1}"] { --c1: ${theme.c1}; --c2: ${theme.c2}; }
.swatch[data-empire="${i + 1}"] { background: ${theme.c1}; }`,
  ).join("");

  const style = document.createElement("style");
  style.textContent = rules;
  document.head.appendChild(style);
}
