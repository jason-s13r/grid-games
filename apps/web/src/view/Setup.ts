// Which game you are starting, and the one form that configures it.
//
// The screen used to be three cards at once: a settings card, a solo card and a
// multiplayer card side by side. That asked one question in three places. The
// settings said what the world would be and then two separate buttons claimed
// it, and the multiplayer card grew a room code, a player list and a start
// button of its own — a long way down the page from the settings it was
// starting.
//
// So this is a flow rather than a layout. You say what kind of game it is
// first, the same form appears either way, and one button starts it. A solo
// game and a hosted one are the same world with different seats in it, which is
// what lets them share a form at all; the only thing a hosted game adds is the
// people, and they belong above the settings rather than beside them.
//
// Joining is the third answer and not a mode of the second, because a joiner
// configures nothing: the host's genesis record decides the map, the length and
// the opponents, and offering a form that would be ignored is worse than
// offering none.
//
// Pure view state — never in the sim, never hashed, never sent.

/** Where the flow is. `live` is a mesh game already running: the panel below
 *  turns into the living roster, and there is nothing left to configure. */
export type SetupMode = "choose" | "solo" | "host" | "join" | "live";

/** What the game as configured comes to, and whether it can be started.
 *
 *  `problem` is what colours the line, and `ready` is what the button obeys;
 *  they are separate because "waiting for the broker to answer" is a reason to
 *  disable the button and not a thing anybody did wrong. */
export interface SetupSummary {
  note: string;
  problem: boolean;
  ready: boolean;
}

export interface SetupHandlers {
  /** Start the game the form describes. */
  start: (mode: "solo" | "host") => void;
  /** Open a room of our own; the code arrives when the broker answers. */
  host: () => void;
  /** Dial somebody else's code. */
  join: (code: string) => void;
  /** Put down whatever is open and go back to the choice. */
  back: () => void;
  /** Asked at render time rather than pushed in: the answer moves with the bot
   *  list and with the people in the room, and a copy kept here would be a
   *  third place for it to be wrong. */
  summary: (mode: "solo" | "host") => SetupSummary;
}

export interface SetupElements {
  /** The card the whole flow lives in. One delegated listener hangs here, and
   *  it is safe: the form and the panel below tag their own controls. */
  root: HTMLElement;
  head: HTMLElement;
  /** Map, length and opponents — one block of markup, shown for a solo game
   *  and a hosted one alike. */
  form: HTMLElement;
  /** Where the multiplayer panel draws: the room code and who is here while a
   *  game is being arranged, the living roster once one is running. */
  lobby: HTMLElement;
  foot: HTMLElement;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What the way out is called, which is not the same thing in each mode. A
 *  solo game has nothing open to put down, a room has been announced to
 *  whoever was sent the code, and a joined game is somebody else's. */
const BACK: Partial<Record<SetupMode, string>> = {
  solo: "Back",
  host: "Cancel",
  join: "Leave",
};

export class Setup {
  private mode: SetupMode = "choose";

  constructor(
    private readonly els: SetupElements,
    private readonly handlers: SetupHandlers,
  ) {
    this.els.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-setup-action]");
      if (!button) return;
      // The card sits inside a section that may one day be a form, and a bare
      // <button> defaults to submitting.
      event.preventDefault();
      switch (button.dataset.setupAction) {
        case "solo":
          return this.show("solo");
        case "host":
          this.show("host");
          return this.handlers.host();
        case "join":
          return this.dial();
        case "back":
          this.show("choose");
          return this.handlers.back();
        case "start":
          if (this.mode === "solo" || this.mode === "host") this.handlers.start(this.mode);
          return;
      }
    });

    // A code is something you paste and press return on. Without this the
    // field looks like it took the code and did nothing with it.
    this.els.root.addEventListener("keydown", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.dataset.setupCode === undefined) return;
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.dial();
    });

    this.render();
  }

  get current(): SetupMode {
    return this.mode;
  }

  /** A mesh game has started. Nothing here configures it any more — the record
   *  is sealed and every peer has checked it — so the form goes and the panel
   *  below becomes the living roster. */
  live(): void {
    this.show("live");
  }

  /** Back to the first question, from the way out that is not our button: the
   *  Leave in the bar above the board. */
  reset(): void {
    this.show("choose");
  }

  show(mode: SetupMode): void {
    this.mode = mode;
    this.render();
  }

  /** Redraw what depends on things outside this class — the count of empires,
   *  and whether the room is ready — without disturbing the mode. */
  refresh(): void {
    this.els.foot.innerHTML = this.foot();
  }

  render(): void {
    const configuring = this.mode === "solo" || this.mode === "host";
    this.els.form.hidden = !configuring;
    // A solo game has nobody to list, and the chooser has no room yet.
    this.els.lobby.hidden = this.mode === "choose" || this.mode === "solo";
    this.els.head.innerHTML = this.head();
    this.els.foot.innerHTML = this.foot();
  }

  private dial(): void {
    const input = this.els.root.querySelector<HTMLInputElement>("[data-setup-code]");
    const code = input?.value.trim();
    if (!code) return;
    this.show("join");
    this.handlers.join(code);
  }

  private head(): string {
    if (this.mode === "choose") {
      return `
        <h2>Start a game</h2>
        <p class="card-tag">A solo game runs in this tab against empires the
        simulation plays itself. A multiplayer one runs in everybody's tab at
        once, and nobody's is in charge.</p>
        <div class="setup-choose">
          <button class="btn setup-pick" type="button" data-setup-action="solo">Solo</button>
          <button class="btn setup-pick" type="button" data-setup-action="host">Host multiplayer</button>
        </div>
        <p class="hint setup-or">…or join a game somebody has sent you the code for:</p>
        <div class="lobby-actions">
          <input class="lobby-code" data-setup-code placeholder="room code" spellcheck="false" />
          <button class="btn" type="button" data-setup-action="join">Join</button>
        </div>`;
    }

    const title =
      this.mode === "solo"
        ? "Solo"
        : this.mode === "host"
          ? "Hosting a game"
          : this.mode === "join"
            ? "Joining a game"
            : "This game";
    const back = BACK[this.mode];

    return `
      <div class="setup-title">
        <h2>${title}</h2>
        ${back ? `<button class="btn btn-small" type="button" data-setup-action="back">${back}</button>` : ""}
      </div>
      ${
        this.mode === "solo"
          ? `<p class="card-tag">One empire of yours against the bot empires
             below, on your own machine.</p>`
          : ""
      }`;
  }

  private foot(): string {
    if (this.mode !== "solo" && this.mode !== "host") return "";
    const { note, problem, ready } = this.handlers.summary(this.mode);
    return `
      ${note ? `<p class="hint${problem ? " lobby-problem" : ""}">${escape(note)}</p>` : ""}
      <button class="btn primary" type="button" data-setup-action="start"${
        ready ? "" : " disabled"
      }>Start game</button>`;
  }
}
