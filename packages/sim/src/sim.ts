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
import { idx, xOf, yOf } from "./geometry.js";
import { createState, snapshot, restore, hashState } from "./state.js";
import type { State } from "./state.js";
import { generate, scheduleSpawn, scheduleUpkeep } from "./mapgen.js";
import { upkeep } from "./upkeep.js";
import { accrue, applyMove, validate } from "./rules.js";
import type { DirtySet } from "./rules.js";
import { checkVictory } from "./victory.js";
import { policy, turnOf } from "./policy.js";
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
    const floor = state.genesis.rules.botActionInterval;

    for (const empire of state.empires) {
      if (!empire.alive || empire.control !== CONTROL.SIMBOT) continue;

      for (let m = 0; m < empire.members.length; m++) {
        empire.members[m]!.lastBeat = state.step; // a SimBot is always present

        // The profile is read from the genesis record rather than held in
        // state, because a SimBot empire only ever exists in one: an amendment
        // needs a quorum of keyed seats to endorse it and a SimBot empire has
        // none, so nothing can be voted into one.
        const profile = state.genesis.empires[empire.id - 1]?.members[m]?.bot;
        const turn = turnOf(state, empire, m, profile);
        if (turn.mode === "sleep") continue;

        // Never faster than the rules allow, whatever a phase asks for: an
        // always-on seat must not out-reflex the people it plays against.
        const interval = Math.max(turn.interval, floor);
        if ((state.step - turn.since) % interval !== 0) continue;

        const move = policy(state, empire, m, state.rng, undefined, undefined, profile);
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
      } else if (event.type === EVENT.UPKEEP) {
        upkeep(state, dirty);
        scheduleUpkeep(state, state.step);
      }
    }
  }

  /** Coins spawn only on NEUTRAL passable tiles. That is what makes farming
   *  work: enclose an area, leave neutral pockets inside it, and they keep
   *  producing.
   *
   *  Uniform placement across the whole map put most coins in empty country
   *  nobody was fighting over, so the shop stayed out of reach and the
   *  cascade — the best thing in the game — hardly ever fired. Most probes now
   *  land on an owned tile and hop a few tiles off it, which lands them just
   *  outside somebody's border: near the fighting, still neutral, still
   *  farmable by whoever encloses the pocket. A minority stay uniform so the
   *  far map is not dead ground.
   *
   *  Four draws per attempt whatever the branch, so the RNG stream is a
   *  function of state alone. */
  private spawnItem(dirty: DirtySet): void {
    const state = this.state;
    const rules = state.genesis.rules;
    if (state.itemCount >= rules.maxItemsOnMap) return;

    const { width, height } = state;
    const n = state.owner.length;
    const r = rules.coinNearRadius;

    // Bounded probe rather than a full scan, so spawning stays O(1) on any map
    // size.
    for (let attempt = 0; attempt < 24; attempt++) {
      const seed = state.rng.int(n);
      const near = state.rng.int(100) < rules.coinNearBias;
      const dx = state.rng.range(-r, r);
      const dy = state.rng.range(-r, r);

      let i = seed;
      if (near && state.owner[seed] !== 0) {
        const x = Math.max(0, Math.min(width - 1, xOf(seed, width) + dx));
        const y = Math.max(0, Math.min(height - 1, yOf(seed, width) + dy));
        i = idx(x, y, width);
      }

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
