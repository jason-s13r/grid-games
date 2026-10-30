// What the board shows on top of the tiles, for the player's eyes only.
//
// Two things, both drawn on a canvas of their own so they work at every zoom
// and leave the tile renderer alone:
//
// - Where a held bridge or ladder can go right now: a river or wall tile
//   beside your border, not shielded. Clicking one places it (game/input.ts
//   reads the terrain), so this is the only "targeting" there is: no mode to
//   arm and none to forget, just the answer to "where can I put this?".
// - The tile under the pointer, outlined, with a line saying what it is and
//   what a click there would do.
//
// Nothing here is in the simulation, and nothing is sent.

import { ITEM, MOVE, TERRAIN, adjacentToOwned, idx, isMine, mineDigCost, mineLeft } from "@tessera/sim";
import type { Move, State } from "@tessera/sim";
import type { Driver } from "../game/Driver";
import type { Camera } from "./Camera";
import { empireTheme } from "./palette";

const TERRAIN_NAME: Record<number, string> = {
  [TERRAIN.PLAIN]: "open ground",
  [TERRAIN.MOUNTAIN]: "mountain",
  [TERRAIN.LAKE]: "lake",
  [TERRAIN.RIVER]: "river",
  [TERRAIN.RIVER_BRIDGED]: "bridge",
  [TERRAIN.WALL]: "wall",
  [TERRAIN.WALL_LADDERED]: "ladder",
};

const ITEM_NAME: Record<number, string> = {
  [ITEM.BRONZE]: "a bronze coin",
  [ITEM.SILVER]: "a silver coin",
  [ITEM.GOLD]: "a gold coin",
  [ITEM.DIAMOND]: "a diamond",
};

export class Marks {
  private readonly ctx: CanvasRenderingContext2D;
  /** The tile under the pointer, or null when it is off the board. */
  private hover: [number, number] | null = null;
  /** What was drawn last, so an unchanged frame costs nothing. */
  private drawn = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly info: HTMLElement,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  pointAt(tile: [number, number] | null): void {
    this.hover = tile;
  }

  render(state: State, game: Driver, camera: Camera): void {
    const empire = state.empires[game.empire - 1];
    const placing = !!empire && (empire.bridges > 0 || empire.ladders > 0);
    const key = [
      camera.x, camera.y, camera.zoom, camera.width, camera.height,
      state.step, this.hover?.join(",") ?? "", game.empire, placing,
    ].join("|");
    if (key === this.drawn) return;
    this.drawn = key;

    this.size(camera);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, camera.width, camera.height);
    const z = camera.zoom;

    if (placing && empire) {
      const { x0, y0, x1, y1 } = camera.range(0);
      ctx.fillStyle = "rgba(240, 190, 90, 0.55)";
      ctx.strokeStyle = "#8a5a10";
      ctx.lineWidth = z >= 8 ? 3 : 1;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const terrain = state.terrain[idx(x, y, state.width)];
          const type =
            terrain === TERRAIN.RIVER && empire.bridges > 0
              ? MOVE.PLACE_BRIDGE
              : terrain === TERRAIN.WALL && empire.ladders > 0
                ? MOVE.PLACE_LADDER
                : null;
          if (type === null) continue;
          if (!game.sim.validate(this.move(state, game, type, x, y))) continue;
          const [sx, sy] = camera.toScreen(x, y);
          ctx.fillRect(sx, sy, z, z);
          if (z >= 6) ctx.strokeRect(sx + 1.5, sy + 1.5, z - 3, z - 3);
        }
      }
    }

    const hover = this.hover;
    if (hover) {
      const [sx, sy] = camera.toScreen(hover[0], hover[1]);
      ctx.strokeStyle = "#24493d";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, Math.max(2, z - 2), Math.max(2, z - 2));
    }

    const line = hover ? this.describe(state, game, hover[0], hover[1]) : "";
    this.info.hidden = !line;
    if (this.info.textContent !== line) this.info.textContent = line;
  }

  /** "Cobalt · 140 · open ground — Claim: your bank 312 against 140." */
  private describe(state: State, game: Driver, x: number, y: number): string {
    const i = idx(x, y, state.width);
    const owner = state.owner[i]!;
    const pop = state.pop[i]!;
    const terrain = state.terrain[i]!;
    const item = state.item[i]!;

    const what = [
      owner > 0 ? `${empireTheme(owner).name}${owner === game.empire ? " (you)" : ""}` : "unclaimed",
      TERRAIN_NAME[terrain] ?? "",
      pop > 0 ? `population ${pop}` : "",
      ITEM_NAME[item] ??
        (isMine(item)
          ? mineLeft(item) > 0
            ? `a diamond mine, ${mineLeft(item)} to come`
            : `a diamond mine to dig (a claim of ${mineDigCost(state)} or more)`
          : ""),
      state.shielded[i]! > 0 ? "shielded" : "",
    ].filter(Boolean).join(" · ");

    const empire = state.empires[game.empire - 1];
    if (!empire) return what;
    return `${what} — ${this.clickDoes(state, game, x, y)}`;
  }

  /** What a click would do, by the same reading game/input.ts makes. */
  private clickDoes(state: State, game: Driver, x: number, y: number): string {
    const i = idx(x, y, state.width);
    const empire = state.empires[game.empire - 1]!;
    const terrain = state.terrain[i]!;

    if (terrain === TERRAIN.RIVER) {
      if (game.sim.validate(this.move(state, game, MOVE.PLACE_BRIDGE, x, y))) return "click to bridge it";
      return empire.bridges > 0 ? "a bridge has to start beside your border" : "buy a bridge to cross";
    }
    if (terrain === TERRAIN.WALL) {
      if (game.sim.validate(this.move(state, game, MOVE.PLACE_LADDER, x, y))) return "click to put a ladder on it";
      return empire.ladders > 0 ? "a ladder has to start beside your border" : "buy a ladder to cross";
    }

    const adjacent = adjacentToOwned(state, x, y, game.empire);
    const type = !adjacent && empire.marchUnlocked ? MOVE.MARCH : MOVE.CLAIM;
    if (!game.sim.validate(this.move(state, game, type, x, y))) {
      if (terrain === TERRAIN.MOUNTAIN || terrain === TERRAIN.LAKE) return "nobody can take this";
      if (state.shielded[i]! > 0) return "shielded until an empire claims it";
      if (!adjacent) return empire.marchUnlocked ? "too far, even for a march" : "too far: claim beside your border";
      return "your bank is empty";
    }
    const bank = empire.members[game.member]?.popTimer ?? 0;
    const owner = state.owner[i]!;
    const verb = type === MOVE.MARCH ? "march" : owner === game.empire ? "reinforce" : "claim";
    return owner > 0 && owner !== game.empire
      ? `click to ${verb}: your bank ${bank} against ${state.pop[i]!}`
      : `click to ${verb} with your bank of ${bank}`;
  }

  private move(state: State, game: Driver, type: Move["type"], x: number, y: number): Move {
    return { step: state.step, empire: game.empire, member: game.member, seq: 0, type, x, y };
  }

  private size(camera: Camera): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(camera.width * dpr);
    const h = Math.round(camera.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${camera.width}px`;
      this.canvas.style.height = `${camera.height}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
