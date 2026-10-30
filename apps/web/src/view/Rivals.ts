// The bot empires a game is played against, and how hard each one plays.
//
// One control for both kinds of game. A solo game and a hosted one ask exactly
// the same question — which opponents are in the world — and answering it twice
// in two places is how the two answers drift: the lobby's copy of this list
// grew its own cap, its own default and its own idea of which colour a bot
// wears, none of which were the solo form's. So the list lives here, the setup
// screen holds one of it, and `seat()` tells it which empire number the first
// bot will hold — 2 in a solo game, and one past the last human empire in a
// hosted one.
//
// A count and one difficulty would have been half a control. Bot empires are
// not interchangeable now that each carries its own profile: one hard opponent
// beside two easy ones is a different game from three of anything, and it is
// the more interesting one — the easy pair sprawl into thin ground you can take
// back, while the hard one builds something you have to prepare for.
//
// The tuner underneath a row is the same idea taken one step further. The three
// presets are points on a scale somebody chose; a player who wants an opponent
// that never sleeps and never attacks should be able to have one, and the
// simulation has always been able to play it — `BotProfile` is in the genesis
// record, every number in it is bounded where it is read, and what was missing
// was a way to say so without editing source.

import { MAX_EMPIRES, empireTheme } from "./palette";
import { TUNING, tuneBot } from "@tessera/sim";
import type { BotChoice, BotMode, BotTuning, Difficulty } from "@tessera/sim";

const LEVELS: Difficulty[] = ["easy", "steady", "hard"];

/** The player is empire 1, so the first rival is empire 2 unless somebody says
 *  otherwise. A hosted game does: its human empires come first. */
const FIRST_RIVAL = 2;

/** The longest a phase may be set to. Three minutes is already a bot that does
 *  one thing for most of a short game; past that the slider is all the same
 *  bot. */
const MAX_PHASE = 180;

/** The phases, in the order the bot walks them, with the word a player would
 *  use for each. `heal` is "reconnect" here because that is what it does — the
 *  internal name is about the upkeep clock and means nothing on a setup
 *  screen. */
const PHASES: ReadonlyArray<{ mode: BotMode; label: string; hint: string }> = [
  { mode: "expand", label: "Expand", hint: "spread along its own border" },
  { mode: "attack", label: "Attack", hint: "walk at whoever is nearest" },
  { mode: "defend", label: "Defend", hint: "thicken the tiles under threat" },
  { mode: "fortify", label: "Fortify", hint: "thicken the capital and its ring" },
  { mode: "heal", label: "Reconnect", hint: "relieve a pocket before upkeep takes it" },
  { mode: "sleep", label: "Sleep", hint: "nothing at all, while population banks" },
];

/** One bot empire as the picker holds it. A row is either one of the three
 *  presets or a tuning of its own; `level` survives the switch either way, so
 *  going custom and changing your mind puts back the preset you started from
 *  rather than the last one in the list. */
interface Entry {
  level: Difficulty;
  custom: boolean;
  /** Only meaningful while `custom`. Seeded from `level` the moment the row
   *  becomes custom, so the sliders open where the preset was standing rather
   *  than at some neutral middle nobody chose. */
  tuning: BotTuning;
  /** Whether the sliders are showing. Closing them does not put the row back
   *  to a preset — it is a disclosure, not a cancel. */
  open: boolean;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clone = (tuning: BotTuning): BotTuning => ({ ...tuning, phases: { ...tuning.phases } });

export class Rivals {
  private entries: Entry[];
  /** The empire number the first bot will hold. Everything about how many bots
   *  fit and what colour they wear falls out of this. */
  private first = FIRST_RIVAL;

