import { Player } from "./Player";
import { getNeighbours } from "./utils";

export class Bot extends Player {
    static Modes = ["home", "expand", "defend", "attack", "random", "cycle"];
    sign = -1;

    constructor(modes = Bot.Modes) {
      super();
      this.modes = modes;
    }

    reset(columns, rows) {
      super.reset(columns, rows);
      this.mode = this.modes.includes('cycle') ? "cycle" : this.modes[0]; 
      this.cycleMode = this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes];
      this.cycleCount = 0;
      this.recent = [];
    }

    fixPath(cells) {
      const coords = cells.flatMap((inner, x) =>
        inner.map((cell, y) => [x, y])
      );
      this.path = new Set(
        Array.from(coords.filter(([x, y]) => cells[x][y] < 0))
      );
    }

    onTick(cells) {
      super.onTick(cells);

      if (this.mode !== "cycle" && Math.random() < 0.4) {
        this.mode = this.modes[Math.floor(Math.random() * this.modes.length)];
        console.debug('## this.mode', this.mode);
      }
    }

    performAction(cells, opponent) {
      const mode = this.getMode();
      console.debug('## mode', this.mode, this.cycleMode, this.cycleCount, mode);  

      let target = this.home;
      if (mode === "expand") {
        target = this.expand(cells);
      } else if (mode === "attack") {
        target = this.attack(cells, opponent);
      } else if (mode === "defend") {
        target = this.defendTiles(cells);
      } else {
        target = this.defendHome(cells);
      }

      const [tx, ty] = target;
      const multiplier = getNeighbours(tx, ty).filter(
        ([a, b]) => cells[a] && cells[a][b] < 0
      ).length;
      const basePower = this.counter.value;
      this.counter.value = 0;
      const power = basePower * multiplier;

      const result = cells[tx][ty] - power;
      if (result < 0) {
        this.path.add(target);
      }

      return [tx, ty, power];
    }

    getMode() {
      const modes = this.modes;
      let mode = this.mode;
      if (mode === "cycle" && this.cycleCount++ > 10) {
        const next = (modes.indexOf(this.cycleMode) + 1) % modes.length;
        this.cycleMode = modes[next];
        this.cycleCount = 0;
        if (this.cycleMode === "cycle") {
          this.mode = modes[(modes.indexOf("cycle") + 1) % modes.length];
          this.cycleMode = modes[0];
          mode = this.cycleMode;
        }
      }
      if (mode === "cycle") {
        mode = this.cycleMode;
      }
      if (mode === "random") {
        mode = modes[Math.floor(Math.random() * (modes.length - 1))];
      }

      return mode;
    }

    defendTiles() {
      const squares = Array.from(this.path.values());
      return squares[Math.floor(Math.random() * squares.length)];
    }

    defendHome(cells) {
      const [hx, hy] = this.home;
      const neighbours = getNeighbours(hx, hy).filter(([x, y]) => cells[x]);
      return neighbours[Math.floor(Math.random() * neighbours.length)];
    }

    expand(cells) {
      const squares = Array.from(this.path.values());
      const outer = squares
        .flatMap((coord) => (coord ? getNeighbours(...coord) : []))
        .filter(([sx, sy]) => cells[sx] && cells[sx][sy] >= 0);
      const expand = Array.from(new Set(outer));

      expand.sort(([ax, ay], [bx, by]) => {
        const a = cells[ax][ay];
        const b = cells[bx][by];
        return a - b;
      });

      const targets = expand.slice(0, Math.min(5, expand.length));

      const target = targets[Math.floor(Math.random() * targets.length)];
      this.recent.unshift(target);
      this.recent.length = Math.min(this.recent.length, 5);

      return target;
    }

    attack(cells, opponent) {
      const distance = ([tx, ty], [x, y]) => (x - tx) ** 2 + (y - ty) ** 2;
      const squares = Array.from(this.path.values());
      const outer = squares
        .flatMap((coord) => (coord ? getNeighbours(...coord) : []))
        .filter(([sx, sy]) => cells[sx] && cells[sx][sy] >= 0);
      const attack = Array.from(new Set(outer));

      const [ux, uy] = opponent;
      const targeted = distance.bind(distance, [ux, uy]);
      attack.sort((a, b) => targeted(a) - targeted(b));

      const targets = attack.slice(0, Math.min(5, attack.length));

      const target = targets[Math.floor(Math.random() * targets.length)];
      this.recent.unshift(target);
      this.recent.length = Math.min(this.recent.length, 5);
      return target;
    }
  }