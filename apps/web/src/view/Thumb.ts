// A game's map in the listings: the small grid the room sends, drawn a pixel
// a cell in the colours the zoomed-out board uses.

import { TERRAIN, bannerAt } from "@tessera/sim";
import { bannerById, mapColour, NEUTRAL, TERRAIN_COLORS, rgb } from "./palette";

/** The map as the listings carry it. See `ListedMap` in the Worker. */
export interface ListedMap {
  w: number;
  h: number;
  /** House ids, by empire id from 1. */
  b: string[];
  c: string;
  step: number;
}

/** Cell values from here up are unowned terrain. Mirrors `TERRAIN_BASE` in
 *  the room. */
const TERRAIN_BASE = 240;

export function parseMap(json: string | null | undefined): ListedMap | undefined {
  if (!json) return undefined;
  try {
    const map = JSON.parse(json) as ListedMap;
    return map.w > 0 && map.h > 0 && typeof map.c === "string" ? map : undefined;
  } catch {
    return undefined;
  }
}

/** The house an empire flies in a listed game: from its map, or for a game
 *  with none, the one its index meant before houses were picked. */
export const houseIn = (map: ListedMap | undefined, empire: number) =>
  map ? bannerById(map.b[empire - 1]) : bannerAt(empire);

/** A canvas for a game's map, to be filled by `drawMaps` once it is on the page. */
export function mapCanvas(id: string, map: ListedMap): string {
  return `<canvas class="game-map" width="${map.w}" height="${map.h}" style="aspect-ratio:${map.w}/${map.h}"
    data-game-map="${id}" aria-hidden="true"></canvas>`;
}

async function inflate(base64: string): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The colour of every cell value a map can hold, with these houses flown by
 *  empire id from 1. For the listings' maps and a timeline's frames, which
 *  share their cell values (`thumbnail` in the room). */
export function cellColours(banners: readonly string[]): Array<[number, number, number]> {
  const colours: Array<[number, number, number]> = new Array(256).fill(rgb(NEUTRAL));
  banners.forEach((id, at) => {
    const banner = bannerById(id);
    if (banner) colours[at + 1] = rgb(mapColour(banner));
  });
  for (const [terrain, colour] of Object.entries(TERRAIN_COLORS)) colours[TERRAIN_BASE + Number(terrain)] = rgb(colour);
  return colours;
}

export async function drawMap(canvas: HTMLCanvasElement, map: ListedMap): Promise<void> {
  const cells = await inflate(map.c);
  if (cells.length !== map.w * map.h) return;
  const colours = cellColours(map.b);
  const image = new ImageData(map.w, map.h);
  for (let i = 0; i < cells.length; i++) {
    const [r, g, b] = colours[cells[i]!]!;
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = 255;
  }
  canvas.getContext("2d")?.putImageData(image, 0, 0);
}

/** Fill every map canvas under `root` from the games it was rendered for. */
export function drawMaps(root: HTMLElement, maps: ReadonlyMap<string, ListedMap>): void {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>("canvas[data-game-map]")) {
    const map = maps.get(canvas.dataset.gameMap!);
    if (map) void drawMap(canvas, map).catch(() => undefined);
  }
}

// --- before the start --------------------------------------------------------

/** A made-up map, the same for every game, for one that has none to show yet:
 *  a game is not dealt its map until it starts. Drawn in the board's colours so
 *  it reads as a map, and dimmed in the stylesheet so it does not read as this
 *  game's. One letter a cell. */
const SAMPLE = [
  "..............RR........",
  "..MMM..........R........",
  ".MMMMM.........R...LLL..",
  "MMMMMMM........RR.LLLLL.",
  ".MMMMM..........R.LLLLL.",
  "..MM............B..LLL..",
  "................R.......",
  "WWWWWWHWWWW.....RR......",
  ".................R......",
  "....LL...........R..MM..",
  "...LLLL..........B.MMMM.",
  "..LLLLLL.........RMMMMMM",
  "...LLLL.........RR.MMMM.",
  "....LL..........R.......",
  "..........WWWWWHRWWWWW..",
  "...............RR.......",
];

const SAMPLE_TERRAIN: Record<string, number> = {
  M: TERRAIN.MOUNTAIN,
  L: TERRAIN.LAKE,
  R: TERRAIN.RIVER,
  B: TERRAIN.RIVER_BRIDGED,
  W: TERRAIN.WALL,
  H: TERRAIN.WALL_LADDERED,
};

let sample: string | undefined;

/** The made-up map as an SVG, a rect a cell, built once. */
function sampleSvg(): string {
  if (sample) return sample;
  const w = SAMPLE[0]!.length;
  const h = SAMPLE.length;
  const cells = SAMPLE.flatMap((row, y) =>
    [...row].flatMap((ch, x) => {
      const terrain = SAMPLE_TERRAIN[ch];
      return terrain === undefined
        ? []
        : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${TERRAIN_COLORS[terrain]}"/>`];
    }),
  ).join("");
  sample = `<svg viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">
    <rect width="${w}" height="${h}" fill="${NEUTRAL}"/>${cells}</svg>`;
  return sample;
}

/** The picture for a game with no map yet. */
export function samplePicture(): string {
  return `<span class="game-map game-map-sample">${sampleSvg()}</span>`;
}

/** A game's length, as short as it goes: 6h, 1d, 10d, 90m. */
export function lengthLabel(ms: number | null | undefined): string | undefined {
  if (!ms || !(ms > 0)) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A game's length in words, for whoever cannot see the badge. */
export function lengthWords(ms: number): string {
  const label = lengthLabel(ms)!;
  const n = Number(label.slice(0, -1));
  const unit = { d: "day", h: "hour", m: "minute" }[label.slice(-1)]!;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
