// Game rules. validate() is the entire anti-cheat story: it is a pure function
// run by every peer, so an illegal move dies identically everywhere with no
// trust and no negotiation.

import { MOVE, ITEM, TERRAIN, MEMBER, PHASE, ELIMINATION } from "./types.js";
import type { Empire, Member, Move, EmpireId, Item } from "./types.js";
import { PASSABLE, COIN_RADIUS, STAT } from "./constants.js";
import { ORTHO, vonNeumannBall, idx, xOf, yOf, inBounds } from "./geometry.js";
import { bump, raise } from "./stats.js";
import type { State } from "./state.js";

export type DirtySet = Set<number>;

export const passable = (state: State, i: number): boolean =>
  PASSABLE[state.terrain[i]!]!;

/** Ownership changes are the only place tilesOwned moves, so the counter can
 *  never drift from the board. */
export function setOwner(state: State, i: number, next: EmpireId): void {
  const prev = state.owner[i]!;
  if (prev === next) return;
  if (prev > 0) state.empires[prev - 1]!.tilesOwned--;
  if (next > 0) state.empires[next - 1]!.tilesOwned++;
  state.owner[i] = next;
}

/** Protection lifts on the tile threshold OR the timer, whichever lands first. */
export function isProtected(state: State, empire: Empire): boolean {
  const rules = state.genesis.rules;
  return empire.tilesOwned < rules.noobTiles && state.step < rules.noobSteps;
}

/** A protected capital absorbs nothing — not from a direct claim, and not from
 *  a cascade sweeping over it. */
function isShielded(state: State, i: number, attacker: EmpireId): boolean {
  const owner = state.owner[i]!;
  if (owner === 0 || owner === attacker) return false;
  const empire = state.empires[owner - 1]!;
  return empire.capital === i && isProtected(state, empire);
}

function addPop(state: State, empireId: EmpireId, delta: number): void {
  if (empireId <= 0) return;
  const empire = state.empires[empireId - 1]!;
  empire.popTotal = Math.max(0, empire.popTotal + delta);
}

/** The generalisation of the prototype's `cells[x][y] += power`, with ownership
 *  in its own layer so it works for N empires. Returns true if the tile changed
 *  hands to `empireId`. */
export function place(
  state: State,
  i: number,
  empireId: EmpireId,
  amount: number,
  dirty: DirtySet,
): boolean {
  if (amount <= 0) return false;
  if (isShielded(state, i, empireId)) return false;

  const prev = state.owner[i]!;
  const before = state.pop[i]!;
  let captured = false;

  if (prev === empireId || (prev === 0 && before === 0)) {
    state.pop[i] = before + amount;
    addPop(state, empireId, amount);
    if (prev !== empireId) {
      setOwner(state, i, empireId);
      captured = true;
    }
  } else {
    const after = before - amount;
    if (after < 0) {
      addPop(state, prev, -before);
      state.pop[i] = -after;
      setOwner(state, i, empireId);
      addPop(state, empireId, -after);
      captured = true;
    } else {
      state.pop[i] = after;
      addPop(state, prev, -amount);
      if (after === 0) setOwner(state, i, 0);
    }
  }

  dirty.add(i);
  if (captured && prev > 0) {
    const victim = state.empires[prev - 1]!;
    if (victim.alive && victim.capital === i) annex(state, victim, empireId, dirty);
  }
  return captured;
}

/** Taking a capital takes the empire with it.
 *
 *  Under CAPITAL elimination the victim is finished the moment its capital
 *  falls — checkVictory would mark it dead on this same step. Leaving its
 *  tiles on the board as an ownerless rump made the decisive blow feel like
 *  nothing: the map barely changed and the population was simply deleted.
 *  Annexing pays the attacker the whole empire, which is what makes a capital
 *  worth the assault and worth defending.
 *
 *  Under ANNIHILATION the capital is an ordinary tile and none of this
 *  applies. */
function annex(
  state: State,
  victim: Empire,
  toId: EmpireId,
  dirty: DirtySet,
): void {
  if (state.genesis.rules.elimination !== ELIMINATION.CAPITAL) return;
  const heir = state.empires[toId - 1];
  if (!heir) return;

  let taken = 0;
  let population = 0;
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] !== victim.id) continue;
    population += state.pop[i]!;
    setOwner(state, i, toId);
    dirty.add(i);
    taken++;
  }

  victim.popTotal = Math.max(0, victim.popTotal - population);
  heir.popTotal += population;

  // Unspent stock is spoils too — a hoard of diamonds should not evaporate
  // with the empire that never got to spend it.
  heir.diamonds += victim.diamonds;
  heir.bridges += victim.bridges;
  heir.ladders += victim.ladders;
  victim.diamonds = 0;
  victim.bridges = 0;
  victim.ladders = 0;

  victim.alive = 0;
  victim.eliminatedAt = state.step;

  bump(heir, null, STAT.ANNEXED, taken);
  raise(heir, null, STAT.PEAK_TILES, heir.tilesOwned);
  raise(heir, null, STAT.PEAK_POP, heir.popTotal);
}

