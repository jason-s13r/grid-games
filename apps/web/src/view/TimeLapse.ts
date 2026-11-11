// A finished game watched from its timeline: the map over time, as the room
// recorded it, played as a time-lapse.
//
// For a game whose version this build no longer plays. A replay re-runs the
// game's rules, and once a version is retired those rules are gone; the
// frames need none. No numbers, no shop, no empire list: the map, the houses,
// and the day.
//
// Frames are kept as their bytes and decoded on the way: a delta needs the
// frame before it, and a key frame comes every KEY_EVERY, so a seek decodes
// forward from the key frame at or before it, at most KEY_EVERY - 1 frames.

import { STEPS_PER_SECOND } from "@tessera/sim";
import { decodeFrame, isKeyFrame } from "@tessera/room";
import type { Timeline } from "@tessera/room";
import { fromBase64Url } from "@tessera/protocol";
import { cellColours } from "./Thumb";
import { escape } from "./escape";

/** Frames shown a second while playing: a game's 4,000 or so in a little over
 *  two minutes, whatever its length. */
const FPS = 30;

export class TimeLapse {
  private readonly bytes: Uint8Array[];
  private readonly steps: number[];
  private readonly colours: Array<[number, number, number]>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly slider: HTMLInputElement;
  private readonly when: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  /** The frame on screen and its cells. */
  private at = -1;
  private cells: Uint8Array | undefined;
  private playing = false;
  private last = 0;
  private carry = 0;
  private raf = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly timeline: Timeline,
    info: { roomId: string; protocol: number },
    private readonly onClose: () => void,
  ) {
    this.bytes = timeline.frames.map(([, data]) => fromBase64Url(data) ?? new Uint8Array([0]));
    this.steps = timeline.frames.map(([step]) => step);
    this.colours = cellColours(timeline.banners);

    root.innerHTML = `
      <div class="timelapse-card card">
        <div class="list-head">
          <h2>${escape(info.roomId)}</h2>
          <button class="btn btn-small" type="button" data-tl-close>Close</button>
        </div>
        <p class="hint">Played on v${info.protocol}, which this version no longer plays, so here is its map over time.</p>
        <canvas class="timelapse-map" width="${timeline.width}" height="${timeline.height}"
          style="aspect-ratio:${timeline.width}/${timeline.height}"></canvas>
        <div class="timelapse-controls">
          <button class="btn btn-small go" type="button" data-tl-play>Play</button>
          <input type="range" min="0" max="${timeline.frames.length - 1}" value="0" step="1" data-tl-seek aria-label="When in the game">
          <span class="hint" data-tl-when></span>
        </div>
      </div>`;
    this.canvas = root.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.image = this.ctx.createImageData(timeline.width, timeline.height);
    this.slider = root.querySelector<HTMLInputElement>("[data-tl-seek]")!;
    this.when = root.querySelector<HTMLElement>("[data-tl-when]")!;
    this.playButton = root.querySelector<HTMLButtonElement>("[data-tl-play]")!;

    this.playButton.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.slider.addEventListener("input", () => {
      this.pause();
      this.show(Number(this.slider.value));
    });
    root.querySelector("[data-tl-close]")!.addEventListener("click", () => this.close());

    root.hidden = false;
    this.show(0);
  }

  close(): void {
    this.pause();
    this.root.hidden = true;
    this.root.replaceChildren();
    this.onClose();
  }

  private play(): void {
    if (this.at >= this.bytes.length - 1) this.show(0);
    this.playing = true;
    this.playButton.textContent = "Pause";
    this.last = performance.now();
    this.carry = 0;
    const tick = (now: number) => {
      if (!this.playing) return;
      this.carry += ((now - this.last) * FPS) / 1000;
      this.last = now;
      const ahead = Math.floor(this.carry);
      if (ahead > 0) {
        this.carry -= ahead;
        this.show(Math.min(this.bytes.length - 1, this.at + ahead));
      }
      if (this.at >= this.bytes.length - 1) return this.pause();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.playButton.textContent = this.at >= this.bytes.length - 1 ? "Again" : "Play";
  }

  /** Put frame `n` on screen. */
  private show(n: number): void {
    const size = this.timeline.width * this.timeline.height;
    // Forward from the frame on screen when it is on the way; otherwise from
    // the key frame at or before `n`.
    let from = n;
    while (from > 0 && !isKeyFrame(this.bytes[from]!)) from--;
    let cells: Uint8Array | undefined;
    if (this.cells && this.at >= from && this.at <= n) {
      cells = this.cells;
      from = this.at + 1;
    }
    for (let k = from; k <= n; k++) cells = decodeFrame(this.bytes[k]!, size, isKeyFrame(this.bytes[k]!) ? undefined : cells);
    this.cells = cells;
    this.at = n;

    const data = this.image.data;
    for (let i = 0; i < size; i++) {
      const [r, g, b] = this.colours[cells![i]!]!;
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.slider.value = String(n);
    const hours = this.steps[n]! / STEPS_PER_SECOND / 3600;
    this.when.textContent = hours >= 48 ? `day ${Math.floor(hours / 24) + 1}, ${Math.floor(hours % 24)}h` : `${hours.toFixed(1)}h`;
  }
}
