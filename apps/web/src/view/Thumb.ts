// A game's map in the listings: the small grid the room sends, drawn a pixel
// a cell in the colours the zoomed-out board uses.

import { bannerAt } from "@tessera/sim";
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

/** The colour of every cell value a map can hold. */
function lookup(map: ListedMap): Array<[number, number, number]> {
  const colours: Array<[number, number, number]> = new Array(256).fill(rgb(NEUTRAL));
  map.b.forEach((id, at) => {
    const banner = bannerById(id);
    if (banner) colours[at + 1] = rgb(mapColour(banner));
  });
  for (const [terrain, colour] of Object.entries(TERRAIN_COLORS)) colours[TERRAIN_BASE + Number(terrain)] = rgb(colour);
  return colours;
}

export async function drawMap(canvas: HTMLCanvasElement, map: ListedMap): Promise<void> {
  const cells = await inflate(map.c);
  if (cells.length !== map.w * map.h) return;
  const colours = lookup(map);
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
