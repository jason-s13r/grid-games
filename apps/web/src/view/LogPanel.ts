// What happened, in two registers.
//
// **World events are identical on every peer**, because they are derived from
// hashed counters — an annexation, a coin, an elimination, an upkeep sweep, a
// seat arriving, a seat dropped. Two players comparing this stream see the same
// lines in the same order, and that is a property worth having and worth
// testing (`net/src/test/worldlog.test.ts`).
//
// **Session events are this tab's alone**: a peer connected, the transport
// reconnected, we resumed from a resume point, somebody was caught
// equivocating, our hash disagreed with the majority. Every one of those is
// true *here*, and a reader must never have to wonder which kind of line they
// are looking at — so they are drawn in a visibly different register and never
// interleaved into the shared account without a mark.
//
// Two constraints, both learned from the panel next door:
//
// - **Cap the DOM.** A multi-day game otherwise accumulates a node per line
//   said since Tuesday, and the log is noisier than chat.
// - **Read layout once per batch.** `Chat.append` reads `scrollHeight` before
//   every insertion to decide whether the reader is pinned. One line at a time
//   that is free; 240 lines out of one pump is 240 forced layouts.

import { escape } from "./escape";
import { empireTheme } from "./palette";
import { span, stamp } from "./clock";
import type { LogEvent } from "@tessera/net";

const MAX_LINES = 300;

/** Something that happened to this tab and to nobody else. */
export interface SessionEvent {
  step: number;
  text: string;
}

const sentence = (event: LogEvent): string => {
  const who = event.empire > 0 ? empireTheme(event.empire).name : "";
  const n = "count" in event ? (event.count ?? 0) : 0;
  const tiles = (count: number): string => `${count} tile${count === 1 ? "" : "s"}`;

  switch (event.kind) {
    case "took":
      return `${who} took ${tiles(n)}`;
    case "annexed":
      return `${who} annexed ${tiles(n)} from a fallen empire`;
    case "cascade":
      return `${who} set off a cascade across ${tiles(n)}`;
    case "coin":
      return `${who} picked up ${n} coin${n === 1 ? "" : "s"}`;
    case "diamond":
      return `${who} banked ${n} diamond${n === 1 ? "" : "s"}`;
    case "bridge":
      return `${who} built a bridge`;
    case "ladder":
      return `${who} raised a ladder`;
    case "march":
      return `${who} unlocked March`;
    case "eliminated":
      return `${who} was eliminated`;
    case "upkeep":
      return `Upkeep swept ${n.toLocaleString()} population off the board`;
    case "ended":
      return event.empire > 0 ? `${who} wins` : "The game ended with no winner";
    case "seated":
      return `${who} seated a new member`;
    case "dropped":
      return `${who} lost a seat`;
    default:
      return "";
  }
};

export class LogPanel {
  private readonly log: HTMLDivElement;
  private lines = 0;
  /** Where the reader was when they last had this panel open, so a returning
   *  player gets a divider rather than a wall. */
  private divided = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly panel: HTMLElement,
  ) {
    this.log = document.createElement("div");
    this.log.className = "log-lines";
    this.root.replaceChildren(this.log);
  }

  open(): void {
    if (this.panel.hidden) this.panel.hidden = false;
  }

  close(): void {
    if (!this.panel.hidden) this.panel.hidden = true;
    this.log.replaceChildren();
    this.lines = 0;
    this.divided = false;
  }

  /** Shared lines. A batch at a time, because a pump can deliver 240 steps at
   *  once and the layout read below must not happen 240 times. */
  world(events: readonly LogEvent[]): void {
    this.append(
      events.map((event) => this.line(event.step, sentence(event), "log-world")),
    );
  }

  /** This tab's own. Visibly a different thing from the lines above it. */
  session(event: SessionEvent): void {
    this.append([this.line(event.step, event.text, "log-session")]);
  }

  /** What a returning player is honestly told about the gap.
   *
   *  **Not a scrollback.** A tab that reloaded adopted a snapshot and never
   *  simulated the intervening steps — the moves that built that state were
   *  broadcast before it was listening, and nobody will send them again — so
   *  there are no events to derive and no amount of UI produces them. A marker
   *  and a number is what this design can honestly say; anything better has to
   *  come from a peer that was present, or from the archive. */
  gap(steps: number, atStep: number): void {
    if (steps <= 0) return;
    const divider = document.createElement("div");
    divider.className = "log-line log-gap";
    divider.textContent = `you were away for ${span(steps)} — the game moved on without this tab`;
    this.push(divider);
    this.divided = true;
    void atStep;
  }

  private line(step: number, text: string, cls: string): HTMLElement {
    const line = document.createElement("div");
    line.className = `log-line ${cls}`;
    const when = document.createElement("span");
    when.className = "log-when";
    when.textContent = stamp(step);
    const body = document.createElement("span");
    body.className = "log-body";
    // Never innerHTML: every empire name is from a table, but a session line
    // can carry a transport's own error text, which is a string from a stranger.
    body.textContent = text;
    line.append(when, body);
    return line;
  }

  /** One layout read for the whole batch, and one trim afterwards. */
  private append(nodes: HTMLElement[]): void {
    if (nodes.length === 0) return;
    const pinned =
      this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    for (const node of nodes) this.push(node);
    if (pinned) this.log.scrollTop = this.log.scrollHeight;
  }

  private push(node: HTMLElement): void {
    this.log.append(node);
    this.lines++;
    // A multi-day game is the load case. Trimming from the front keeps the
    // newest, which is what a reader scrolled to the bottom is looking at.
    while (this.lines > MAX_LINES && this.log.firstChild) {
      this.log.removeChild(this.log.firstChild);
      this.lines--;
    }
    void this.divided;
  }
}
