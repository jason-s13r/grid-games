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
import {
  DEFAULT_MAP,
  DEFAULT_RULES,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  playsProtocol,
} from "./constants.js";
import { PASSABLE } from "./constants.js";
import { EVENT } from "./events.js";
import { idx, xOf, yOf } from "./geometry.js";
import { createState, snapshot, restore, hashState, rebuildShields } from "./state.js";
import type { State } from "./state.js";
import { generate, scheduleSpawn, scheduleUpkeep } from "./mapgen.js";
import { upkeep } from "./upkeep.js";
import { accrue, applyMove, validate } from "./rules.js";
import type { DirtySet } from "./rules.js";
import { checkVictory } from "./victory.js";
import { policy, turnOf } from "./policy.js";
import { summarise } from "./stats.js";
import { isCoin, isV5 } from "./v5.js";
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
    map: { ...mapFor(init.map?.width ?? DEFAULT_MAP.width, init.map?.height ?? DEFAULT_MAP.height), ...init.map },
    rules: {
      ...DEFAULT_RULES,
      ...coinsFor(init.map?.width ?? DEFAULT_MAP.width, init.map?.height ?? DEFAULT_MAP.height),
      ...init.rules,
    },
    empires: init.empires,
  };
}

/** The default map's features, scaled to a map of this size.
 *
 *  The defaults were set for 96 by 64. A larger map with the same fourteen
 *  mountains is open plain with a few hills in it, and from v5 the mountains
 *  are where the diamonds are. So mountains, lakes and walls scale with the
 *  area, and rivers, which run edge to edge, with the side. At the default
 *  size this is the default map exactly. */
export function mapFor(width: number, height: number): MapConfig {
  const area = (width * height) / (DEFAULT_MAP.width * DEFAULT_MAP.height);
  const side = Math.sqrt(area);
  const scale = (n: number, by: number) => Math.max(n > 0 ? 1 : 0, Math.round(n * by));
  return {
    ...DEFAULT_MAP,
    width,
    height,
    mountains: scale(DEFAULT_MAP.mountains, area),
    lakes: scale(DEFAULT_MAP.lakes, area),
    walls: scale(DEFAULT_MAP.walls, area),
    rivers: scale(DEFAULT_MAP.rivers, side),
    riverGaps: scale(DEFAULT_MAP.riverGaps, side),
  };
}

/** Whether open ground at `i` is walled in by one empire: see spawnInFarm. */
function enclosed(state: State, i: number, reach: number): boolean {
  const { width, height, owner, terrain } = state;
  const x0 = xOf(i, width);
  const y0 = yOf(i, width);
  let wall = 0;
  let hits = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let met = false;
    for (let k = 1; k <= reach; k++) {
      const x = x0 + dx * k;
      const y = y0 + dy * k;
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const j = idx(x, y, width);
      const o = owner[j]!;
      if (o > 0) {
        if (wall === 0) wall = o;
        else if (o !== wall) return false;
        hits++;
        met = true;
        break;
      }
      if (!PASSABLE[terrain[j]!]) {
        met = true;
        break;
      }
    }
    if (!met) return false;
  }
  return hits >= 2;
}

/** How often coins appear for a map of this size, and how many may lie about.
 *  The interval is set for 96 by 64. A bigger map gets coins more often, by
 *  the square root of its area: with no cap, coins at a rate in proportion to
 *  the area carpeted a medium map and a two-hour bot game ended with 92% of it
 *  taken; at the square root it is about half.
 *
 *  And no cap short of the map itself: coins keep coming until there is no
 *  open ground left to put one on. The old cap of 360 (DEFAULT_RULES, which
 *  games composed before this still carry) was reached within the hour on
 *  anything but the smallest map, and from then on a farm only refilled as
 *  fast as somebody somewhere took a coin. */
export function coinsFor(width: number, height: number): Pick<Rules, "coinIntervalMin" | "coinIntervalMax" | "maxItemsOnMap"> {
  const faster = Math.sqrt((width * height) / (DEFAULT_MAP.width * DEFAULT_MAP.height));
  return {
    coinIntervalMin: Math.max(1, Math.round(DEFAULT_RULES.coinIntervalMin / faster)),
    coinIntervalMax: Math.max(2, Math.round(DEFAULT_RULES.coinIntervalMax / faster)),
    maxItemsOnMap: width * height,
  };
}

