// Two renderers behind one interface, chosen by zoom.
//
// Close in, real DOM tiles carry the conic-gradient flag art — that art is the
// soul of the thing and canvas would lose it. Zoomed out, the DOM is dropped
// entirely for a scaled blit of the map image.
//
// The prototype ran a querySelector per cell per frame (800 DOM queries a frame
// on a 40x20 grid). Here elements are held in a flat index and recycled through
// a pool, and only tiles the sim reports dirty are touched.

import type { State } from "@tessera/sim";
import { ITEM, TERRAIN, idx, isProtected } from "@tessera/sim";
import { Camera } from "./Camera.js";
import { MapImage } from "./MapImage.js";
import { empireTheme } from "./palette.js";

const TERRAIN_CLASS: Record<number, string> = {
  [TERRAIN.MOUNTAIN]: "t-mountain",
  [TERRAIN.LAKE]: "t-lake",
  [TERRAIN.RIVER]: "t-river",
  [TERRAIN.RIVER_BRIDGED]: "t-bridge",
  [TERRAIN.WALL]: "t-wall",
  [TERRAIN.WALL_LADDERED]: "t-ladder",
};

const ITEM_CLASS: Record<number, string> = {
  [ITEM.BRONZE]: "i-bronze",
  [ITEM.SILVER]: "i-silver",
  [ITEM.GOLD]: "i-gold",
  [ITEM.DIAMOND]: "i-diamond",
};

/** Below this, tile numbers are dropped — they are unreadable anyway and the
 *  text writes dominate the frame. */
const LABEL_MIN_ZOOM = 17;

export class Renderer {
  private live = new Map<number, HTMLDivElement>();
  private pool: HTMLDivElement[] = [];
  private ctx: CanvasRenderingContext2D;
  private lastZoom = -1;
  private lastDom = true;

  constructor(
    private tiles: HTMLElement,
    private lod: HTMLCanvasElement,
    private camera: Camera,
    private mapImage: MapImage,
  ) {
    const ctx = lod.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  render(state: State, dirty: ReadonlySet<number> | null): void {
    if (dirty) for (const i of dirty) this.mapImage.paint(state, i);
    this.mapImage.flush();

    const dom = this.camera.usesDom;
    if (dom !== this.lastDom) {
      if (!dom) this.releaseAll();
      this.tiles.hidden = !dom;
      this.lod.hidden = dom;
      this.lastDom = dom;
      this.camera.changed = true;
    }

    if (dom) this.renderDom(state, dirty);
    else this.renderBlocks();

    this.camera.changed = false;
  }

  // --- close range: DOM tiles with the flag art ------------------------------

  private renderDom(state: State, dirty: ReadonlySet<number> | null): void {
    const { camera } = this;
    const zoomed = camera.zoom !== this.lastZoom;

    // Panning moves one container rather than every tile, so a drag costs a
    // single style write instead of ~1500.
    this.tiles.style.transform = `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px)`;

    if (zoomed) {
      this.tiles.style.setProperty("--tile-size", `${camera.zoom}px`);
      this.lastZoom = camera.zoom;
    }

    if (camera.changed || zoomed) {
      this.reconcile(state);
      return;
    }

    if (!dirty) return;
    for (const i of dirty) {
      const el = this.live.get(i);
      if (el) this.paintTile(el, state, i);
      else if (this.inRange(i)) this.acquire(state, i);
    }
  }

  /** Bring the live set in line with the visible range: release what left,
   *  acquire what entered, repaint the rest. */
  private reconcile(state: State): void {
    const { x0, y0, x1, y1 } = this.camera.range();
    const width = state.width;

    for (const [i, el] of this.live) {
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) {
        this.release(i, el);
      }
    }

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = idx(x, y, width);
        const el = this.live.get(i);
        if (el) this.paintTile(el, state, i);
        else this.acquire(state, i);
      }
    }
  }

  private inRange(i: number): boolean {
    const { x0, y0, x1, y1 } = this.camera.range();
    const x = i % this.mapWidth;
    const y = (i - x) / this.mapWidth;
    return x >= x0 && x < x1 && y >= y0 && y < y1;
  }

  private get mapWidth(): number {
    return this.mapImage.canvas.width;
  }

  private acquire(state: State, i: number): void {
    const el = this.pool.pop() ?? this.create();
    const x = i % state.width;
    const y = (i - x) / state.width;
    el.style.transform = `translate(${x * this.camera.zoom}px, ${y * this.camera.zoom}px)`;
    this.live.set(i, el);
    this.paintTile(el, state, i);
    if (!el.isConnected) this.tiles.appendChild(el);
    el.hidden = false;
  }

  private release(i: number, el: HTMLDivElement): void {
    el.hidden = true;
    this.live.delete(i);
    this.pool.push(el);
  }

  private releaseAll(): void {
    for (const [i, el] of this.live) this.release(i, el);
  }

  private create(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "tile";
    return el;
  }

  private paintTile(el: HTMLDivElement, state: State, i: number): void {
    const owner = state.owner[i]!;
    const terrain = state.terrain[i]!;
    const item = state.item[i]!;
    const pop = state.pop[i]!;

    let cls = "tile";
    if (owner > 0) cls += ` ${empireTheme(owner).pattern === "star" ? "p-star" : "p-spiral"}`;
    const t = TERRAIN_CLASS[terrain];
    if (t) cls += ` ${t}`;
    const it = ITEM_CLASS[item];
    if (it) cls += ` ${it}`;

    const empire = owner > 0 ? state.empires[owner - 1] : undefined;
    if (empire && empire.capital === i) {
      cls += " is-capital";
      if (isProtected(state, empire)) cls += " is-protected";
    }

    if (el.className !== cls) el.className = cls;

    const attr = owner > 0 ? String(owner) : "";
    if (el.dataset.empire !== attr) el.dataset.empire = attr;

    const label = this.camera.zoom >= LABEL_MIN_ZOOM && pop > 0 ? String(pop) : "";
    if (el.textContent !== label) el.textContent = label;
  }

  // --- far out: a scaled blit of the map image -------------------------------

  private renderBlocks(): void {
    const { camera, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = camera.width;
    const h = camera.height;

    if (this.lod.width !== Math.round(w * dpr) || this.lod.height !== Math.round(h * dpr)) {
      this.lod.width = Math.round(w * dpr);
      this.lod.height = Math.round(h * dpr);
      this.lod.style.width = `${w}px`;
      this.lod.style.height = `${h}px`;
      ctx.imageSmoothingEnabled = false;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);

    const spanX = w / camera.zoom;
    const spanY = h / camera.zoom;
    ctx.drawImage(
      this.mapImage.canvas,
      camera.x, camera.y, spanX, spanY,
      0, 0, w, h,
    );

    // Unclaimed plains are the same colour as the page, so without this the
    // map has no visible edge once you zoom past it.
    const [ox, oy] = camera.toScreen(0, 0);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      ox - 0.5,
      oy - 0.5,
      this.mapImage.canvas.width * camera.zoom + 1,
      this.mapImage.canvas.height * camera.zoom + 1,
    );
  }
}
