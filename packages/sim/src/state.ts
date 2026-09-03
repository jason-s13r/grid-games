// Simulation state: four flat typed-array layers plus empire records.
//
// The old cells[x][y] packed owner AND population into one signed integer,
// which capped the game at two players and left nowhere for terrain, coins or
// diamonds on the same tile. Splitting ownership into its own layer is what
// unlocks N empires and neutral-but-populated tiles.
//
// snapshot() is the single canonical serialisation. Both the consensus hash and
// checkpoint storage are built on it.

import { PHASE, WIN, MEMBER, CONTROL } from "./types.js";
import type { Empire, Genesis, Phase, WinReason, EmpireId, MemberIndex, Member } from "./types.js";
import { STAT_SLOTS } from "./constants.js";
import { EventQueue } from "./events.js";
import type { EventType } from "./events.js";
import { Rng } from "./rng.js";
import { fnv1a } from "./hash.js";

const MAGIC = 0x54455353; // "TESS"
const LAYOUT_VERSION = 3;

export interface State {
  width: number;
  height: number;
  step: number;
  owner: Int8Array;
  pop: Int32Array;
  terrain: Uint8Array;
  item: Uint8Array;
  itemCount: number;
  rng: Rng;
  events: EventQueue;
  phase: Phase;
  winner: EmpireId;
  winReason: WinReason;
  empires: Empire[];
  genesis: Genesis;
}

export function createState(genesis: Genesis): State {
  const { width, height } = genesis.map;
  const n = width * height;

  return {
    width,
    height,
    step: 0,
    owner: new Int8Array(n),
    pop: new Int32Array(n),
    terrain: new Uint8Array(n),
    item: new Uint8Array(n),
    itemCount: 0,
    rng: new Rng(genesis.seed),
    events: new EventQueue(),
    phase: PHASE.PLAYING,
    winner: 0,
    winReason: WIN.NONE,
    genesis,
    empires: genesis.empires.map((spec, i) => ({
      id: i + 1,
      control: spec.control ?? CONTROL.HUMAN,
      capital: 0,
      bridges: 0,
      ladders: 0,
      marchUnlocked: 0,
      growthUnlocked: 0,
      diamonds: 0,
      tilesOwned: 0,
      popTotal: 0,
      alive: 1,
      eliminatedAt: 0,
      stats: new Uint32Array(STAT_SLOTS),
      members: spec.members.map((m) => ({
        kind: m.kind ?? MEMBER.HUMAN,
        // Clamped rather than trusted: a profile may ask for less than the
        // game allows, never for more, so a difficulty setting can only ever
        // hold a seat back.
        popMax: Math.max(1, Math.min(m.bot?.popMax ?? genesis.rules.popMax, genesis.rules.popMax)),
        popTimer: 0,
        popAcc: 0,
        lastBeat: 0,
        joinedAt: 0,
        stats: new Uint32Array(STAT_SLOTS),
      })),
    })),
  };
}

export const empireOf = (state: State, id: EmpireId): Empire | undefined =>
  state.empires[id - 1];

export function memberOf(
  state: State,
  empireId: EmpireId,
  memberIndex: MemberIndex,
): Member | undefined {
  return state.empires[empireId - 1]?.members[memberIndex];
}

// --- canonical serialisation -------------------------------------------------

function byteLength(state: State): number {
  const n = state.width * state.height;
  let size = 4 + 2 + 2 + 2 + 4 + 4 + 4 + 1 + 1 + 1 + 1 + 4 + 4;
  size += n * 3 + n * 4; // owner, terrain, item (1 byte each) + pop (4)
  for (const e of state.empires) {
    size += 4 + 2 + 2 + 2 + 2 + 2 + 4 + 4 + 1 + 1 + 4 + 1 + STAT_SLOTS * 4;
    size += e.members.length * (1 + 2 + 4 + 4 + 4 + 4 + STAT_SLOTS * 4);
  }
  size += state.events.size * (4 + 4 + 1 + 4);
  return size;
}

