// Local game driver: one human empire against SimBots.
//
// Deliberately shaped like the lockstep driver that replaces it in Phase C —
// input is queued as moves for a future step and applied by advance(), never
// written straight into state. Swapping this for the mesh means changing where
// moves come from, not how the game runs.

import { Sim, makeGenesis, CLAIM, MOVE, MEMBER, CONTROL, STEPS_PER_SECOND } from "@tessera/sim";
import type { Move, EmpireSpec } from "@tessera/sim";

/** Never simulate more than this in one frame: a backgrounded tab must catch up
 *  without freezing the page when it returns. */
const MAX_STEPS_PER_FRAME = 240;

export interface LocalOptions {
  seed: number;
  bots: number;
  teammates: number;
  width: number;
  height: number;
}

export class LocalGame {
  sim: Sim;
  readonly empire = 1;
  readonly member = 0;
  running = true;

  private pending: Move[] = [];
  private seq = 0;
  private originWall = 0;
  private originStep = 0;

  constructor(readonly options: LocalOptions) {
    const empires: EmpireSpec[] = [
      {
        control: CONTROL.HUMAN,
        members: [
          { kind: MEMBER.HUMAN },
          ...Array.from({ length: options.teammates }, () => ({ kind: MEMBER.BOT })),
        ],
      },
      ...Array.from({ length: options.bots }, () => ({
        control: CONTROL.SIMBOT,
        members: [{ kind: MEMBER.BOT }],
      })),
    ];

    this.sim = new Sim(
      makeGenesis({
        seed: options.seed,
        empires,
        map: { width: options.width, height: options.height },
      }),
    );
    this.resetClock();
  }

  private resetClock(): void {
    this.originWall = performance.now();
    this.originStep = this.sim.step;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
    this.resetClock();
  }

  claim(x: number, y: number): boolean {
    return this.queue(CLAIM(0, this.empire, this.member, 0, x, y));
  }

  act(type: (typeof MOVE)[keyof typeof MOVE], x = 0, y = 0): boolean {
    return this.queue({ step: 0, empire: this.empire, member: this.member, seq: 0, type, x, y });
  }

  /** Queue for the next step. Rejected here only as UI feedback — the
   *  simulation validates again on apply, which is what actually decides. */
  private queue(move: Move): boolean {
    const candidate = { ...move, step: this.sim.step + 1, seq: this.seq };
    if (!this.sim.validate({ ...candidate, step: this.sim.step })) return false;
    this.seq++;
    this.pending.push(candidate);
    return true;
  }

  /** Advance to match wall-clock time. The world turns whether or not anyone is
   *  watching, so the step number is derived from elapsed real time rather than
   *  counted per frame. */
  tick(): Set<number> {
    const dirty = new Set<number>();
    if (!this.running || this.sim.ended) return dirty;

    const elapsed = performance.now() - this.originWall;
    const target = this.originStep + Math.floor((elapsed * STEPS_PER_SECOND) / 1000);
    let budget = MAX_STEPS_PER_FRAME;

    while (this.sim.step < target && budget-- > 0) {
      const step = this.sim.step;
      const due = this.pending.filter((m) => m.step <= step);
      if (due.length > 0) this.pending = this.pending.filter((m) => m.step > step);

      const heartbeat = this.heartbeatDue(step) ? [this.beat(step)] : [];
      for (const i of this.sim.advance([...due, ...heartbeat])) dirty.add(i);
    }

    // Fell too far behind to catch up honestly; re-anchor rather than spiral.
    if (this.sim.step < target) {
      this.originWall = performance.now();
      this.originStep = this.sim.step;
    }

    return dirty;
  }

  private heartbeatDue(step: number): boolean {
    return step % this.sim.state.genesis.rules.heartbeatInterval === 0;
  }

  private beat(step: number): Move {
    return {
      step,
      empire: this.empire,
      member: this.member,
      seq: this.seq++,
      type: MOVE.HEARTBEAT,
      x: 0,
      y: 0,
    };
  }
}
