// The side panels as tabs, on a screen too narrow to stack them.
//
// On a desktop both sidebars are columns and every panel can be open at once,
// which is the right shape: the map, the standings and the chat are things you
// watch while doing something else. A phone has one column and no such luxury.
// Stacked as accordions they became a strip of headings under the board, each
// costing height whether or not you were reading it, and the panel you did
// open pushed the board up out of its own stage.
//
// Tabs say the same thing in one row: exactly one panel at a time, and the rest
// of the height is the board's. Clicking the open tab again shuts it, because
// the most useful thing a phone can do with that space is give it back.
//
// The tabs are built from the panels rather than declared alongside them, so a
// panel that appears mid-game — the seats list, once your empire has more than
// one — brings its own tab with it and nothing has to be kept in step by hand.

/** Below this the sidebars are stacked rather than beside the board, and this
 *  is the width that decides it. Matches the layout breakpoint in the styles;
 *  they are two statements of one number, so they move together. */
const NARROW = "(max-width: 900px)";

export class Tabs {
  private readonly media = window.matchMedia(NARROW);
  /** The tab list as last built, so a rebuild only happens when the set of
   *  panels actually changes rather than on every mutation. */
  private built = "";
  private active: string | null = null;

  /** The app element carries `data-tabbed` and `data-panel` rather than
   *  `data-tabs` and `data-tab`: those are the bar's and the buttons' own
   *  attributes, and a state flag on an ancestor that answers the same
   *  selector as the thing it describes makes every querySelector in the page
   *  a coin toss. It matched the app before the button and cost an afternoon
   *  once already. */
  constructor(
    private readonly app: HTMLElement,
    private readonly bar: HTMLElement,
  ) {
    this.bar.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (!button) return;
      const name = button.dataset.tab!;
      // The open tab closes: on a phone the board wants the height back more
      // than it wants a fourth look at the standings.
      this.select(this.active === name ? null : name);
    });

    this.media.addEventListener("change", () => this.apply());

    // A panel can appear or vanish mid-game — the seats list when an empire
    // gains a second member, the chat column when the game is a mesh one —
    // and the tab row has to follow without anyone remembering to tell it.
    new MutationObserver(() => this.sync()).observe(this.app, {
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });

    this.apply();
  }

  /** Panels worth a tab: present, and not inside a section that is itself
   *  hidden — the chat aside goes entirely in a solo game. */
  private panels(): HTMLDetailsElement[] {
    return Array.from(this.app.querySelectorAll<HTMLDetailsElement>("[data-acc]")).filter(
      (panel) => !panel.hidden && !panel.closest("[hidden]"),
    );
  }

  private sync(): void {
    const panels = this.panels();
    const key = panels.map((panel) => panel.dataset.acc).join(",");
    if (key !== this.built) {
      this.built = key;
      this.bar.replaceChildren(
        ...panels.map((panel) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "tab";
          button.dataset.tab = panel.dataset.acc!;
          button.textContent = panel.querySelector("summary")?.textContent?.trim() ?? "";
          return button;
        }),
      );
    }

    // The active panel may have just gone: a game left, a seat lost.
    if (this.active && !panels.some((panel) => panel.dataset.acc === this.active)) {
      this.active = null;
    }
    // Note what is deliberately NOT here: picking a default when nothing is
    // open. Sync runs whenever an attribute changes anywhere in the app, which
    // is several times a second, and a default chosen here would reopen the
    // panel a moment after the reader shut it. Closed is a choice, so only
    // arriving on a narrow screen picks a panel.
    this.paint();
  }

  private get on(): boolean {
    return this.media.matches;
  }

  private apply(): void {
    this.app.dataset.tabbed = this.on ? "on" : "off";
    // Leaving narrow, the panels go back to being independently openable and
    // nothing should stay forced shut by a tab that is no longer on screen.
    if (!this.on) this.active = null;
    this.built = ""; // labels and membership are re-read on the way in
    this.sync();
    // Arriving on a narrow screen opens the first panel, so the tab row is
    // not a mystery bar with nothing under it.
    if (this.on && this.active === null) {
      this.active = this.panels()[0]?.dataset.acc ?? null;
      this.paint();
    }
  }

  private select(name: string | null): void {
    this.active = name;
    this.paint();
  }

  private paint(): void {
    this.app.dataset.panel = this.active ?? "";
    for (const button of this.bar.querySelectorAll<HTMLElement>("[data-tab]")) {
      const on = button.dataset.tab === this.active;
      button.classList.toggle("on", on);
      button.setAttribute("aria-selected", String(on));
    }
    // Only while tabbed. On a wide screen the panels are the reader's to open
    // and shut, and this would be reaching in and doing it for them.
    if (!this.on) return;
    for (const panel of this.panels()) {
      panel.open = panel.dataset.acc === this.active;
    }
  }
}
