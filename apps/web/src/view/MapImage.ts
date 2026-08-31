// One image of the whole map at one pixel per tile.
//
// This is the trick that makes an arbitrarily large map cheap to draw. Both the
// zoomed-out view and the minimap are scaled blits of this single buffer, so
// drawing costs one drawImage regardless of zoom or map size, and keeping it
// current costs one pixel write per changed tile.

import type { State } from "@tessera/sim";
import { ITEM } from "@tessera/sim";
import { TERRAIN_COLORS, ITEM_COLORS, empireTheme, rgb } from "./palette";

export class MapImage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private terrainRgb: Array<[number, number, number]> = [];
  private empireRgb: Array<[number, number, number]> = [];
  private itemRgb: Record<number, [number, number, number]> = {};
  private stale = true;

  constructor(
    private width: number,
    private height: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.image = this.ctx.createImageData(width, height);

    for (const [key, hex] of Object.entries(TERRAIN_COLORS)) {
      this.terrainRgb[Number(key)] = rgb(hex);
    }
    for (const [key, hex] of Object.entries(ITEM_COLORS)) {
      this.itemRgb[Number(key)] = rgb(hex);
    }
    for (let id = 1; id <= 8; id++) this.empireRgb[id] = rgb(empireTheme(id).c1);
  }

  paintAll(state: State): void {
    for (let i = 0; i < state.owner.length; i++) this.paint(state, i);
  }

  paint(state: State, i: number): void {
    const owner = state.owner[i]!;
    const item = state.item[i]!;

    let colour: [number, number, number];
    if (item !== ITEM.NONE) colour = this.itemRgb[item]!;
    else if (owner > 0) colour = this.empireRgb[owner] ?? this.empireRgb[1]!;
    else colour = this.terrainRgb[state.terrain[i]!] ?? this.terrainRgb[0]!;

    const o = i * 4;
    const data = this.image.data;
    data[o] = colour[0];
    data[o + 1] = colour[1];
    data[o + 2] = colour[2];
    data[o + 3] = 255;
    this.stale = true;
  }

  /** Push accumulated pixel writes to the canvas. Called once per frame, not
   *  once per tile. */
  flush(): void {
    if (!this.stale) return;
    this.ctx.putImageData(this.image, 0, 0);
    this.stale = false;
  }
}
