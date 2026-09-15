// The strip under the topbar while a saved game is being watched.
//
// Split the way `Games` is, and for the same reason: `view(mood)` is a plain
// object a Node test can assert on, and `render()` turns it into a string. This
// package has no jsdom, and a view whose every judgement lives inside a template
// literal is a view nothing can check.
//
// The judgements worth checking are all about honesty under a long wait. A
// three-day game is three million steps, so "checking" and "building" are
// different phases with different bars and the strip says which one it is in;
// the timeline is drawn against the step the game actually reached rather than
// the length its record asked for, because a game that ended early ended early;
// and a refusal is the whole list of what was wrong with the file, never the
// first line of it.

import { clock } from "./Controls";

export type Mood =
  /** Signatures and the claimed hash, before anything is built. */
  | { kind: "checking" }
  | { kind: "building"; step: number; total: number }
  | { kind: "ready"; step: number; total: number }
  /** A seek in flight. The track stays where the player put it — snapping back
   *  and then forward again is worse than a moment of not knowing. */
  | { kind: "seeking"; step: number; total: number }
  | { kind: "refused"; problems: string[] };

export interface ScrubberView {
  /** What the strip says, in words. */
  label: string;
  /** 0–100, for the bar behind the track. */
  percent: number;
  /** Whether the track is draggable yet. */
  scrubbable: boolean;
  max: number;
  step: number;
  problems: string[];
  /** Whether a long job is in flight, and therefore whether stopping is a thing
   *  the player can do. */
  working: boolean;
}

export interface ScrubberHandlers {
  seek: (step: number) => void;
  /** Stop, and put the menu back. Cancelling a build and closing a finished
   *  replay are the same action from the player's side. */
  close: () => void;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const percentOf = (step: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, Math.round((step / total) * 100))) : 0;

export function view(mood: Mood): ScrubberView {
  if (mood.kind === "checking") {
    return {
      // Named as the thing it is doing rather than as a share of it: this phase
      // is one call into `verifyArchive`, which owns its own loop and reports
      // nothing on the way through. A bar that sat at zero for a minute would be
      // a worse lie than no bar.
      label: "Checking every signature in the log, and the state it claims to reach…",
      percent: 0,
      scrubbable: false,
      max: 0,
      step: 0,
      problems: [],
      working: true,
    };
  }

  if (mood.kind === "refused") {
    return {
      label:
        mood.problems.length === 1
          ? "That log did not check out."
          : `That log did not check out — ${mood.problems.length} problems.`,
      percent: 0,
      scrubbable: false,
      max: 0,
      step: 0,
      problems: mood.problems,
      working: false,
    };
  }

  const { step, total } = mood;
  if (mood.kind === "building") {
    return {
      label: `Building the timeline — ${clock(step)} of ${clock(total)}`,
      percent: percentOf(step, total),
      scrubbable: false,
      max: total,
      step,
      problems: [],
      working: true,
    };
  }

  return {
    label:
      mood.kind === "seeking"
        ? `Going to ${clock(step)}…`
        : `${clock(step)} of ${clock(total)} · step ${step.toLocaleString()}`,
    percent: percentOf(step, total),
    // Still draggable during a seek. The worker answers the last step asked for
    // and drops nothing, so a player dragging across a long game gets the frame
    // they stopped on rather than one from halfway through the gesture.
    scrubbable: true,
    max: total,
    step,
    problems: [],
    working: mood.kind === "seeking",
  };
}

export class Scrubber {
  private mood: Mood = { kind: "checking" };

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: ScrubberHandlers,
  ) {
    // Delegated, because the track and the button are replaced on every render.
    this.root.addEventListener("input", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.dataset.scrub === undefined) return;
      this.handlers.seek(Number(input.value));
    });
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest("[data-scrub-close]");
      if (button) this.handlers.close();
    });
    this.render();
  }

  set(mood: Mood): void {
    this.mood = mood;
    this.render();
  }

  render(): void {
    const shown = view(this.mood);
    this.root.innerHTML = `
      <div class="scrub-bar" style="--scrub: ${shown.percent}%">
        ${
          shown.scrubbable
            ? `<input class="scrub-track" type="range" data-scrub min="0" max="${shown.max}"
                 value="${shown.step}" step="1" aria-label="Step" />`
            : `<div class="scrub-progress"><span style="width: ${shown.percent}%"></span></div>`
        }
      </div>
      <div class="scrub-say">
        <span class="scrub-label">${escape(shown.label)}</span>
        <button class="btn btn-small" type="button" data-scrub-close>${
          shown.working ? "Stop" : "Close"
        }</button>
      </div>
      ${
        shown.problems.length > 0
          ? `<ul class="scrub-problems">${shown.problems
              .map((problem) => `<li>${escape(problem)}</li>`)
              .join("")}</ul>`
          : ""
      }`;
  }
}