  /** Told whenever the number of bot empires changes, so a lobby showing "4
   *  empires will be playing" is showing the number that is actually true.
   *  Not told about a tuning: moving a slider changes what an opponent does and
   *  nothing at all about how many there are. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    start: Difficulty[] = ["steady", "steady", "steady"],
  ) {
    this.entries = start.map((level) => preset(level));
    this.trim();

    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-rival-action]");
      if (!button) return;
      // A form control inside a card that may itself be inside a form: a bare
      // <button> defaults to submitting, which would reload the page.
      event.preventDefault();
      const at = Number(button.dataset.index);
      if (button.dataset.rivalAction === "add" && this.entries.length < this.room) {
        // A new one matches the last, because somebody who set two to hard and
        // then asked for a third meant the third to be hard too — tuning
        // included, or "copy this one" would be the one thing the control
        // could not do.
        const last = this.entries.at(-1);
        this.entries.push(last ? { ...last, tuning: clone(last.tuning), open: false } : preset("steady"));
      }
      if (button.dataset.rivalAction === "drop") this.entries.splice(at, 1);
      if (button.dataset.rivalAction === "tune") {
        const entry = this.entries[at];
        if (entry) entry.open = !entry.open;
      }
      this.render();
      // Adding and dropping change how many empires are in the world, which is
      // a sentence the lobby beside this is in the middle of writing.
      if (button.dataset.rivalAction !== "tune") this.onChange?.();
    });

    this.root.addEventListener("change", (event) => {
      const select = event.target;
      // Ranges fire `change` too, at the end of a drag. They are handled on
      // `input` below and must not fall through to here, or every drag would
      // rebuild the list under the pointer that was doing the dragging.
      if (!(select instanceof HTMLSelectElement)) return;
      const at = Number(select.dataset.rivalLevel);
      const entry = this.entries[at];
      if (!entry) return;
      const was = entry.custom;

      if (select.value === "custom") {
        // Seed from wherever the row was standing. A tuner that opened on
        // defaults would throw away the choice the player had already made.
        entry.custom = true;
        entry.tuning = clone(TUNING[entry.level]);
        entry.open = true;
      } else {
        entry.level = select.value as Difficulty;
        entry.custom = false;
        entry.open = false;
      }
      // Only when the row changes shape. Swapping one preset for another moves
      // nothing on screen, and rebuilding the list for it would take the row
      // out from under the pointer that had just finished choosing.
      if (was !== entry.custom) this.render();
    });

    // Live, and deliberately without a redraw: rebuilding the list mid-drag
    // would drop the slider out from under the pointer. Only the number beside
    // the slider is written, and only where it changed.
    this.root.addEventListener("input", (event) => {
      const slider = event.target;
      if (!(slider instanceof HTMLInputElement)) return;
      const at = Number(slider.dataset.index);
      const entry = this.entries[at];
      if (!entry) return;
      const value = Number(slider.value);

      if (slider.dataset.tune === "popMax") entry.tuning.popMax = value;
      else if (slider.dataset.tune === "coins") entry.tuning.coins = value;
      else if (slider.dataset.phase) entry.tuning.phases[slider.dataset.phase as BotMode] = value;
      else return;

      const out = this.root.querySelector(`[data-out="${slider.id}"]`);
      if (out) out.textContent = readout(slider);
      this.sayIdle(at, entry);
    });

    this.render();
  }

  /** What to seat, as the lobby and the solo driver both want it: a preset name
   *  where the row is a preset, and a whole profile where it is not.
   *
   *  A copy, so a game already started cannot be re-pointed by the picker it
   *  was started from. */
  get list(): BotChoice[] {
    return this.entries.map((entry) => (entry.custom ? tuneBot(entry.tuning) : entry.level));
  }

  get count(): number {
    return this.entries.length;
  }

  /** Every bot at one preset level: what the create page's quick choices set.
   *  Tunings and per-row levels are replaced; the list below them shows the
   *  result and can still change any one row. */
  fill(count: number, level: Difficulty): void {
    this.entries = Array.from({ length: count }, () => preset(level));
    this.trim();
    this.render();
    this.onChange?.();
  }

  /** The one level every bot is at, or null when they differ or one is tuned. */
  get level(): Difficulty | null {
    const first = this.entries[0];
    if (!first || this.entries.some((e) => e.custom || e.level !== first.level)) return null;
    return first.level;
  }

  /** Which empire number the first bot holds. A solo game leaves this at 2; a
   *  hosted one moves it past the human empires as people are seated, so the
   *  colour beside a bot is the colour it will actually play. */
  seat(first: number): void {
    if (first === this.first) return;
    this.first = Math.max(1, first);
    if (this.trim()) this.onChange?.();
    this.render();
  }

  /** As many bots as the palette can still tell apart, once the humans have
   *  taken theirs. Two empires in one colour is not a harder game, only a
   *  board you cannot read. */
  private get room(): number {
    return Math.max(0, MAX_EMPIRES - this.first + 1);
  }

  /** Drop any bot there is no longer a colour for. Returns whether it had to.
   *  Silent on purpose: the row that goes is the last one added, and the count
   *  under the list says how many are left. */
  private trim(): boolean {
    if (this.entries.length <= this.room) return false;
    this.entries.length = this.room;
    return true;
  }

  private render(): void {
    const rows = this.entries.map((entry, i) => this.row(entry, i)).join("");

    this.root.innerHTML = `
      <ul class="lobby-teams">${rows}</ul>
      ${
        this.entries.length === 0
          ? `<p class="hint">No bot empires. A solo game needs at least one; a
             hosted game needs one only if there are not two sides without.</p>`
          : ""
      }
      <button class="btn" type="button" data-rival-action="add"${
        this.entries.length >= this.room ? " disabled" : ""
      }>Add a bot empire</button>`;

    this.entries.forEach((entry, i) => this.sayIdle(i, entry));
  }

