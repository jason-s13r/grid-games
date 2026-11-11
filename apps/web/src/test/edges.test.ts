import { describe, expect, it } from "vitest";
import { TERRAIN } from "@tessera/sim";
import type { State } from "@tessera/sim";
import { edges } from "../view/Renderer";

const T: Record<string, number> = {
  ".": TERRAIN.PLAIN,
  M: TERRAIN.MOUNTAIN,
  L: TERRAIN.LAKE,
  R: TERRAIN.RIVER,
  B: TERRAIN.RIVER_BRIDGED,
  W: TERRAIN.WALL,
  H: TERRAIN.WALL_LADDERED,
};

/** Just the ground, which is all `edges` reads. */
function board(rows: string[]): State {
  return {
    width: rows[0]!.length,
    height: rows.length,
    terrain: Uint8Array.from(rows.join(""), (c) => T[c]!),
  } as unknown as State;
}

const at = (rows: string[], x: number, y: number) => edges(board(rows), y * rows[0]!.length + x).trim().split(" ");

describe("terrain edges", () => {
  it("turns a bridge across a river running east and west", () => {
    const rows = ["...", "RBR", "..."];
    expect(at(rows, 1, 1)).toEqual(["j-e", "j-w", "x-turn"]);
  });

  it("leaves a bridge across a river running north and south", () => {
    const rows = [".R.", ".B.", ".R."];
    expect(at(rows, 1, 1)).toEqual(["j-n", "j-s"]);
  });

  it("turns a ladder over a wall running north and south", () => {
    const rows = [".W.", ".H.", ".W."];
    expect(at(rows, 1, 1)).toEqual(["j-n", "j-s", "x-turn"]);
  });

  it("leaves a ladder over a wall running east and west", () => {
    const rows = ["...", "WHW", "..."];
    expect(at(rows, 1, 1)).toEqual(["j-e", "j-w"]);
  });

  it("joins water to water, a river to a lake, and runs off the map", () => {
    const rows = ["R..", "RLL", "..."];
    expect(at(rows, 0, 1)).toEqual(["j-n", "j-e", "j-w"]);
  });

  it("does not join different kinds", () => {
    const rows = ["...", "WRM", "..."];
    expect(edges(board(rows), 4)).toBe("");
    expect(edges(board(["..."]), 1)).toBe("");
  });
});
