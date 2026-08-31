// The Sim class — the interface the mesh codes against.
//
//   step(moves) -> dirtyIndices      hash() -> uint32
//   snapshot() -> ArrayBuffer        restore(buf)
//   validate(move) -> bool           fastForward(toStep)
//
// Fixed now so Phase C's lockstep driver drops on without reworking the sim,
// and so a stub sim can stand in for it while the mesh is built.

import { MOVE, ITEM, PHASE, CONTROL, MEMBER } from "./types.js";
import type { Genesis, Move, Item, MapConfig, Rules, EmpireSpec } from "./types.js";
import { DEFAULT_MAP, DEFAULT_RULES, PROTOCOL_VERSION } from "./constants.js";
import { PASSABLE } from "./constants.js";
import { EVENT } from "./events.js";
import { createState, snapshot, restore, hashState } from "./state.js";
import type { State } from "./state.js";
import { generate, scheduleSpawn } from "./mapgen.js";
import { accrue, applyMove, validate } from "./rules.js";
import type { DirtySet } from "./rules.js";
import { checkVictory } from "./victory.js";
import { policy } from "./policy.js";
import { summarise } from "./stats.js";
import type { EmpireSummary } from "./stats.js";

export interface GenesisInit {
  seed: number;
  gameId?: string;
  startedAt?: number;
  map?: Partial<MapConfig>;
  rules?: Partial<Rules>;
  empires: EmpireSpec[];
}

export function makeGenesis(init: GenesisInit): Genesis {
  return {
    protocol: PROTOCOL_VERSION,
    gameId: init.gameId,
    seed: init.seed >>> 0,
    startedAt: init.startedAt ?? 0,
    map: { ...DEFAULT_MAP, ...init.map },
    rules: { ...DEFAULT_RULES, ...init.rules },
    empires: init.empires,
  };
}

export class Sim {
  state: State;

  constructor(genesis: Genesis) {
    if (genesis.protocol !== PROTOCOL_VERSION) {
      // Refuse at the lobby rather than desyncing silently hours later.
      throw new Error(
        `sim protocol mismatch: genesis is v${genesis.protocol}, this build is v${PROTOCOL_VERSION}`,
      );
    }
    this.state = generate(createState(genesis));
  }

  get step(): number {
    return this.state.step;
  }

  get ended(): boolean {
    return this.state.phase === PHASE.ENDED;
  }

  hash(): number {
    return hashState(this.state);
  }

  snapshot(): ArrayBuffer {
    return snapshot(this.state);
  }

  restore(buffer: ArrayBuffer): void {
    restore(this.state, buffer);
  }

  validate(move: Move): boolean {
    return validate(this.state, move);
  }

  summary(): EmpireSummary[] {
    return summarise(this.state);
  }

  /** Advance exactly one step. `moves` are this step's inputs; invalid ones are
   *  dropped identically by every peer. Returns the tiles the renderer must
   *  repaint. */
  advance(moves: readonly Move[] = []): DirtySet {
    const state = this.state;
    const dirty: DirtySet = new Set();
    if (state.phase !== PHASE.PLAYING) return dirty;

    // 1. Player inputs, in a canonical order independent of arrival order.
    const ordered = moves
      .slice()
      .sort((a, b) => a.empire - b.empire || a.member - b.member || a.seq - b.seq);
    for (const move of ordered) {
      if (validate(state, move)) applyMove(state, move, dirty);
    }

    // 2. SimBot empires, derived from the shared RNG — zero bandwidth.
    this.runSimBots(dirty);

    // 3. Scheduled world events.
    this.runEvents(dirty);

    // 4. Accrual, victory, clock.
    accrue(state);
    checkVictory(state);
    state.step++;

    return dirty;
  }

  private runSimBots(dirty: DirtySet): void {
    const state = this.state;
    const interval = state.genesis.rules.botActionInterval;

    for (const empire of state.empires) {
      if (!empire.alive || empire.control !== CONTROL.SIMBOT) continue;
      // Stagger by empire id so bots do not all fire on the same step.
      if ((state.step + empire.id) % interval !== 0) continue;

      for (let m = 0; m < empire.members.length; m++) {
        empire.members[m]!.lastBeat = state.step; // a SimBot is always present
        const move = policy(state, empire, m, state.rng);
        if (move && validate(state, move)) applyMove(state, move, dirty);
      }
    }
  }

  private runEvents(dirty: DirtySet): void {
    const state = this.state;
    for (;;) {
      const event = state.events.poll(state.step);
      if (!event) break;
      if (event.type === EVENT.SPAWN) {
        this.spawnItem(dirty);
        scheduleSpawn(state, state.step);
      }
    }
  }

  /** Coins spawn only on NEUTRAL passable tiles. That is what makes farming
   *  work: enclose an area, leave neutral pockets inside it, and they keep
   *  producing. */
  private spawnItem(dirty: DirtySet): void {
    const state = this.state;
    const rules = state.genesis.rules;
    if (state.itemCount >= rules.maxItemsOnMap) return;

    const n = state.owner.length;
    // Bounded probe rather than a full scan, so spawning stays O(1) on any map
    // size. Always the same number of RNG draws.
    for (let attempt = 0; attempt < 24; attempt++) {
      const i = state.rng.int(n);
      if (state.owner[i] !== 0) continue;
      if (state.item[i] !== ITEM.NONE) continue;
      if (!PASSABLE[state.terrain[i]!]) continue;

      state.item[i] = state.rng.weighted(rules.coinWeights) as Item;
      state.itemCount++;
      dirty.add(i);
      return;
    }
  }

  /** Catch up to `toStep`, skipping steps where nothing can happen.
   *
   *  The world runs on wall-clock time, so a peer returning after six hours has
   *  ~260,000 steps to cover. Because world updates are scheduled events rather
   *  than per-tile scans, this is a few hundred events, not 260,000 map sweeps. */
  fastForward(toStep: number, moves: readonly Move[] = []): void {
    const state = this.state;
    const byStep = new Map<number, Move[]>();
    for (const m of moves) {
      const list = byStep.get(m.step);
      if (list) list.push(m);
      else byStep.set(m.step, [m]);
    }

    while (state.step < toStep && state.phase === PHASE.PLAYING) {
      this.advance(byStep.get(state.step) ?? []);
    }
  }
}

export const CLAIM = (
  step: number,
  empire: number,
  member: number,
  seq: number,
  x: number,
  y: number,
): Move => ({ step, empire, member, seq, type: MOVE.CLAIM, x, y });

export const HEARTBEAT = (
  step: number,
  empire: number,
  member: number,
  seq: number,
): Move => ({ step, empire, member, seq, type: MOVE.HEARTBEAT, x: 0, y: 0 });

export { MEMBER, CONTROL, MOVE };
