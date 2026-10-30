// The AoE piece: the whole map at a glance, with the viewport drawn on it and
// click-to-jump. It is another scaled blit of the same map image, so it costs
// one drawImage per frame no matter how large the map is.

import type { State } from "@tessera/sim";
import { Camera } from "./Camera";
import { MapImage } from "./MapImage";
import { empireTheme } from "./palette";

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private dragging = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private mapImage: MapImage,
    private mapWidth: number,
    private mapHeight: number,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    // A canvas has two sizes and they are not the same one. The backing store
    // is what fit() letterboxes the map into; the bounding rect is CSS pixels,
    // which here is whatever width the sidebar happens to be. Reading a click
    // in one and converting with the other put every jump at roughly a third
    // of where it was aimed, and worse the wider the panel got — which is why
    // it was at its most useless on a phone, where the minimap is widest
    // relative to its 240px backing store.
    const jump = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const fit = this.fit();
      const px = ((event.clientX - rect.left) * canvas.width) / rect.width;
      const py = ((event.clientY - rect.top) * canvas.height) / rect.height;
      this.camera.centreOn((px - fit.ox) / fit.scale, (py - fit.oy) / fit.scale);
    };

    canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      jump(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.dragging) jump(event);
    });
    canvas.addEventListener("pointerup", (event) => {
      this.dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    });

    // Match the backing store to the box it is drawn in. The markup's 240x160
    // was a guess at a sidebar width and is now only the size before the first
    // measurement — a phone shows this canvas at twice that and was getting a
    // blurry upscale of it.
    new ResizeObserver(() => this.measure()).observe(canvas);
    this.measure();
  }

  /** Sized in device pixels so the blit is crisp, capped because a minimap is
   *  a thumbnail and there is nothing to gain from a 4K one. */
  private measure(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round((rect.width * this.mapHeight * dpr) / this.mapWidth);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Letterbox the map into the canvas, preserving aspect. */
  private fit(): { scale: number; ox: number; oy: number } {
    const scale = Math.min(
      this.canvas.width / this.mapWidth,
      this.canvas.height / this.mapHeight,
    );
    return {
      scale,
      ox: (this.canvas.width - this.mapWidth * scale) / 2,
      oy: (this.canvas.height - this.mapHeight * scale) / 2,
    };
  }

  render(state: State): void {
    const { ctx } = this;
    const { scale, ox, oy } = this.fit();

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.mapImage.canvas,
      0, 0, this.mapWidth, this.mapHeight,
      ox, oy, this.mapWidth * scale, this.mapHeight * scale,
    );

    // Capitals, so you can find the fronts without hunting.
    for (const empire of state.empires) {
      if (!empire.alive) continue;
      const cx = empire.capital % this.mapWidth;
      const cy = (empire.capital - cx) / this.mapWidth;
      ctx.strokeStyle = empireTheme(empire.id).c1;
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + cx * scale - 2, oy + cy * scale - 2, 5, 5);
    }

    // Viewport rectangle: dark on the pale paper, with a light edge inside it
    // for the dark terrain, and never smaller than a few pixels, so a close
    // zoom on a big map can still be found.
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    const least = 6 * dpr;
    const vw = Math.max(least, (this.camera.width / this.camera.zoom) * scale);
    const vh = Math.max(least, (this.camera.height / this.camera.zoom) * scale);
    const vx = ox + this.camera.x * scale + ((this.camera.width / this.camera.zoom) * scale - vw) / 2;
    const vy = oy + this.camera.y * scale + ((this.camera.height / this.camera.zoom) * scale - vh) / 2;
    ctx.strokeStyle = "#1f2033";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(vx, vy, vw, vh);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(vx + 1.5 * dpr, vy + 1.5 * dpr, vw - 3 * dpr, vh - 3 * dpr);
  }
}