  private row(entry: Entry, index: number): string {
    const theme = empireTheme(this.first + index);
    const chosen = entry.custom ? "custom" : entry.level;
    return `
      <li class="lobby-seat">
        <span class="lobby-who" style="color:${theme.c1}">${escape(theme.name)}</span>
        <select class="lobby-team" data-rival-level="${index}">
          ${[...LEVELS, "custom"]
            .map(
              (one) =>
                `<option value="${one}"${one === chosen ? " selected" : ""}>${
                  one === "custom" ? "custom…" : one
                }</option>`,
            )
            .join("")}
        </select>
        ${
          entry.custom
            ? `<button class="btn lobby-drop" type="button" data-rival-action="tune"
                       data-index="${index}" aria-expanded="${entry.open}"
                       title="${entry.open ? "Hide" : "Show"} this bot's settings">${
                         entry.open ? "&minus;" : "&hellip;"
                       }</button>`
            : ""
        }
        <button class="btn lobby-drop" type="button" data-rival-action="drop"
                data-index="${index}" title="Remove this empire">&times;</button>
      </li>
      ${entry.custom && entry.open ? this.tuner(entry, index) : ""}`;
  }

  /** Every number a player may turn, and none they may not.
   *
   *  Click rate is the deliberate omission. It belongs to the phase rather than
   *  to the bot — a bot is quick to grab empty ground and slow before a blow at
   *  held ground, whatever its difficulty — and a tempo knob beside the
   *  strength knob would let the second undo the first: a bot told to click
   *  faster never waits long enough for its own ceiling to bite, and difficulty
   *  would evaporate. So the tuner asks what the bot wants, and the simulation
   *  keeps deciding how fast it may ask for it. */
  private tuner(entry: Entry, index: number): string {
    const t = entry.tuning;
    return `
      <li class="tuner">
        <p class="hint">Strength is the population ceiling and nothing else: a
        claim spends <em>min(steps waited, ceiling)</em>, so a bot capped low
        banks the same as anybody and throws most of it away. Time in a phase is
        its appetite for that phase — the six are a cycle it walks in order, and
        a phase set to nothing is one it never enters.</p>

        ${slide(index, "popMax", "Strength", t.popMax, 50, 999, 1, "", "the most a claim can leave on a tile")}
        ${slide(index, "coins", "Coin appetite", t.coins, 0, 100, 1, "%", "chance of taking an adjacent coin instead")}

        <div class="tuner-phases">
          ${PHASES.map(({ mode, label, hint }) =>
            slide(index, mode, label, t.phases[mode] ?? 0, 0, MAX_PHASE, 5, "s", hint, true),
          ).join("")}
        </div>
        <p class="hint tuner-note" data-tuner-note="${index}"></p>
      </li>`;
  }

  /** A bot with no phases at all is a legitimate thing to ask for — the sim
   *  answers it with a bot that does nothing rather than one that invents work
   *  — but it is almost never what somebody meant, so say so where they can see
   *  it rather than letting them find out on the board. */
  private sayIdle(index: number, entry: Entry): void {
    const note = this.root.querySelector(`[data-tuner-note="${index}"]`);
    if (!note) return;
    const total = PHASES.reduce((sum, { mode }) => sum + (entry.tuning.phases[mode] ?? 0), 0);
    const awake = total - (entry.tuning.phases.sleep ?? 0);
    note.textContent =
      total === 0
        ? "Every phase is at nothing, so this empire will hold its capital and never move."
        : awake === 0
          ? "This empire does nothing but sleep. It will hold its capital and never move."
          : `A full cycle takes ${Math.floor(total / 60)} min ${total % 60} s.`;
  }
}

const preset = (level: Difficulty): Entry => ({
  level,
  custom: false,
  tuning: clone(TUNING[level]),
  open: false,
});

/** What the number beside a slider says. Read off the input rather than passed
 *  in, so the live update on drag and the one drawn with the row cannot say
 *  different things. */
const readout = (slider: HTMLInputElement): string =>
  `${slider.value}${slider.dataset.unit === "%" ? "%" : slider.dataset.unit === "s" ? " s" : ""}`;

function slide(
  index: number,
  key: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  hint = "",
  phase = false,
): string {
  const id = `tune-${index}-${key}`;
  const shown = unit === "%" ? `${value}%` : unit === "s" ? `${value} s` : `${value}`;
  return `
    <div class="tuner-row">
      <label for="${id}">${escape(label)}${
        hint ? ` <span class="tuner-hint">${escape(hint)}</span>` : ""
      }</label>
      <input type="range" id="${id}" data-index="${index}" data-unit="${escape(unit)}"
             ${phase ? `data-phase="${key}"` : `data-tune="${key}"`}
             min="${min}" max="${max}" step="${step}" value="${value}" />
      <output class="tuner-value" data-out="${id}">${escape(shown)}</output>
    </div>`;
}
