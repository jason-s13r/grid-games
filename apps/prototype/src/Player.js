import { R } from "./R";

export class Player {
    sign = 1;
    home = [0, 0];
    constructor() {
      this.counter = new R(0);
    }

    reset(columns, rows) {
      const x = Math.floor(Math.random() * columns);
      const y = Math.floor(Math.random() * rows);
      this.home = [x, y];
      this.path = new Set([[x, y]]);
    }

    fixPath(cells) {
      const coords = cells.flatMap((inner, x) =>
        inner.map((cell, y) => [x, y])
      );
      this.path = new Set(
        Array.from(coords.filter(([x, y]) => cells[x][y] > 0))
      );
    }

    onTick(cells) {
      if (this.counter.value < 999) {
        this.counter.update((value) => value + 1);
      }
    }
  }