// The create page: one form for a solo game and an online one.
//
// A preset fills every choice at once; after that each choice is one tap.
// The less common ones (when it starts, whether it is listed, each bot on its
// own) are under More. The same page makes a solo game, minus the rows that
// only mean anything with other people in it.
//
// It holds its own state and renders it; main.ts reads what it asks for when
// the button is pressed. Pure view state: nothing here is sent until then.

import { hours, minutes } from "@tessera/sim";
import type { Difficulty } from "@tessera/sim";
import type { Rivals } from "./Rivals";
import { escape } from "./escape";

export type Mode = "solo" | "friends";
export type MapName = "small" | "medium" | "large";
export type StartWhen = "lobby" | "now" | "scheduled";
type Preset = "friends" | "marathon" | "quick";

export interface CreateState {
  mode: Mode;
  map: MapName;
  /** Game length in steps. */
  length: number;
  empires: number;
  seats: number;
  start: StartWhen;
  /** ms since the epoch, for a scheduled start. */
  startAt?: number;
  public: boolean;
}

export interface CreateHandlers {
  /** Start a solo game, or create an online one, from the state as it stands. */
  submit: (state: CreateState) => void;
  back: () => void;
}

export const MAPS: Record<MapName, { width: number; height: number; label: string }> = {
  small: { width: 96, height: 72, label: "Small" },
  medium: { width: 160, height: 112, label: "Medium" },
  large: { width: 256, height: 176, label: "Large" },
};

const LENGTHS: ReadonlyArray<{ label: string; steps: number }> = [
  { label: "15 min", steps: minutes(15) },
  { label: "1 hour", steps: hours(1) },
  { label: "6 hours", steps: hours(6) },
  { label: "1 day", steps: hours(24) },
  { label: "3 days", steps: hours(72) },
  { label: "10 days", steps: hours(240) },
];

const LEVELS: Difficulty[] = ["easy", "steady", "hard"];

const PRESETS: Record<Preset, { label: string; blurb: string; apply: Partial<CreateState> & { bots: number } }> = {
  friends: {
    label: "Friends",
    blurb: "A lobby; you start it when everyone's in.",
    apply: { map: "medium", empires: 2, seats: 2, bots: 1, start: "lobby", public: false },
  },
  marathon: {
    label: "Marathon",
    blurb: "Ten days, listed publicly, open to joiners for the first third.",
    apply: { map: "large", length: hours(240), empires: 4, seats: 3, bots: 2, start: "now", public: true },
  },
  quick: {
    label: "Quick",
    blurb: "Fifteen minutes, straight away.",
    apply: { map: "small", length: minutes(15), empires: 2, seats: 1, bots: 1, start: "now", public: false },
  },
};

export class CreatePage {
  state: CreateState;
  private preset: Preset | null = "friends";
  /** Whether More is open, kept across redraws. */
  private moreOpen = false;
  /** The length a new form starts on: 15 minutes, or what the Worker says. */
  private defaultLength = minutes(15);

