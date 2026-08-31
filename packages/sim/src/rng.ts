// mulberry32 — the ONLY source of randomness in the simulation.
//
// Determinism rules callers must honour:
//   * never call next() inside a short-circuiting condition one peer may skip
//   * never consume a variable number of draws based on non-state input
//   * the state is one uint32 and is snapshotted, so a restore resumes the
//     exact same stream

export class Rng {
  s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  int(n: number): number {
    return n <= 0 ? 0 : this.next() % n;
  }

  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(list: readonly T[]): T | undefined {
    return list.length === 0 ? undefined : list[this.int(list.length)];
  }

  /** pairs must be in a fixed order on every peer. */
  weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of pairs) total += w;
    let roll = this.int(total);
    for (const [value, w] of pairs) {
      roll -= w;
      if (roll < 0) return value;
    }
    return pairs[pairs.length - 1]![0];
  }

  clone(): Rng {
    return new Rng(this.s);
  }
}

/** Stable uint32 seed from an arbitrary string (a game id, a room name). */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