export class Sim {
  state: State;

  constructor(genesis: Genesis) {
    if (!playsProtocol(genesis.protocol)) {
      // Refuse at the lobby rather than desyncing silently hours later. The
      // message names the whole set: a one-number message on a build that
      // plays two is a lie.
      throw new Error(
        `sim protocol mismatch: genesis is v${genesis.protocol}, this build plays v${SUPPORTED_PROTOCOLS.join(", v")}`,
      );
    }
    this.state = generate(createState(genesis));
    // After the map generator, because the shields are around capitals and
    // `placeCapitals` is what decides where those are.
    rebuildShields(this.state);
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

    if (isV5(state)) return this.spawnNear(dirty);

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

  /** Spawning from v5. One draw decides whether this coin lands near
   *  something or anywhere: `coinNearBias` percent of coins land near an owned
   *  tile or another coin, and the rest anywhere. A coin meant to land near
   *  something keeps probing until a probe finds an owned tile or a coin to hop
   *  off, rather than landing wherever the first probe fell, which is what
   *  made v4's share of coins near the fighting small while empires were.
   *
   *  So coins gather near empires and near one another, a cluster grows, and
   *  ground that encloses one is worth farming. Diamonds no longer spawn: they
   *  come from mines.
   *
   *  Three draws per probe whatever happens, so the stream is a function of
   *  state alone; at most 64 probes, so it stays O(1) on any map. */
  private spawnNear(dirty: DirtySet): void {
    const state = this.state;
    const rules = state.genesis.rules;
    const { width, height } = state;
    const n = state.owner.length;
    const r = rules.coinNearRadius;
    const weights = rules.coinWeights.filter(([item]) => item !== ITEM.DIAMOND);
    // A game composed with `coinFarmShare` also puts an extra coin into a farm
    // (open ground an empire has walled in) on that share of spawns, on top of
    // the usual one. Drawn only in such a game, so a game composed before it
    // keeps its stream.
    const farms = rules.coinFarmShare ?? 0;
    if (farms > 0 && state.rng.int(100) < farms) {
      this.spawnInFarm(dirty, weights);
      if (state.itemCount >= rules.maxItemsOnMap) return;
    }
    const near = state.rng.int(100) < rules.coinNearBias;

    for (let probe = 0; probe < 64; probe++) {
      const seed = state.rng.int(n);
      const dx = state.rng.range(-r, r);
      const dy = state.rng.range(-r, r);

      let i = seed;
      if (near) {
        if (state.owner[seed] === 0 && !isCoin(state.item[seed]!)) continue;
        const x = Math.max(0, Math.min(width - 1, xOf(seed, width) + dx));
        const y = Math.max(0, Math.min(height - 1, yOf(seed, width) + dy));
        i = idx(x, y, width);
      }

      if (state.owner[i] !== 0) continue;
      if (state.item[i] !== ITEM.NONE) continue;
      if (!PASSABLE[state.terrain[i]!]) continue;

      state.item[i] = state.rng.weighted(weights) as Item;
      state.itemCount++;
      dirty.add(i);
      return;
    }
  }

  /** An extra coin on open ground inside a farm, if a few probes find one. One draw
   *  per probe, and the test is local: from the tile, each of the four straight
   *  lines must meet the same empire's ground or impassable terrain within
   *  `coinFarmReach` steps, at least two of them the empire. Not a flood fill,
   *  which would cost the whole map on every coin. A farm that is a field
   *  walled on all sides passes; open country, and ground between two
   *  empires, does not. */
  private spawnInFarm(dirty: DirtySet, weights: Array<[Item, number]>): boolean {
    const state = this.state;
    const n = state.owner.length;
    const reach = state.genesis.rules.coinFarmReach ?? 16;
    for (let probe = 0; probe < 64; probe++) {
      const i = state.rng.int(n);
      if (state.owner[i] !== 0 || state.item[i] !== ITEM.NONE || !PASSABLE[state.terrain[i]!]) continue;
      if (!enclosed(state, i, reach)) continue;
      state.item[i] = state.rng.weighted(weights) as Item;
      state.itemCount++;
      dirty.add(i);
      return true;
    }
    return false;
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
