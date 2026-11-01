// The picture behind the start page's title: a corner of a board with four
// empires spreading across it, the same one the share image (share/og.html)
// draws. It is decoration, so it is fixed rather than a real game: the same
// seed lays it out the same way every time.

import { bannerById } from "@tessera/sim";

const SIZE = 14;

const EMPIRES = [
  { banner: "vermilion", capital: [10, 3] },
  { banner: "cobalt", capital: [6, 9] },
  { banner: "amber", capital: [12, 11] },
  { banner: "verdant", capital: [8, 0] },
] as const;

const LAKE = new Set(["11,7", "12,7", "11,8", "13,7"]);
const MOUNTAIN = new Set(["8,6", "9,6", "9,7", "4,4", "5,12"]);
const COINS = new Set(["7,4", "13,13", "4,7", "10,13"]);

/** Fill `host` with the board's tiles. */
export function drawHeroBoard(host: HTMLElement): void {
  // A Park–Miller generator, so the borders wobble the same way each load.
  let seed = 7;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const tiles: HTMLElement[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const key = `${x},${y}`;
      if (LAKE.has(key)) tile.classList.add("t-lake");
      else if (MOUNTAIN.has(key)) tile.classList.add("t-mountain");
      else {
        let nearest = 0;
        let distance = Infinity;
        EMPIRES.forEach((empire, at) => {
          const d = Math.hypot(x - empire.capital[0], y - empire.capital[1]) + random() * 1.6;
          if (d < distance) { distance = d; nearest = at; }
        });
        const empire = EMPIRES[nearest];
        const banner = bannerById(empire.banner);
        if (distance < 3.4 && banner) {
          tile.classList.add(`p-${banner.pattern}`);
          tile.style.setProperty("--c1", banner.c1);
          tile.style.setProperty("--c2", banner.c2);
          if (empire.capital[0] === x && empire.capital[1] === y) tile.classList.add("capital");
        } else if (COINS.has(key)) tile.classList.add("coin");
      }
      tiles.push(tile);
    }
  }
  host.replaceChildren(...tiles);
}