export function snapshot(state: State): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength(state));
  const view = new DataView(buffer);
  const n = state.width * state.height;
  let o = 0;

  const u8 = (v: number) => { view.setUint8(o, v); o += 1; };
  const i8 = (v: number) => { view.setInt8(o, v); o += 1; };
  const u16 = (v: number) => { view.setUint16(o, v); o += 2; };
  const u32 = (v: number) => { view.setUint32(o, v); o += 4; };
  const i32 = (v: number) => { view.setInt32(o, v); o += 4; };

  u32(MAGIC);
  u16(LAYOUT_VERSION);
  u16(state.width);
  u16(state.height);
  u32(state.step);
  u32(state.rng.s);
  u32(state.events.seq);
  u8(state.phase);
  i8(state.winner);
  u8(state.winReason);
  u8(state.empires.length);
  u32(state.itemCount);
  u32(state.events.size);

  for (let i = 0; i < n; i++) i8(state.owner[i]!);
  for (let i = 0; i < n; i++) u8(state.terrain[i]!);
  for (let i = 0; i < n; i++) u8(state.item[i]!);
  for (let i = 0; i < n; i++) i32(state.pop[i]!);

  for (const e of state.empires) {
    u32(e.capital);
    u16(e.bridges);
    u16(e.ladders);
    u16(e.marchUnlocked);
    u16(e.diamonds);
    u16(e.growthUnlocked);
    u32(e.tilesOwned);
    u32(e.popTotal);
    u8(e.alive);
    u8(e.control);
    u32(e.eliminatedAt);
    u8(e.members.length);
    for (let s = 0; s < STAT_SLOTS; s++) u32(e.stats[s]!);
    for (const m of e.members) {
      u8(m.kind);
      u16(m.popMax);
      i32(m.popTimer);
      i32(m.popAcc);
      u32(m.lastBeat);
      u32(m.joinedAt);
      for (let s = 0; s < STAT_SLOTS; s++) u32(m.stats[s]!);
    }
  }

  for (const ev of state.events.toSorted()) {
    u32(ev.step);
    u32(ev.seq);
    u8(ev.type);
    u32(ev.payload);
  }

  return buffer;
}

export function restore(state: State, buffer: ArrayBuffer): State {
  const view = new DataView(buffer);
  let o = 0;

  const u8 = () => view.getUint8((o += 1) - 1);
  const i8 = () => view.getInt8((o += 1) - 1);
  const u16 = () => view.getUint16((o += 2) - 2);
  const u32 = () => view.getUint32((o += 4) - 4);
  const i32 = () => view.getInt32((o += 4) - 4);

  if (u32() !== MAGIC) throw new Error("snapshot: bad magic");
  if (u16() !== LAYOUT_VERSION) throw new Error("snapshot: layout version mismatch");

  state.width = u16();
  state.height = u16();
  const n = state.width * state.height;
  state.step = u32();
  state.rng = new Rng(u32());
  const eventSeq = u32();
  state.phase = u8() as Phase;
  state.winner = i8();
  state.winReason = u8() as WinReason;
  const empireCount = u8();
  state.itemCount = u32();
  const eventCount = u32();

  state.owner = new Int8Array(n);
  state.terrain = new Uint8Array(n);
  state.item = new Uint8Array(n);
  state.pop = new Int32Array(n);
  for (let i = 0; i < n; i++) state.owner[i] = i8();
  for (let i = 0; i < n; i++) state.terrain[i] = u8();
  for (let i = 0; i < n; i++) state.item[i] = u8();
  for (let i = 0; i < n; i++) state.pop[i] = i32();

  state.empires = [];
  for (let e = 0; e < empireCount; e++) {
    const empire: Empire = {
      id: e + 1,
      capital: u32(),
      bridges: u16(),
      ladders: u16(),
      marchUnlocked: u16(),
      diamonds: u16(),
      growthUnlocked: u16(),
      tilesOwned: u32(),
      popTotal: u32(),
      alive: u8(),
      control: u8() as Empire["control"],
      eliminatedAt: u32(),
      members: [],
      stats: new Uint32Array(STAT_SLOTS),
    };
    const memberCount = u8();
    for (let s = 0; s < STAT_SLOTS; s++) empire.stats[s] = u32();
    for (let m = 0; m < memberCount; m++) {
      const member: Member = {
        kind: u8() as Member["kind"],
        popMax: u16(),
        popTimer: i32(),
        popAcc: i32(),
        lastBeat: u32(),
        joinedAt: u32(),
        stats: new Uint32Array(STAT_SLOTS),
      };
      for (let s = 0; s < STAT_SLOTS; s++) member.stats[s] = u32();
      empire.members.push(member);
    }
    state.empires.push(empire);
  }

  state.events = new EventQueue();
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    const step = u32();
    const seq = u32();
    const type = u8() as EventType;
    const payload = u32();
    events.push({ step, seq, type, payload });
  }
  state.events.load(events);
  state.events.seq = eventSeq;

  return state;
}

export const hashState = (state: State): number =>
  fnv1a(new Uint8Array(snapshot(state)));

/** Deep copy through the canonical form, so a clone is bit-identical by
 *  construction rather than by careful copying. */
export function cloneState(state: State): State {
  const copy = { genesis: state.genesis } as State;
  return restore(copy, snapshot(state));
}
