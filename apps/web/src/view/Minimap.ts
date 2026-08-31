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

    const jump = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const fit = this.fit();
      const tx = ((event.clientX - rect.left - fit.ox) / fit.scale);
      const ty = ((event.clientY - rect.top - fit.oy) / fit.scale);
      this.camera.centreOn(tx, ty);
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

    // Viewport rectangle.
    const vw = (this.camera.width / this.camera.zoom) * scale;
    const vh = (this.camera.height / this.camera.zoom) * scale;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + this.camera.x * scale, oy + this.camera.y * scale, vw, vh);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(ox + this.camera.x * scale, oy + this.camera.y * scale, vw, vh);
  }
}
