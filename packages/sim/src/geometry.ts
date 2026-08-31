// Grid geometry.
//
// The old getNeighbours() returned a plus-shape of 5 *including the cell
// itself*, conflating two different ideas — which is why a fully surrounded
// tile used to score a multiplier of 5 instead of 4. These are now separate.

/** The 4 orthogonal neighbours, NOT including self. Adjacency and multiplier. */
export const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];

const ballCache = new Map<number, ReadonlyArray<readonly [number, number]>>();

/** The "pixelated circle": every offset within Manhattan distance r, including
 *  self, emitted in (dy, dx) order so iteration matches flat-index order and is
 *  canonical across peers. */
export function vonNeumannBall(r: number): ReadonlyArray<readonly [number, number]> {
  const cached = ballCache.get(r);
  if (cached) return cached;

  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    const span = r - Math.abs(dy);
    for (let dx = -span; dx <= span; dx++) offsets.push([dx, dy]);
  }
  ballCache.set(r, offsets);
  return offsets;
}

export const ballSize = (r: number): number => 2 * r * r + 2 * r + 1;

export const idx = (x: number, y: number, width: number): number => y * width + x;
export const xOf = (i: number, width: number): number => i % width;
export const yOf = (i: number, width: number): number => Math.floor(i / width);

export const inBounds = (x: number, y: number, width: number, height: number): boolean =>
  x >= 0 && y >= 0 && x < width && y < height;

/** Squared distance, integer only. Never Math.sqrt in game logic: it is not
 *  guaranteed bit-identical across JS engines. */
export const dist2 = (ax: number, ay: number, bx: number, by: number): number =>
  (ax - bx) ** 2 + (ay - by) ** 2;
