// The bot empires a solo game is played against, and how hard each one plays.
//
// A count and one difficulty would have been half a control. Bot empires are
// not interchangeable now that each carries its own profile: one hard opponent
// beside two easy ones is a different game from three of anything, and it is
// the more interesting one — the easy pair sprawl into thin ground you can take
// back, while the hard one builds something you have to prepare for.
//
// So this is a list rather than a number, and it renders itself, which the rest
// of the setup screen does not need to. Everything else there is a fixed choice
// in the markup; a list of rows that come and go is the one thing on it that
// cannot be.

import type { Difficulty } from "@tessera/sim";
import { EMPIRE_THEMES, empireTheme } from "./palette";

const LEVELS: Difficulty[] = ["easy", "steady", "hard"];

/** The player is empire 1, so the first rival is empire 2. */
const FIRST_RIVAL = 2;

/** As many rivals as the palette can still tell apart. Beyond this two empires
 *  wear the same colour, and a board you cannot read is not a harder game, only
 *  a worse one. */
const MAX_RIVALS = EMPIRE_THEMES.length - 1;

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Rivals {
  private levels: Difficulty[];

  constructor(
    private readonly root: HTMLElement,
    private readonly max = MAX_RIVALS,
    start: Difficulty[] = ["steady", "steady", "steady"],
  ) {
    this.levels = start.slice(0, max);

    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-rival-action]");
      if (!button) return;
      // A form control inside a card that may itself be inside a form: a bare
      // <button> defaults to submitting, which would reload the page.
      event.preventDefault();
      if (button.dataset.rivalAction === "add" && this.levels.length < this.max) {
        // A new one matches the last, because somebody who set two to hard and
        // then asked for a third meant the third to be hard too.
        this.levels.push(this.levels.at(-1) ?? "steady");
      }
      if (button.dataset.rivalAction === "drop") {
        this.levels.splice(Number(button.dataset.index), 1);
      }
      this.render();
    });

    this.root.addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      const at = select.dataset.rivalLevel;
      if (at === undefined) return;
      this.levels[Number(at)] = select.value as Difficulty;
      // Deliberately no redraw: the row's own colour and position have not
      // changed, and rebuilding the list under the pointer costs the player the
      // click they are in the middle of making.
    });

    this.render();
  }

  /** A copy, so a game already started cannot be re-pointed by the picker it
   *  was started from. */
  get list(): Difficulty[] {
    return [...this.levels];
  }

  private render(): void {
    const rows = this.levels
      .map((level, i) => {
        const theme = empireTheme(FIRST_RIVAL + i);
        return `
          <li class="lobby-seat">
            <span class="lobby-who" style="color:${theme.c1}">${escape(theme.name)}</span>
            <select class="lobby-team" data-rival-level="${i}">
              ${LEVELS.map(
                (one) => `<option value="${one}"${one === level ? " selected" : ""}>${one}</option>`,
              ).join("")}
            </select>
            <button class="btn lobby-drop" type="button" data-rival-action="drop"
                    data-index="${i}" title="Remove this empire">&times;</button>
          </li>`;
      })
      .join("");

    this.root.innerHTML = `
      <ul class="lobby-teams">${rows}</ul>
      ${
        this.levels.length === 0
          ? `<p class="hint">A game needs somebody to play against.</p>`
          : ""
      }
      <button class="btn" type="button" data-rival-action="add"${
        this.levels.length >= this.max ? " disabled" : ""
      }>Add a rival</button>`;
  }
}
