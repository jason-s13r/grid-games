// Camera state is pure view: never in the sim, never hashed, never sent over
// the wire. Two peers looking at different corners of the map are still in
// perfect consensus.

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 40;
/** Below this many pixels per tile the DOM tiles are dropped for a scaled blit
 *  of the map image — the "lower-res approximation" of a zoomed-out view. */
export const DOM_MIN_ZOOM = 11;

export class Camera {
  /** World tile coordinates at the viewport's top-left corner. Fractional, so
   *  panning stays smooth rather than snapping tile to tile. */
  x = 0;
  y = 0;
  zoom = 24;
  width = 0;
  height = 0;
  changed = true;

  constructor(
    private mapWidth: number,
    private mapHeight: number,
  ) {}

  get usesDom(): boolean {
    return this.zoom >= DOM_MIN_ZOOM;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.clamp();
  }

  panByPixels(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  centreOn(tx: number, ty: number): void {
    this.x = tx - this.width / this.zoom / 2;
    this.y = ty - this.height / this.zoom / 2;
    this.clamp();
  }

  /** Zoom about a screen point, so the tile under the cursor stays put. */
  zoomAt(px: number, py: number, factor: number): void {
    const [tx, ty] = this.toTile(px, py);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    this.x = tx - px / this.zoom;
    this.y = ty - py / this.zoom;
    this.clamp();
  }

  toTile(px: number, py: number): [number, number] {
    return [this.x + px / this.zoom, this.y + py / this.zoom];
  }

  tileAt(px: number, py: number): [number, number] {
    const [tx, ty] = this.toTile(px, py);
    return [Math.floor(tx), Math.floor(ty)];
  }

  toScreen(tx: number, ty: number): [number, number] {
    return [(tx - this.x) * this.zoom, (ty - this.y) * this.zoom];
  }

  /** Visible tile range, inclusive-exclusive, expanded by a margin ring so a
   *  pan does not expose un-rendered edges. */
  range(margin = 2): { x0: number; y0: number; x1: number; y1: number } {
    const x0 = Math.max(0, Math.floor(this.x) - margin);
    const y0 = Math.max(0, Math.floor(this.y) - margin);
    const x1 = Math.min(this.mapWidth, Math.ceil(this.x + this.width / this.zoom) + margin);
    const y1 = Math.min(this.mapHeight, Math.ceil(this.y + this.height / this.zoom) + margin);
    return { x0, y0, x1, y1 };
  }

  private clamp(): void {
    const spanX = this.width / this.zoom;
    const spanY = this.height / this.zoom;

    this.x = spanX >= this.mapWidth
      ? (this.mapWidth - spanX) / 2
      : Math.max(0, Math.min(this.mapWidth - spanX, this.x));
    this.y = spanY >= this.mapHeight
      ? (this.mapHeight - spanY) / 2
      : Math.max(0, Math.min(this.mapHeight - spanY, this.y));

    this.changed = true;
  }
}
