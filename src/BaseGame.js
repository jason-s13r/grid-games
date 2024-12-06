  export class BaseGame {
    constructor(selector) {
      this.MIN_COLUMNS = 40;
      this.MIN_CELL_SIZE = 10;
      this.CELL_SIZE = 16;
      this.EXTRA_CELLS = 10;
      this.container = document.querySelector(selector);
      this.board = this.container.querySelector(".game-board");
      this.controls = this.container.querySelector(".game-controls");
    }
    
    init() {
      this.cells = [];
      const { width, height } = this.container.getBoundingClientRect();
      this.gridSize = Math.min(Math.max(Math.floor(width / this.MIN_COLUMNS), this.MIN_CELL_SIZE), this.CELL_SIZE),
      this.columns = Math.floor(width / this.gridSize);
      this.rows = Math.floor(height / this.gridSize);

      this.board.style.setProperty("--grid-size", this.gridSize + "px");
      this.board.style.setProperty("--grid-columns", this.columns);
      this.board.style.setProperty("--grid-rows", this.rows);

      this.reset();
      this.board.addEventListener("click", this.onCellClick);
    }

    destroy() {
      this.reset();
      this.controls.innerHTML = '';
      this.board.removeEventListener("click", this.onCellClick);
    }

    reset() {
      this.board.innerHTML = '';
      this.cells = new Array(this.columns + this.EXTRA_CELLS).fill(0).map(() => new Array(this.rows + this.EXTRA_CELLS).fill(false));
      this.render();
    }

    getCoordinate({ clientX, clientY }, { left, top } = this.board.getBoundingClientRect()) {
      return [
        Math.floor((clientX - left) / this.gridSize),
        Math.floor((clientY - top) / this.gridSize),
      ];
    }

    addCell(x, y) {
      const $square = document.createElement("div");
      $square.classList.add("tile");
      $square.style.setProperty("--square-left", x);
      $square.style.setProperty("--square-top", y);
      $square.setAttribute('x', x);
      $square.setAttribute('y', y);
      $square.addEventListener('click', this.onCellClick)
      this.board.appendChild($square);

      return $square
    }

    render() {
      for (let x = 0; x < this.columns; x++) {
        for (let y = 0; y < this.rows; y++) {
          const cell = this.cells[x][y];
          const element = this.board.querySelector(`[x="${x}"][y="${y}"]`);
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
      event.stopImmediatePropagation();
      const [x, y] = this.getCoordinate(event);
      this.cells[x][y] = event.target === this.board;
      this.render();
    }
  }