// A finished game, played back from its archive.
//
// The archive is the genesis record and every move the room stamped, so the
// sim reaches every state the players saw, at any speed. Nobody holds a seat:
// the board is drawn as a spectator sees it, and nothing can be sent.
//
// Seeking backwards replays from the start, so the driver keeps a snapshot
// every few game hours to start from instead. Forwards is just faster.

import { Sim, STEPS_PER_SECOND } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import type { Driver } from "./Driver";

export interface Archive {
  format: string;
  roomId: string;
  genesis: Genesis;
  moveLog: Array<{ move: Move; sig?: string }>;
  /** Where the game ended. */
  steps: number;
  hash?: string;
}

/** Game seconds per real second. */
export const SPEEDS = [1, 60, 600, 3600, 21600] as const;

/** Simulation time allowed per frame, so a fast replay stays responsive. */
const FRAME_BUDGET_MS = 12;
const KEEP_EVERY = STEPS_PER_SECOND * 3600 * 2;

export class ReplayGame implements Driver {
  readonly online = false;
  readonly empire = 0;
  readonly member = 0;
  running = true;
  sim: Sim;

  speed: number = SPEEDS[2];
  private byStep = new Map<number, Move[]>();
  private readonly kept = new Map<number, ArrayBuffer>();
  private originWall = performance.now();
  private originStep = 0;
  private repaint = true;

  constructor(readonly archive: Archive) {
    for (const { move } of archive.moveLog) {
      const list = this.byStep.get(move.step);
      if (list) list.push(move);
      else this.byStep.set(move.step, [move]);
    }
    this.sim = new Sim(archive.genesis);
    this.kept.set(0, this.sim.snapshot());
  }

  get end(): number {
    return this.archive.steps;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    if (this.sim.step >= this.end) this.seek(0);
    this.running = true;
    this.anchor();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.anchor();
  }

  /** Jump to a step: from the nearest kept snapshot at or before it. */
  seek(step: number): void {
    const target = Math.max(0, Math.min(step, this.end));
    if (target < this.sim.step || target - this.sim.step > KEEP_EVERY) {
      let from = 0;
      for (const at of this.kept.keys()) if (at <= target && at > from) from = at;
      if (from > this.sim.step || target < this.sim.step) {
        this.sim = new Sim(this.archive.genesis);
        this.sim.restore(this.kept.get(from)!.slice(0));
      }
    }
    this.run(target, Infinity);
    this.repaint = true;
    this.anchor();
  }

  claim(): boolean {
    return false;
  }

  act(): boolean {
    return false;
  }

  tick(): Set<number> {
    const dirty = this.repaint ? this.everything() : new Set<number>();
    this.repaint = false;
    if (!this.running) return dirty;
    const elapsed = performance.now() - this.originWall;
    const target = Math.min(this.end, this.originStep + Math.floor((elapsed * STEPS_PER_SECOND * this.speed) / 1000));
    for (const tile of this.run(target, FRAME_BUDGET_MS)) dirty.add(tile);
    // Behind and out of time: carry on from here rather than chase the clock.
    if (this.sim.step < target) this.anchor();
    if (this.sim.step >= this.end) this.running = false;
    return dirty;
  }

  status(): string {
    const hours = this.sim.step / STEPS_PER_SECOND / 3600;
    const at = hours >= 48 ? `day ${Math.floor(hours / 24) + 1}, ${Math.floor(hours % 24)}h` : `${hours.toFixed(1)}h`;
    const done = this.sim.step >= this.end ? " · the end" : "";
    return `Replay · ${at} · ×${this.speed}${done}`;
  }

  private run(target: number, budgetMs: number): Set<number> {
    const dirty = new Set<number>();
    const until = performance.now() + budgetMs;
    let n = 0;
    while (this.sim.step < target) {
      const step = this.sim.step;
      for (const tile of this.sim.advance(this.byStep.get(step) ?? [])) dirty.add(tile);
      if (this.sim.step % KEEP_EVERY === 0 && !this.kept.has(this.sim.step)) {
        this.kept.set(this.sim.step, this.sim.snapshot());
      }
      // The clock is read every 64 steps, not every step.
      if ((++n & 63) === 0 && performance.now() > until) break;
    }
    return dirty;
  }

  private everything(): Set<number> {
    const all = new Set<number>();
    for (let i = 0; i < this.sim.state.owner.length; i++) all.add(i);
    return all;
  }

  private anchor(): void {
    this.originWall = performance.now();
    this.originStep = this.sim.step;
  }
}
