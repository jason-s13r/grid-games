import { BaseGame } from "./BaseGame";
import { Bot } from "./Bot";
import { Player } from "./Player";
import { getNeighbours } from "./utils";

export class EmpireAttack extends BaseGame {
    fps = 12;
    constructor(selector) {
      super(selector);
      this.MIN_COLUMNS = 20;
      this.MIN_CELL_SIZE = 24;
      this.CELL_SIZE = 24;
      this.EXTRA_CELLS = 0;
    }
    init() {
      // this.player = new Player();
      this.player = new Bot(["home", "defend", "attack", "cycle"], 1);
      this.bot = new Bot(["home", "expand", "defend", "attack", "random", "cycle"]);
      // this.bot = new Bot(["expand"]);
      super.init();

      const $counter = document.createElement("input");
      $counter.readOnly = true;
      this.player.counter.listen((value) => ($counter.value = value));

      const $play = document.createElement("button");
      $play.textContent = "Play";
      $play.addEventListener("click", this.onPlay.bind(this));

      const $pause = document.createElement("button");
      $pause.textContent = "Pause";
      $pause.addEventListener("click", this.onPause.bind(this));

      const $clear = document.createElement("button");
      $clear.textContent = "Clear";
      $clear.addEventListener("click", this.reset.bind(this));

      this.controls.append($counter, $play, $pause, $clear);

      this.onPlay();
    }

    onPlay() {
      this.paused && this.tick((this.paused = false));
    }
    onPause() {
      this.paused = true;
    }
    reset() {
      this.onPause();
      super.reset();

      this.player.reset(this.columns, this.rows);
      this.bot.reset(this.columns, this.rows);

      this.setCell(...this.player.home, this.player.sign);
      this.setCell(...this.bot.home, this.bot.sign);

      this.render();

      const selector = [this.player.home, this.bot.home]
        .map(([x, y]) => `[x="${x}"][y="${y}"]`)
        .join(",");
      const homes = this.board.querySelectorAll(selector);
      homes.forEach((e) => e.classList.add("is-home"));
    }

    isWin() {
      const [x, y] = this.bot.home;
      return !this.cells[x] || this.cells[x][y] > this.bot.sign;
    }

    isLose() {
      const [x, y] = this.player.home;
      return !this.cells[x] || this.cells[x][y] < this.player.sign;
    }

    onTick() {
      this.player.fixPath(this.cells);
      this.bot.fixPath(this.cells);

      if (this.isWin()) {
        this.paused = true;
        this.bot.path.forEach(
          ([x, y]) => (this.cells[x][y] = Math.abs(this.cells[x][y]))
        );
        this.player.path.forEach(
          ([x, y]) => (this.cells[x][y] = Math.abs(this.cells[x][y]))
        );
        return;
      }
      if (this.isLose()) {
        this.paused = true;
        this.bot.path.forEach(
          ([x, y]) => (this.cells[x][y] = -Math.abs(this.cells[x][y]))
        );
        this.player.path.forEach(
          ([x, y]) => (this.cells[x][y] = -Math.abs(this.cells[x][y]))
        );
        return;
      }

      this.player.onTick(this.cells);
      this.bot.onTick(this.cells);

      if (Math.random() < 0.25 && this.player.performAction) {
        const [ux, uy] = this.bot.home;
        const [x, y, power] = this.player.performAction(this.copyCells(), [ux, uy]);
        this.cells[x][y] += power;
      }

      if (Math.random() < 0.25) {
        const [ux, uy] = this.player.home;
        const [x, y, power] = this.bot.performAction(this.copyCells(), [ux, uy]);
        this.cells[x][y] += power;
      }
    }

    setCell(x, y, value) {
      this.cells[x][y] = value;
    }
    copyCells() {
      return this.cells.map((inner) => inner.map((c) => c));
    }
    combineCells(...cells) {
      const snapshot = this.copyCells();
      const update = snapshot.map((inner, x) =>
        inner.map((value, y) =>
          cells.reduce((sum, cell) => sum + cell[x][y], 0)
        )
      );
      this.cells = update;
    }

    tick() {
      this.onTick();
      this.render();
      if (!this.paused) {
        setTimeout(
          () => requestAnimationFrame(this.tick.bind(this)),
          Math.floor(1000 / this.fps)
        );
      }
    }

    addCell(x, y) {
      const $square = super.addCell(x, y);
      $square.removeEventListener("click", this.onCellClick);
      $square.style.pointerEvents = "none";
      $square.textContent = this.cells[x][y];
      $square.title = this.cells[x][y];
    }

    render() {
      for (let x = 0; x < this.columns; x++) {
        for (let y = 0; y < this.rows; y++) {
          const cell = this.cells[x][y];
          const element = this.board.querySelector(`[x="${x}"][y="${y}"]`);
          if (cell && element) {
            element.textContent = cell;
            element.title = cell;
          }
          if (cell && !element) {
            this.addCell(x, y);
          }
          if (!cell && element) {
            element.remove();
          }
        }
      }
    }

    onCellClick = (event) => {
      const snapshot = this.copyCells();
      event.stopImmediatePropagation();
      const [x, y] = this.getCoordinate(event);
      const connected = getNeighbours(x, y).filter(
        ([a, b]) => snapshot[a] && snapshot[a][b] > 0
      );

      if (connected.length) {
        const power = this.player.counter.value * connected.length;
        this.player.counter.value = 0;
        const cell = snapshot[x][y];
        this.cells[x][y] = (cell || 0) + power;
        this.player.path.add([x, y]);
      }
      this.render();
    };
  }