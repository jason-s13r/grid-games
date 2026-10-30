// Which screen you are on, and whether the game menu is open.
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
  /** The ≡ button in the status bar, and the menu it opens. */
  menuToggle: HTMLElement;
  menuDrawer: HTMLElement;
}

export class Shell {
  private screen: Screen = "menu";

  /** Told when the screen changes, so the caller can re-measure the board —
   *  a viewport that was covered may have been resized while it was. */
  onScreen: ((screen: Screen) => void) | null = null;

  constructor(private els: ShellElements) {
    els.menuToggle.addEventListener("click", () => this.showGameMenu(this.els.menuDrawer.hidden));

    // A click anywhere else shuts the menu, and so does choosing something in
    // it: every entry is a one-off action.
    document.addEventListener("pointerdown", (event) => {
      if (this.els.menuDrawer.hidden) return;
      if (!(event.target as HTMLElement).closest(".menu-dock")) this.showGameMenu(false);
    });
    els.menuDrawer.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button")) this.showGameMenu(false);
    });

    this.showGameMenu(false);
    this.show("menu");
  }

  showGameMenu(open: boolean): void {
    this.els.menuDrawer.hidden = !open;
    this.els.menuToggle.setAttribute("aria-expanded", String(open));
  }

  get current(): Screen {
    return this.screen;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.els.app.dataset.screen = screen;
    this.els.menu.hidden = screen !== "menu";
    if (screen === "menu") this.showGameMenu(false);
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