/** Count of the target's orthogonal neighbours owned by the acting empire,
 *  clamped to 1..maxMultiplier. Surround a tile on four sides and 999 becomes
 *  3996. */
export function multiplier(
  state: State,
  x: number,
  y: number,
  empireId: EmpireId,
): number {
  let count = 0;
  for (const [dx, dy] of ORTHO) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, state.width, state.height)) continue;
    if (state.owner[idx(nx, ny, state.width)] === empireId) count++;
  }
  return Math.max(1, Math.min(count, state.genesis.rules.maxMultiplier));
}

export function adjacentToOwned(
  state: State,
  x: number,
  y: number,
  empireId: EmpireId,
): boolean {
  for (const [dx, dy] of ORTHO) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, state.width, state.height)) continue;
    if (state.owner[idx(nx, ny, state.width)] === empireId) return true;
  }
  return false;
}

// --- validation --------------------------------------------------------------

export function validate(state: State, move: Move): boolean {
  if (state.phase !== PHASE.PLAYING) return false;

  const empire = state.empires[move.empire - 1];
  if (!empire || !empire.alive) return false;
  const member = empire.members[move.member];
  if (!member) return false;

  const rules = state.genesis.rules;

  if (move.type === MOVE.PASS || move.type === MOVE.HEARTBEAT) return true;
  if (move.type === MOVE.ROSTER_AMEND) return empire.members.length < 32;
  if (move.type === MOVE.BUY_BRIDGE) return empire.diamonds >= rules.bridgeCost;
  if (move.type === MOVE.BUY_LADDER) return empire.diamonds >= rules.ladderCost;

  if (!inBounds(move.x, move.y, state.width, state.height)) return false;
  const i = idx(move.x, move.y, state.width);

  if (move.type === MOVE.PLACE_BRIDGE) {
    return (
      empire.bridges > 0 &&
      state.terrain[i] === TERRAIN.RIVER &&
      adjacentToOwned(state, move.x, move.y, empire.id)
    );
  }
  if (move.type === MOVE.PLACE_LADDER) {
    return (
      empire.ladders > 0 &&
      state.terrain[i] === TERRAIN.WALL &&
      adjacentToOwned(state, move.x, move.y, empire.id)
    );
  }

  if (move.type === MOVE.CLAIM) {
    if (!passable(state, i)) return false;
    if (member.popTimer <= 0) return false;
    if (isShielded(state, i, empire.id)) return false;
    if (state.owner[i] === empire.id) return true;
    return adjacentToOwned(state, move.x, move.y, empire.id);
  }

  return false;
}

// --- application -------------------------------------------------------------

export function applyMove(state: State, move: Move, dirty: DirtySet): void {
  const empire = state.empires[move.empire - 1]!;
  const member = empire.members[move.member]!;
  const rules = state.genesis.rules;

  bump(empire, member, STAT.MOVES);

  switch (move.type) {
    case MOVE.HEARTBEAT:
      member.lastBeat = state.step;
      return;

    case MOVE.PASS:
      return;

    case MOVE.BUY_BRIDGE:
      empire.diamonds -= rules.bridgeCost;
      empire.bridges++;
      return;

    case MOVE.BUY_LADDER:
      empire.diamonds -= rules.ladderCost;
      empire.ladders++;
      return;

    case MOVE.PLACE_BRIDGE: {
      const i = idx(move.x, move.y, state.width);
      state.terrain[i] = TERRAIN.RIVER_BRIDGED;
      empire.bridges--;
      bump(empire, member, STAT.BRIDGES);
      dirty.add(i);
      return;
    }

    case MOVE.PLACE_LADDER: {
      const i = idx(move.x, move.y, state.width);
      state.terrain[i] = TERRAIN.WALL_LADDERED;
      empire.ladders--;
      bump(empire, member, STAT.LADDERS);
      dirty.add(i);
      return;
    }

    case MOVE.ROSTER_AMEND:
      // Quorum of signatures is verified by the net layer before the move
      // reaches the sim; here it is a deterministic roster append.
      empire.members.push({
        kind: move.x === MEMBER.BOT ? MEMBER.BOT : MEMBER.HUMAN,
        popTimer: 0,
        popAcc: 0,
        lastBeat: state.step,
        joinedAt: state.step,
        stats: new Uint32Array(member.stats.length),
      });
      return;

    case MOVE.CLAIM:
      claim(state, move, empire, member, dirty);
      return;
  }
}

