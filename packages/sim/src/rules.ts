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
  // What they learned outlives the empire that learned it.
  heir.marchUnlocked = heir.marchUnlocked || victim.marchUnlocked;
  heir.growthUnlocked = heir.growthUnlocked || victim.growthUnlocked;
  victim.diamonds = 0;
  victim.bridges = 0;
  victim.ladders = 0;

  victim.alive = 0;
  victim.eliminatedAt = state.step;

  bump(heir, null, STAT.ANNEXED, taken);
  raise(heir, null, STAT.PEAK_TILES, heir.tilesOwned);
  raise(heir, null, STAT.PEAK_POP, heir.popTotal);
}

/** The tile a march passes through: orthogonally beside the target, passable,
 *  and itself on the empire's border. Lowest flat index wins, so two peers
 *  never pick different halves of the same move. */
export function marchVia(
  state: State,
  x: number,
  y: number,
  empireId: EmpireId,
): number {
  let best = -1;
  for (const [dx, dy] of ORTHO) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, state.width, state.height)) continue;
    const ni = idx(nx, ny, state.width);
    if (!passable(state, ni)) continue;
    if (isShielded(state, ni, empireId)) continue;
    if (!adjacentToOwned(state, nx, ny, empireId)) continue;
    if (best < 0 || ni < best) best = ni;
  }
  return best;
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
  // Refused once it is already owned: it is permanent, and letting an empire
  // spend six diamonds on nothing is a trap, not a decision.
  if (move.type === MOVE.BUY_MARCH) {
    return !empire.marchUnlocked && empire.diamonds >= rules.marchCost;
  }
  if (move.type === MOVE.BUY_GROWTH) {
    return !empire.growthUnlocked && empire.diamonds >= rules.growthCost;
  }

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

  if (move.type === MOVE.MARCH) {
    if (!empire.marchUnlocked) return false;
    if (member.popTimer <= 0) return false;
    if (!passable(state, i)) return false;
    if (isShielded(state, i, empire.id)) return false;
    // Strictly a reach extender. A tile already on the border is an ordinary
    // claim, and spending a march on one would be a silent waste.
    if (adjacentToOwned(state, move.x, move.y, empire.id)) return false;
    return marchVia(state, move.x, move.y, empire.id) >= 0;
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

    case MOVE.BUY_MARCH:
      empire.diamonds -= rules.marchCost;
      empire.marchUnlocked = 1;
      return;

    case MOVE.BUY_GROWTH:
      empire.diamonds -= rules.growthCost;
      empire.growthUnlocked = 1;
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

    case MOVE.MARCH:
      march(state, move, empire, member, dirty);
      return;
  }
}

/** Two tiles from one spend.
 *
 *  The population is shared, not doubled: the same base is split between the
 *  tile passed through and the tile landed on, so a march buys reach rather
 *  than force — permanently, which is why it costs twice what a bridge does. The multiplier is read at the intermediate tile because that is
 *  where the empire's border actually is — the target has no owned neighbours
 *  by construction.
 *
 *  Items are left where they lie. A march onto a coin ends with the coin on a
 *  tile the empire now owns, claimable next turn for a full cascade, which is
 *  a better play than a cascade the march would have spent half its population
 *  on. */
function march(
  state: State,
  move: Move,
  empire: Empire,
  member: Member,
  dirty: DirtySet,
): void {
  const target = idx(move.x, move.y, state.width);
  const via = marchVia(state, move.x, move.y, empire.id);
  if (via < 0) return;

  const mult = multiplier(state, xOf(via, state.width), yOf(via, state.width), empire.id);
  const spent = member.popTimer;
  const base = spent * mult;

  bump(empire, member, STAT.POP_SPENT, spent);
  bump(empire, member, STAT.MARCHES);
  member.popTimer = 0;
  member.popAcc = 0;

  const half = Math.floor(base / 2);
  let captured = 0;
  if (place(state, via, empire.id, half, dirty)) captured++;
  if (place(state, target, empire.id, base - half, dirty)) captured++;

  bump(empire, member, STAT.TILES_TAKEN, captured);
  raise(empire, member, STAT.TILES_ONE_MOVE, captured);
  raise(empire, null, STAT.PEAK_TILES, empire.tilesOwned);
  raise(empire, null, STAT.PEAK_POP, empire.popTotal);
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
    // The click lands as an ordinary claim first, and the coin spreads on top.
    //
    // It used to be one or the other: a coin consumed the claim and
    // redistributed it, which meant clicking a coin put *less* on the tile you
    // clicked than clicking a plain tile would have. A full bank on a bronze
    // coin placed 203 there instead of 999. On contested ground that made a
    // coin a downgrade — the opposite of a reward.
    const took = place(state, i, empire.id, base, dirty);
    if (took) {
      bump(empire, member, STAT.TILES_TAKEN);
      raise(empire, member, STAT.TILES_ONE_MOVE, 1);
    }
    // Spent, not base: the surround multiplier is a fact about the tile you
    // clicked and it has already been paid on the claim above. The coin's own
    // multiplier is a fact about its shape, applied per tile inside cascade.
    cascade(state, i, item, spent, empire, member, dirty);
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
 *  Each tile of the shape then carries the surround multiplier it has earned
 *  *within* that shape: a tile whose four orthogonal neighbours are also being
 *  claimed is being surrounded, and the game has always said a surrounded tile
 *  takes four times the population. Read off the shape rather than off live
 *  ownership, so it cannot depend on the order tiles happen to be visited in.
 *
 *  That is what separates the coins by more than area. Bronze has no interior
 *  beyond its own tile, so its arms are single strength; a gold coin is thirteen
 *  interior tiles at quadruple and twelve rim tiles at less. The rarest coin is
 *  the one whose middle is worth having.
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
  // Never zero. A gold coin spreads across twenty-five tiles, so a trigger with
  // less than that much population divided to nothing per tile — and place()
  // refuses an amount of zero, so the coin claimed nothing whatsoever, not even
  // the empty ground it was sitting in the middle of. One population is enough
  // to take a neutral tile, which is the least a coin should ever do.
  const perTile = Math.max(1, Math.floor(base / shape.length));

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

      const amount = perTile * surroundedBy(dx, dy, cr);
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

/** How many of a tile's orthogonal neighbours are also inside the ball it
 *  belongs to, clamped the way the surround multiplier always is.
 *
 *  Geometry, not ownership: everything in the ball is about to be claimed, so a
 *  tile with all four neighbours inside it is being surrounded on all four
 *  sides. Deriving it from the offset means it is the same number on every peer
 *  regardless of what each has already painted. */
function surroundedBy(dx: number, dy: number, radius: number): number {
  let inside = 0;
  for (const [ex, ey] of ORTHO) {
    if (Math.abs(dx + ex) + Math.abs(dy + ey) <= radius) inside++;
  }
  return Math.max(1, Math.min(inside, MAX_COIN_MULTIPLIER));
}

/** The same ceiling the ordinary surround multiplier uses. Named separately
 *  because this one is geometric and could never exceed four anyway; the
 *  clamp is here so the two rules cannot drift apart silently. */
const MAX_COIN_MULTIPLIER = 4;

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
