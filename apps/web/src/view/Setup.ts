// The setup card: the one form that configures a game, and the button that
// starts it.
//
// Solo only for now. Online play comes back through the Cloudflare room, and
// the create and join screens it needs will be built around that rather than
// around this card.
//
// Pure view state — never in the sim, never hashed, never sent.

/** What the game as configured comes to, and whether it can be started.
 *
 *  `problem` is what colours the line, and `ready` is what the button obeys. */
export interface SetupSummary {
  note: string;
  problem: boolean;
  ready: boolean;
}

export interface SetupHandlers {
  /** Start the game the form describes. */
  start: () => void;
  /** Asked at render time: the answer moves with the bot list. */
  summary: () => SetupSummary;
}

export interface SetupElements {
  root: HTMLElement;
  head: HTMLElement;
  form: HTMLElement;
  foot: HTMLElement;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Setup {
  constructor(
    private readonly els: SetupElements,
    private readonly handlers: SetupHandlers,
  ) {
    this.els.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-setup-action]");
      if (!button) return;
      event.preventDefault();
      if (button.dataset.setupAction === "start") this.handlers.start();
    });

    this.render();
  }

  render(): void {
    this.els.form.hidden = false;
    this.els.head.innerHTML = `
      <h2>Solo</h2>
      <p class="card-tag">One empire of yours against the bot empires below,
      on your own machine.</p>`;
    this.refresh();
  }

  /** Redraw the summary line and the start button. */
  refresh(): void {
    const { note, problem, ready } = this.handlers.summary();
    this.els.foot.innerHTML = `
      ${note ? `<p class="hint${problem ? " lobby-problem" : ""}">${escape(note)}</p>` : ""}
      <button class="btn primary" type="button" data-setup-action="start"${
        ready ? "" : " disabled"
      }>Start game</button>`;
  }
}