  constructor(
    private readonly root: HTMLElement,
    private readonly rivals: Rivals,
    private readonly rivalsHome: HTMLElement,
    private readonly handlers: CreateHandlers,
  ) {
    this.state = {
      mode: "friends",
      map: "medium",
      length: this.defaultLength,
      empires: 2,
      seats: 2,
      start: "lobby",
      public: false,
    };

    root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-create]");
      if (!button) return;
      event.preventDefault();
      const [what, value = ""] = button.dataset.create!.split(":");
      this.choose(what!, value);
    });
    root.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.dataset.createField) return; // a bot row's own controls
      if (input.dataset.createField === "public") this.state.public = input.checked;
      if (input.dataset.createField === "start-at") {
        const at = Date.parse(input.value);
        if (Number.isFinite(at)) this.state.startAt = at;
        else delete this.state.startAt;
      }
      this.preset = null;
      this.render();
    });
    root.addEventListener(
      "toggle",
      (event) => {
        const details = event.target as HTMLDetailsElement;
        if (details.classList?.contains("create-more")) this.moreOpen = details.open;
      },
      true,
    );
    this.rivals.onChange = () => this.render();
    this.render();
  }

  /** Open the page for one kind of game. */
  open(mode: Mode): void {
    this.state.mode = mode;
    if (mode === "friends" && this.preset) this.applyPreset(this.preset);
    this.render();
  }

  /** The Worker's default length, once it has said. Moves a form nobody has
   *  touched; leaves one somebody has. */
  setDefaultLength(steps: number): void {
    if (this.state.length === this.defaultLength) this.state.length = steps;
    this.defaultLength = steps;
    if (this.preset === "friends") this.applyPreset("friends");
    this.render();
  }

  /** A solo game's settings as the page holds them. */
  get solo(): { map: { width: number; height: number }; length: number } {
    return { map: MAPS[this.state.map], length: this.state.length };
  }

  private choose(what: string, value: string): void {
    const s = this.state;
    switch (what) {
      case "mode": s.mode = value as Mode; break;
      case "preset": this.applyPreset(value as Preset); return this.render();
      case "map": s.map = value as MapName; break;
      case "length": s.length = Number(value); break;
      case "empires": s.empires = clamp(s.empires + Number(value), 1, 8); break;
      case "seats": s.seats = clamp(s.seats + Number(value), 1, 4); break;
      case "bots": this.rivals.fill(clamp(Number(value), 0, 6), this.rivals.level ?? "steady"); break;
      case "level": this.rivals.fill(this.rivals.count, value as Difficulty); break;
      case "start": s.start = value as StartWhen; break;
      case "back": return this.handlers.back();
      case "submit": return this.submit();
      default: return;
    }
    if (what !== "mode") this.preset = null;
    this.render();
  }

  private applyPreset(name: Preset): void {
    const { bots, ...rest } = PRESETS[name].apply;
    Object.assign(this.state, { length: this.defaultLength }, rest);
    this.rivals.fill(bots, this.rivals.level ?? "steady");
    this.preset = name;
  }

  private submit(): void {
    if (this.problem()) return;
    this.handlers.submit({ ...this.state });
  }

  /** Why the button cannot be pressed yet, or empty. */
  private problem(): string {
    const s = this.state;
    if (s.mode === "solo" && this.rivals.count < 1) return "A solo game needs at least one bot empire to play against.";
    if (s.mode === "friends" && s.empires + this.rivals.count < 2) return "Add a bot, or a second empire for people.";
    if (s.mode === "friends" && s.start === "scheduled" && !s.startAt) return "Pick when it starts.";
    return "";
  }

  render(): void {
    const s = this.state;
    const solo = s.mode === "solo";
    // Bots take the empire numbers after the people's, so each wears the
    // colour it will actually play.
    this.rivals.seat(solo ? 2 : s.empires + 1);
    const bots = this.rivals.count;
    const level = this.rivals.level;
    const problem = this.problem();

    const seg = (what: string, options: Array<[string, string]>, current: string): string =>
      `<div class="seg" role="group">${options
        .map(
          ([value, label]) =>
            `<button type="button" class="seg-btn${value === current ? " on" : ""}" aria-pressed="${value === current}"
               data-create="${what}:${value}">${label}</button>`,
        )
        .join("")}</div>`;
    const step = (what: string, value: number, unit: string, min: number, max: number): string =>
      `<div class="stepper">
         <button type="button" class="seg-btn" data-create="${what}:-1"${value <= min ? " disabled" : ""} aria-label="Fewer">&minus;</button>
         <span><b>${value}</b> ${unit}</span>
         <button type="button" class="seg-btn" data-create="${what}:1"${value >= max ? " disabled" : ""} aria-label="More">+</button>
       </div>`;

    const lengths = LENGTHS.some((l) => l.steps === s.length)
      ? LENGTHS
      : [...LENGTHS, { label: `${Math.round(s.length / minutes(1))} min`, steps: s.length }].sort((a, b) => a.steps - b.steps);

    const total = (solo ? 1 : s.empires) + bots;
    const summary = solo
      ? `You against ${bots} bot ${bots === 1 ? "empire" : "empires"}.`
      : `${s.empires} ${s.empires === 1 ? "empire" : "empires"} for people, up to ${s.seats} each, and ${bots} ${bots === 1 ? "bot" : "bots"}: ${total} in all.`;

    this.root.innerHTML = `
      <div class="create-head">
        <button type="button" class="btn btn-small" data-create="back">&larr; Back</button>
        <h2>New game</h2>
      </div>
      ${seg("mode", [["solo", "Solo, against bots"], ["friends", "With other people"]], s.mode)}

      ${
        solo
          ? ""
          : `<div class="presets">${(Object.keys(PRESETS) as Preset[])
              .map(
                (name) => `<button type="button" class="preset${this.preset === name ? " on" : ""}" data-create="preset:${name}">
                  <b>${PRESETS[name].label}</b><span>${PRESETS[name].blurb}</span></button>`,
              )
              .join("")}</div>`
      }

      <div class="create-rows">
        <div class="create-row"><span class="create-label">Map</span>
          ${seg("map", (Object.keys(MAPS) as MapName[]).map((m) => [m, MAPS[m].label]), s.map)}</div>
        <div class="create-row"><span class="create-label">Length</span>
          ${seg("length", lengths.map((l) => [String(l.steps), l.label]), String(s.length))}</div>
        ${
          solo
            ? ""
            : `<div class="create-row"><span class="create-label">Teams</span>
                 ${step("empires", s.empires, s.empires === 1 ? "empire" : "empires", 1, 8)}
                 ${step("seats", s.seats, s.seats === 1 ? "seat each" : "seats each", 1, 4)}</div>`
        }
        <div class="create-row"><span class="create-label">Bots</span>
          ${seg("bots", ["0", "1", "2", "3", "4", "5"].filter((n) => !solo || n !== "0").map((n) => [n, n]), String(bots))}
          ${bots > 0 ? seg("level", LEVELS.map((l) => [l, l[0]!.toUpperCase() + l.slice(1)]), level ?? "") : ""}</div>
      </div>

      <details class="create-more"${this.moreOpen || (level === null && bots > 0) ? " open" : ""}>
        <summary>More</summary>
        ${
          solo
            ? ""
            : `<div class="create-row"><span class="create-label">Starts</span>
                 ${seg("start", [["lobby", "When I press start"], ["now", "Straight away"], ["scheduled", "At a time"]], s.start)}</div>
               ${
                 s.start === "scheduled"
                   ? `<div class="create-row"><span class="create-label">At</span>
                        <input type="datetime-local" class="lobby-code" data-create-field="start-at"${
                          s.startAt ? ` value="${localInput(s.startAt)}"` : ""
                        } /></div>`
                   : ""
               }
               <label class="create-row field-check"><input type="checkbox" data-create-field="public"${s.public ? " checked" : ""} />
                 List it publicly, so anybody can find and join it</label>`
        }
        <p class="create-label">Each bot</p>
        <div class="create-rivals" data-create-rivals></div>
      </details>

      <p class="hint${problem ? " lobby-problem" : ""}">${escape(problem || summary)}</p>
      <button type="button" class="btn primary" data-create="submit"${problem ? " disabled" : ""}>
        ${solo ? "Start the game" : "Create the game"}</button>`;

    // The per-bot list keeps its own element (and its open sliders) across
    // renders: it is moved in, not redrawn.
    this.root.querySelector("[data-create-rivals]")!.append(this.rivalsHome);
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** A time as a datetime-local input wants it, in local time. */
function localInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
