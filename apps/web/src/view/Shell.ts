// Which screen you are on, and whether the shop is open.
//
// Setting up a game and playing one are different jobs with different shapes,
// so they are different screens rather than two halves of one crowded page.
// The simulation does not care: it runs on wall-clock time behind whichever
// screen is showing, which is also why "back to the game" is always safe.
//
// Pure view state — never in the sim, never hashed, never sent.

export type Screen = "menu" | "game";

export interface ShellElements {
  app: HTMLElement;
  menu: HTMLElement;
  /** Shown on the menu only once there is a game to go back to. */
  resume: HTMLElement;
  itemsToggle: HTMLElement;
  itemsDrawer: HTMLElement;
}

export class Shell {
  private screen: Screen = "menu";

  /** Told when the screen changes, so the caller can re-measure the board —
   *  a viewport that was covered may have been resized while it was. */
  onScreen: ((screen: Screen) => void) | null = null;

  constructor(private els: ShellElements) {
    els.itemsToggle.addEventListener("click", () => this.showItems(this.els.itemsDrawer.hidden));

    // Buying does not shut the shop — two bridges is a normal thing to want —
    // but a click anywhere else does, because at that point you are back to
    // playing and a panel over the board is in the way.
    document.addEventListener("pointerdown", (event) => {
      if (this.els.itemsDrawer.hidden) return;
      const within = (event.target as HTMLElement).closest(".items-dock");
      if (!within) this.showItems(false);
    });

    this.showItems(false);
    this.show("menu");
  }

  get itemsOpen(): boolean {
    return !this.els.itemsDrawer.hidden;
  }

  showItems(open: boolean): void {
    this.els.itemsDrawer.hidden = !open;
    this.els.itemsToggle.setAttribute("aria-expanded", String(open));
    this.els.itemsToggle.classList.toggle("armed", open);
  }

  get current(): Screen {
    return this.screen;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.els.app.dataset.screen = screen;
    this.els.menu.hidden = screen !== "menu";
    if (screen === "menu") this.showItems(false);
    this.onScreen?.(screen);
  }

  /** There is a game worth returning to. Called on the first mount, not in the
   *  constructor, because at construction time there is nothing behind here. */
  gameReady(): void {
    this.els.resume.hidden = false;
  }

  /** Put the board down and go back to the lobby. The way back is the way you
   *  came — start another game — so the resume button goes with it; leaving a
   *  "back to the game" on screen after you have left is how you end up
   *  rejoining a table you meant to get up from. */
  left(): void {
    this.show("menu");
    this.els.resume.hidden = true;
  }
}
