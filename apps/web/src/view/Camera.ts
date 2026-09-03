// Camera state is pure view: never in the sim, never hashed, never sent over
// the wire. Two peers looking at different corners of the map are still in
// perfect consensus.

/** Zoom is a ladder of whole pixels-per-tile, not a continuous multiplier.
 *  Fractional zoom gives fractional tile sizes, which means sub-pixel seams
 *  between tiles and a blurry grid; integers keep every edge crisp. It also
 *  makes a zoom step mean the same thing whether it came from a button, a
 *  keypress or a wheel notch. */
export const ZOOM_LEVELS = [2, 3, 4, 6, 8, 11, 14, 18, 24, 32, 40];
export const MIN_ZOOM = ZOOM_LEVELS[0]!;
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;

/** Below this many pixels per tile the DOM tiles are dropped for a scaled blit
 *  of the map image — the "lower-res approximation" of a zoomed-out view. */
export const DOM_MIN_ZOOM = 11;

export const DEFAULT_ZOOM = 24;

/** How far past the map's edge the camera may be pushed, in screen pixels.
 *
 *  Without it the last row and column sit hard against the viewport edge,
 *  which is exactly where the zoom and pan controls are — so the tiles in the
 *  bottom-right corner of the world could be seen and never clicked. Slack in
 *  pixels rather than tiles because what has to be cleared is a button, and a
 *  button is the same size at every zoom.
 *
 *  Comfortably more than the control cluster, which is 30px of button plus its
 *  12px margin. */
export const OVERSCROLL_PX = 96;

/** Tiles of context to keep beyond a tile you clicked near the edge. Capped
 *  against the viewport below, since a quarter of a phone's board is a lot
 *  fewer tiles than a quarter of a desktop's. */
export const REVEAL_TILES = 8;

export class Camera {
  /** World tile coordinates at the viewport's top-left corner. Fractional, so
   *  panning stays smooth rather than snapping tile to tile. */
  x = 0;
  y = 0;
  zoom = DEFAULT_ZOOM;
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

  get canZoomIn(): boolean {
    return this.zoom < MAX_ZOOM;
  }

  get canZoomOut(): boolean {
    return this.zoom > MIN_ZOOM;
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

  /** Pan by a fraction of the viewport — what the on-screen arrows use, so one
   *  press moves a consistent proportion of what you can see at any zoom. */
  panByViewport(fx: number, fy: number): void {
    this.x += (this.width / this.zoom) * fx;
    this.y += (this.height / this.zoom) * fy;
    this.clamp();
  }

  /** Pan the least that leaves room to see around a tile near the edge.
   *
   *  Clicking two tiles from the edge means the next thing you want to do is
   *  almost certainly out there, and reaching it should not cost a separate
   *  pan gesture — on a phone, where the board is small and a drag competes
   *  with a tap, it costs several. Nothing moves when the tile already has
   *  room, so a click in the middle of the board is never a camera event. */
  revealAround(tx: number, ty: number): void {
    const spanX = this.width / this.zoom;
    const spanY = this.height / this.zoom;
    // No more than a quarter of what is on screen: on a narrow board a fixed
    // eight tiles would mean every tile but the middle few pans the map.
    const marginX = Math.min(REVEAL_TILES, Math.floor(spanX / 4));
    const marginY = Math.min(REVEAL_TILES, Math.floor(spanY / 4));

    if (tx - marginX < this.x) this.x = tx - marginX;
    else if (tx + 1 + marginX > this.x + spanX) this.x = tx + 1 + marginX - spanX;

    if (ty - marginY < this.y) this.y = ty - marginY;
    else if (ty + 1 + marginY > this.y + spanY) this.y = ty + 1 + marginY - spanY;

    this.clamp();
  }

  centreOn(tx: number, ty: number): void {
    this.x = tx - this.width / this.zoom / 2;
    this.y = ty - this.height / this.zoom / 2;
    this.clamp();
  }

  /** Move one rung up or down the ladder, holding the tile under (px, py)
   *  still. Defaults to the viewport centre, which is what buttons and
   *  keyboard want. */
  zoomStep(direction: number, px = this.width / 2, py = this.height / 2): void {
    const index = this.levelIndex();
    const target = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction));
    const next = ZOOM_LEVELS[target]!;
    if (next === this.zoom) return;

    const [tx, ty] = this.toTile(px, py);
    this.zoom = next;
    this.x = tx - px / this.zoom;
    this.y = ty - py / this.zoom;
    this.clamp();
  }

  private levelIndex(): number {
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      const delta = Math.abs(ZOOM_LEVELS[i]! - this.zoom);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return best;
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
    // The slack is a fixed number of pixels, so it is the same strip of screen
    // at every zoom — which is the point, since what it exists to clear is a
    // button rather than a number of tiles.
    const slack = OVERSCROLL_PX / this.zoom;

    this.x = spanX >= this.mapWidth
      ? (this.mapWidth - spanX) / 2
      : Math.max(-slack, Math.min(this.mapWidth - spanX + slack, this.x));
    this.y = spanY >= this.mapHeight
      ? (this.mapHeight - spanY) / 2
      : Math.max(-slack, Math.min(this.mapHeight - spanY + slack, this.y));

    this.changed = true;
  }
}