function claim(
  state: State,
  move: Move,
  empire: Empire,
  member: Member,
  dirty: DirtySet,
): void {
  const i = idx(move.x, move.y, state.width);
  const mult = multiplier(state, move.x, move.y, empire.id);
  const spent = member.popTimer;
  const base = spent * mult;

  bump(empire, member, STAT.POP_SPENT, spent);
  member.popTimer = 0;
  member.popAcc = 0;

  const item = state.item[i]! as Item;
  if (item !== ITEM.NONE && item !== ITEM.DIAMOND) {
    cascade(state, i, item, base, empire, member, dirty);
  } else {
    if (item === ITEM.DIAMOND) collectDiamond(state, i, empire, member);
    const captured = place(state, i, empire.id, base, dirty);
    if (captured) {
      bump(empire, member, STAT.TILES_TAKEN);
      raise(empire, member, STAT.TILES_ONE_MOVE, 1);
    }
  }

  raise(empire, null, STAT.PEAK_TILES, empire.tilesOwned);
  raise(empire, null, STAT.PEAK_POP, empire.popTotal);
}

/** Coin cascade.
 *
 *  A triggered coin spreads the SAME per-tile population across its own full
 *  shape — population is created by the cascade, not divided. That is what
 *  makes farming an enclosed field explosive, and what turns a chain into a
 *  sudden jump in tile count.
 *
 *  A coin is cleared the moment it is queued, so it can fire at most once. */
function cascade(
  state: State,
  origin: number,
  originItem: Item,
  base: number,
  empire: Empire,
  member: Member,
  dirty: DirtySet,
): void {
  const { width, height } = state;
  const rules = state.genesis.rules;

  const shape = vonNeumannBall(COIN_RADIUS[originItem]!);
  const perTile = Math.floor(base / shape.length);
  // The remainder lands on the coin tile itself, so nothing is lost and the
  // split stays deterministic.
  const remainder = base - perTile * shape.length;

  const maxDepth =
    member.kind === MEMBER.BOT ? rules.botCascadeDepth : Number.MAX_SAFE_INTEGER;

  takeCoin(state, origin, originItem, empire, member);

  const queue: Array<[number, number, number]> = [
    [origin, COIN_RADIUS[originItem]!, 0],
  ];
  let head = 0;
  let touched = 0;
  let captured = 0;
  let popPlaced = 0;

  while (head < queue.length && touched < rules.cascadeTileCap) {
    const [ci, cr, depth] = queue[head++]!;
    const cx = xOf(ci, width);
    const cy = yOf(ci, width);

    for (const [dx, dy] of vonNeumannBall(cr)) {
      if (touched >= rules.cascadeTileCap) break;

      const tx = cx + dx;
      const ty = cy + dy;
      if (!inBounds(tx, ty, width, height)) continue;
      const ti = idx(tx, ty, width);
      if (!passable(state, ti)) continue;

      const found = state.item[ti]! as Item;
      if (found === ITEM.DIAMOND) {
        collectDiamond(state, ti, empire, member);
      } else if (found !== ITEM.NONE && depth < maxDepth) {
        takeCoin(state, ti, found, empire, member);
        queue.push([ti, COIN_RADIUS[found]!, depth + 1]);
      }

      const amount = perTile + (ti === origin ? remainder : 0);
      if (place(state, ti, empire.id, amount, dirty)) captured++;
      popPlaced += amount;
      touched++;
    }
  }

  bump(empire, member, STAT.TILES_TAKEN, captured);
  raise(empire, member, STAT.TILES_ONE_MOVE, captured);
  raise(empire, member, STAT.CASCADE_TILES, touched);
  raise(empire, member, STAT.CASCADE_POP, popPlaced);
}

const COIN_STAT: Record<number, number> = {
  [ITEM.BRONZE]: STAT.COINS_BRONZE,
  [ITEM.SILVER]: STAT.COINS_SILVER,
  [ITEM.GOLD]: STAT.COINS_GOLD,
};

function takeCoin(
  state: State,
  i: number,
  item: Item,
  empire: Empire,
  member: Member,
): void {
  state.item[i] = ITEM.NONE;
  state.itemCount--;
  const slot = COIN_STAT[item];
  if (slot !== undefined) bump(empire, member, slot);
}

function collectDiamond(
  state: State,
  i: number,
  empire: Empire,
  member: Member,
): void {
  state.item[i] = ITEM.NONE;
  state.itemCount--;
  empire.diamonds++;
  bump(empire, member, STAT.DIAMONDS);
}

/** Per-member accrual, integer only — no float drift. Three teammates means
 *  three independent click streams into one shared empire, which is what
 *  produces simultaneous battle fronts. */
export function accrue(state: State): void {
  const rules = state.genesis.rules;
  for (const empire of state.empires) {
    if (!empire.alive) continue;
    for (const m of empire.members) {
      const bot = m.kind === MEMBER.BOT;
      const num = bot ? rules.botPopRateNum : rules.popRateNum;
      const den = bot ? rules.botPopRateDen : rules.popRateDen;
      const cap = bot ? rules.botPopMax : rules.popMax;

      m.popAcc += num;
      while (m.popAcc >= den) {
        m.popAcc -= den;
        if (m.popTimer < cap) m.popTimer++;
      }
    }
  }
}
