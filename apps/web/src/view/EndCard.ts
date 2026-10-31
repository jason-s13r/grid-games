// The end of a game, over the board.
//
// A game used to end with a strip along the bottom of the board, and on a phone
// that read as the game freezing: the clock kept saying "7d left", the board
// kept its colours, and nothing said it was over. This is the card that says
// so: who won, why, where you came, and the final standings, with the board
// dimmed behind it. "See the board" closes it, and a bar along the bottom of the
// board keeps a way back to it.
//
// The card is a dialog rather than part of the board: on a phone the board is a
// few hundred pixels tall and the standings would not fit on it, and the stage
// around it is a size container, which would hold even a fixed card inside it.
//
// Pure markup from the state, so it can be compared by `Controls.put` and only
// written when it changes, which after the end is once.

import { WIN, summarise } from "@tessera/sim";
import type { State } from "@tessera/sim";
import { placesOf } from "@tessera/room";
import { empireTheme } from "./palette";
import { span } from "./clock";

/** Rows in the card's table before it stops; your own row is added if it is
 *  further down. */
const SHOWN = 5;

export const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** The headline, from where the viewer sits. */
function headline(state: State, you: number): string {
  if (you > 0 && state.winner === you) return "You won!";
  if (state.winner > 0) return `${empireTheme(state.winner).name} wins`;
  return "Nobody won";
}

/** Why it ended, in a sentence a player would say. */
function reason(state: State): string {
  const name = state.winner > 0 ? empireTheme(state.winner).name : "";
  switch (state.winReason) {
    case WIN.TIMEOUT:
      return name ? `Time ran out with ${name} holding the most ground.` : "Time ran out.";
    case WIN.LAST_EMPIRE:
      return name ? `${name} is the last empire standing.` : "Every empire fell.";
    case WIN.LAST_ROSTER:
      return "Everyone else stopped playing.";
    default:
      return "";
  }
}

/** Tiles in the winner's colour and the house gold, falling behind the card.
 *  Fixed positions rather than random ones, so the markup is the same on every
 *  render. (A banner's second colour is often near-black, which reads as
 *  soot rather than confetti.) */
function confetti(winner: number): string {
  const { c1 } = empireTheme(winner);
  const colours = [c1, "var(--gold)", c1, "#fffdf2"];
  return `<div class="end-confetti" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => {
    const x = (i * 37) % 100;
    const delay = ((i * 7) % 12) / 10;
    const turn = (i % 2 ? 1 : -1) * (180 + ((i * 53) % 360));
    return `<i style="--x:${x}%;--d:${delay}s;--r:${turn}deg;--c:${colours[i % colours.length]}"></i>`;
  }).join("")}</div>`;
}

/** The card. `who` names an empire's people, as the standings do. */
export function endCard(state: State, you: number, who: (empire: number) => string): string {
  const placed = placesOf(state);
  const rows = summarise(state)
    .filter((e) => placed.has(e.id))
    .sort((a, b) => placed.get(a.id)! - placed.get(b.id)!);
  const shown = rows.slice(0, SHOWN);
  const yours = rows.find((e) => e.id === you);
  if (yours && !shown.includes(yours)) shown.push(yours);

  const place = you > 0 ? placed.get(you) : undefined;
  const won = you > 0 && state.winner === you;
  const accent = state.winner > 0 ? empireTheme(state.winner).c1 : "var(--muted)";

  const table = shown
    .map((e) => {
      const t = empireTheme(e.id);
      const cls = `end-row${e.id === you ? " you" : ""}${e.alive ? "" : " fell"}`;
      return `<li class="${cls}">
        <span class="end-place">${placed.get(e.id)}</span>
        <span class="swatch" data-banner="${t.id}"></span>
        <span class="end-name">${t.name}${who(e.id)}</span>
        <span class="end-tiles">${e.alive ? `${e.tilesOwned.toLocaleString()} tiles` : "fell"}</span>
      </li>`;
    })
    .join("");

  return `${won ? confetti(state.winner) : ""}
    <section class="end-card" aria-labelledby="end-title" style="--accent:${accent}">
      <p class="end-eyebrow">Game over</p>
      <h2 class="end-title" id="end-title">${
        state.winner > 0 ? `<span class="swatch" data-banner="${empireTheme(state.winner).id}"></span>` : ""
      }${headline(state, you)}</h2>
      <p class="end-why">${reason(state)}</p>
      ${place && !won ? `<p class="end-you">You came ${ordinal(place)}.</p>` : ""}
      <ol class="end-table">${table}</ol>
      <p class="end-length">Lasted ${span(state.step)}</p>
      <div class="end-actions">
        <button class="btn" type="button" data-end-hide>See the board</button>
        <button class="btn primary" type="button" data-end-home>Start page</button>
      </div>
    </section>`;
}

/** The card tucked away: a bar with a way back to it. */
export function endBar(state: State, you: number): string {
  const flag = state.winner > 0 ? `<span class="swatch" data-banner="${empireTheme(state.winner).id}"></span>` : "";
  return `<div class="end-bar">
    ${flag}<strong>${headline(state, you)}</strong>
    <span class="end-bar-why">Game over</span>
    <button class="btn btn-small" type="button" data-end-show>Results</button>
  </div>`;
}
