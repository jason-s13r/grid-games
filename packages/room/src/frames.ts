// A game's map over time, for fast-forwarding a replay and making a video.
//
// The room records a frame at a steady pace, about `FRAMES_PER_GAME` over a
// game whatever its length, each a grid like the listings' map but finer. A
// frame is stored as runs: the cells themselves for a key frame, and for the
// rest the cells XOR the frame before, which is almost all zeros. Every
// `KEY_EVERY`th is a key frame, so a reader can start near any point.
//
// Which frames to show, and how fast, is the reader's choice.

import { STEPS_PER_SECOND, Sim, flyBanners } from "@tessera/sim";
import type { BannerId, Genesis, Move } from "@tessera/sim";
import { toBase64Url } from "@tessera/protocol";
import { thumbnail } from "./thumb.js";
import type { GameArchive } from "./record.js";

/** Frames over a game with an end, about. */
export const FRAMES_PER_GAME = 4000;
/** A key frame every this many. */
export const KEY_EVERY = 64;
/** Cells across, at most. Maps up to Large are a tile a cell. */
export const FRAME_WIDTH = 256;
/** The pace for a game with no end: the room's snapshot pace. */
const OPEN_ENDED_EVERY = STEPS_PER_SECOND * 120;

const KEY = 0;
const DELTA = 1;

/** Steps between frames for a game. */
export function frameEvery(genesis: Genesis): number {
  const end = genesis.rules.endStep ?? 0;
  return end > 0 ? Math.max(1, Math.round(end / FRAMES_PER_GAME)) : OPEN_ENDED_EVERY;
}

export interface StoredFrame {
  step: number;
  bytes: Uint8Array;
}

/** The frames of a game as an archive carries them. */
export interface Timeline {
  width: number;
  height: number;
  /** Steps between frames. The last frame is at the game's end, wherever
   *  that fell. */
  every: number;
  /** The house each empire flew at the end, by empire id from 1. */
  banners: BannerId[];
  /** Each frame's step and its bytes, base64. */
  frames: Array<[number, string]>;
}

function pushVarint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

/** Runs of equal bytes: (length, value) pairs, the length a varint. */
function runs(cells: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const value = cells[i]!;
    let j = i + 1;
    while (j < cells.length && cells[j] === value) j++;
    pushVarint(out, j - i);
    out.push(value);
    i = j;
  }
  return out;
}

/** A frame's bytes: a key frame when `previous` is absent. */
export function encodeFrame(cells: Uint8Array, previous?: Uint8Array): Uint8Array {
  if (!previous || previous.length !== cells.length) return Uint8Array.from([KEY, ...runs(cells)]);
  const xor = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) xor[i] = cells[i]! ^ previous[i]!;
  return Uint8Array.from([DELTA, ...runs(xor)]);
}

/** A frame's cells, given the cells of the frame before for a delta. */
export function decodeFrame(bytes: Uint8Array, size: number, previous?: Uint8Array): Uint8Array {
  const cells = new Uint8Array(size);
  let at = 0;
  let i = 1;
  while (i < bytes.length && at < size) {
    let length = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes[i++]!;
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    cells.fill(bytes[i++]!, at, Math.min(size, at + length));
    at += length;
  }
  if (bytes[0] === DELTA) {
    if (!previous) throw new Error("a delta frame needs the frame before it");
    for (let k = 0; k < size; k++) cells[k] = cells[k]! ^ previous[k]!;
  }
  return cells;
}

export const isKeyFrame = (bytes: Uint8Array): boolean => bytes[0] === KEY;

/** Where a chain of frames has got to: the last frame's cells, for the next
 *  to be a delta of, and how many deltas since a key frame. */
export interface FrameChain {
  cells: Uint8Array;
  sinceKey: number;
}

/** The next frame of a chain: a delta of the last, or a key frame every
 *  KEY_EVERY. As a room records them. */
export function chainFrame(cells: Uint8Array, last: FrameChain | undefined): { bytes: Uint8Array; chain: FrameChain } {
  const previous = last && last.sinceKey + 1 < KEY_EVERY ? last : undefined;
  return {
    bytes: encodeFrame(cells, previous?.cells),
    chain: { cells, sinceKey: previous ? previous.sinceKey + 1 : 0 },
  };
}

/** Whether a frame falls at this step of a game: on the pace, and at its end. */
export const frameDue = (step: number, every: number, end: number, ended: boolean): boolean =>
  step % every === 0 || step >= end || ended;

/** A timeline's frames and its houses, put together. */
export function timelineFrom(
  genesis: Genesis,
  frames: Array<[number, string]>,
  flags: ReadonlyArray<{ empire: number; banner: BannerId }> | undefined,
  size: { width: number; height: number },
): Timeline {
  const claimed = new Map((flags ?? []).map((f) => [f.empire, f.banner] as const));
  return {
    width: size.width,
    height: size.height,
    every: frameEvery(genesis),
    banners: flyBanners(genesis.empires, claimed).map((b) => b.id),
    frames,
  };
}

/** The timeline a room would have kept for a finished game, made again from
 *  its archive: the game replayed from its record, a frame taken at the same
 *  pace and in the same encoding as a room takes them. For games archived
 *  before rooms kept timelines, so they can still be watched once the sim
 *  that played them is retired. Needs a sim that plays the game's version. */
export function timelineOf(archive: GameArchive): Timeline {
  const { genesis } = archive;
  const sim = new Sim(genesis);
  const every = frameEvery(genesis);
  const byStep = new Map<number, Move[]>();
  for (const { move } of archive.moveLog) byStep.set(move.step, [...(byStep.get(move.step) ?? []), move]);

  const frames: Array<[number, string]> = [];
  let chain: FrameChain | undefined;
  const take = () => {
    const next = chainFrame(thumbnail(sim.state, [], sim.step, FRAME_WIDTH).cells, chain);
    frames.push([sim.step, toBase64Url(next.bytes)]);
    chain = next.chain;
  };

  take();
  while (sim.step < archive.steps && !sim.ended) {
    sim.advance(byStep.get(sim.step) ?? []);
    if (frameDue(sim.step, every, archive.steps, sim.ended)) take();
  }
  return timelineFrom(genesis, frames, archive.flags, thumbnail(sim.state, [], 0, FRAME_WIDTH));
}
