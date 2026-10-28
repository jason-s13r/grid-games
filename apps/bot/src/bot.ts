// How a bot plays its seat.
//
// The same targeting policy a SimBot empire runs inside every client's
// simulation, applied to one seat from outside it. The difference is where the
// randomness comes from: a SimBot draws from the shared stream because every
// client re-derives its moves, while this bot's moves are signed and validated
// like anybody's, so it must not touch that stream and uses its own.
//
// It defends by default. A night-shift bot that attacked would take ground its
// team never chose to take, on a front nobody was awake to hold. That is a
// default rather than a limit; `play` says otherwise.

import { Rng, STEPS_PER_SECOND, policy, seedFrom, turnOf } from "@tessera/sim";
import type { BotProfile, Mode, Move, State } from "@tessera/sim";

export type Play = Mode | "cycle";
export const PLAYS: readonly Play[] = ["defend", "expand", "attack", "fortify", "heal", "sleep", "cycle"];

/** Who to walk towards while attacking: an empire number, the nearest front,
 *  or a choice that changes every two minutes. */
export type Target = "nearest" | "random" | "rotate" | number;

const ROTATE_STEPS = STEPS_PER_SECOND * 120;

export interface Seat {
  empire: number;
  member: number;
}

export interface BotOptions {
  /** Steps between actions. Floored at the game's own rule for bots. */
  interval?: number;
  mode?: Play;
  /** The cycle to run under `mode: "cycle"`. */
  profile?: BotProfile;
  target?: Target;
  /** Whether it plays right now; a resting bot keeps its seat and banks. */
  awake?: (now: number) => boolean;
  seed?: string;
  now?: () => number;
}

export class Bot {
  private readonly rng: Rng;
  private readonly mode: Play;
  private readonly profile?: BotProfile;
  private readonly target: Target;
  private readonly awake: (now: number) => boolean;
  private readonly now: () => number;
  private readonly interval: number;
  private actedAt = -Infinity;

  constructor(options: BotOptions = {}) {
    this.rng = new Rng(seedFrom(options.seed ?? "tessera-bot"));
    this.mode = options.mode ?? "defend";
    if (options.profile) this.profile = options.profile;
    this.target = options.target ?? "nearest";
    this.awake = options.awake ?? ((): boolean => true);
    this.now = options.now ?? Date.now;
    this.interval = options.interval ?? 0;
  }

  /** Whether it is resting under its schedule. */
  get resting(): boolean {
    return !this.awake(this.now());
  }

  /** The move to make now, or null when it is not this bot's turn, it is
   *  resting, or there is nothing worth doing. A turn is spent either way, so a
   *  bot with nothing legal to do waits rather than rescanning every step. */
  turn(state: State, seat: Seat): Move | null {
    const empire = state.empires[seat.empire - 1];
    if (!empire?.alive || !empire.members[seat.member]) return null;
    const floor = state.genesis.rules.botActionInterval;
    const tempo =
      this.mode === "cycle" ? turnOf(state, empire, seat.member, this.profile).interval : 0;
    const wait = Math.max(this.interval, tempo, floor);
    if (state.step - this.actedAt < wait) return null;
    this.actedAt = state.step;
    if (!this.awake(this.now())) return null;

    const mode = this.mode === "cycle" ? undefined : this.mode;
    return policy(state, empire, seat.member, this.rng, mode, this.focus(state, seat.empire), this.profile);
  }

  private focus(state: State, ours: number): number | undefined {
    if (this.target === "nearest") return undefined;
    if (typeof this.target === "number") return this.target;
    const enemies = state.empires.filter((one) => one.alive && one.id !== ours);
    if (enemies.length === 0) return undefined;
    if (this.target === "random") return enemies[this.rng.int(enemies.length)]!.id;
    return enemies[Math.floor(state.step / ROTATE_STEPS) % enemies.length]!.id;
  }
}

/** "22-07" as a predicate on local time: wraps midnight. */
export function hoursWindow(spec: string): ((now: number) => boolean) | string {
  const match = spec.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return "--hours takes a range like 22-07";
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from > 23 || to > 24) return "--hours are 0 to 24";
  return (now) => {
    const hour = new Date(now).getHours();
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  };
}

/** "20/40": play 20 minutes in every 60. */
export function dutyCycle(spec: string): ((now: number) => boolean) | string {
  const match = spec.match(/^(\d+)\/(\d+)$/);
  if (!match) return "--duty takes on/off minutes like 20/40";
  const on = Number(match[1]) * 60_000;
  const period = on + Number(match[2]) * 60_000;
  if (period <= 0) return "--duty needs some time in it";
  return (now) => now % period < on;
}
