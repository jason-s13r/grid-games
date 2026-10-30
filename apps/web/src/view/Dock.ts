// Where the pan and zoom controls live.
//
// On a wide screen they sit under the minimap, beside the board, so they never
// cover a tile. On a narrow one there is no column beside the board, and a
// thumb panning a small board needs them within reach, so they go back over
// the board's corner. The element moves rather than being drawn twice, so its
// listeners come with it.

/** Matches the layout breakpoint in the styles and in view/Tabs.ts. */
const NARROW = "(max-width: 900px)";

export class Dock {
  private readonly media = window.matchMedia(NARROW);

  constructor(
    private readonly controls: HTMLElement,
    private readonly side: HTMLElement,
    private readonly board: HTMLElement,
  ) {
    this.media.addEventListener("change", () => this.place());
    this.place();
  }

  private place(): void {
    const home = this.media.matches ? this.board : this.side;
    if (this.controls.parentElement !== home) home.append(this.controls);
  }
}
