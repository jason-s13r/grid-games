// Chat, which is deliberately not part of the game.
//
// Messages are signed and attributable like moves, but they are never hashed
// into state — so one arriving late, out of order, or not at all cannot desync
// anybody. That is what lets this panel be as careless as a chat window should
// be: append on arrival, scroll, forget the old lines.
//
// Every body here came off the wire from another player, so it is written with
// textContent and never with innerHTML. A signature proves who wrote a message,
// not that what they wrote is safe to hand to a parser.

import { STEPS_PER_SECOND } from "@tessera/sim";
import type { Message } from "@tessera/protocol";
import { empireTheme } from "./palette";

/** Long enough to scroll back through a fight, short enough that a multi-day
 *  game does not accumulate a DOM node per line said since Tuesday. */
const MAX_LINES = 200;

/** The wire accepts 2048 characters. Stopping well short of it is a UI choice,
 *  not a protocol one: a chat line that needs a paragraph belongs elsewhere. */
const MAX_BODY = 280;

export interface ChatHooks {
  send: (body: string) => void;
}

/** Game time, not wall-clock time: the step number is the one clock every peer
 *  already agrees on, so two players comparing screenshots see the same stamp. */
function stamp(step: number): string {
  const seconds = Math.floor(step / STEPS_PER_SECOND);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export class ChatPanel {
  private readonly log: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private you?: { empire: number; member: number };

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: ChatHooks,
  ) {
    this.log = document.createElement("div");
    this.log.className = "chat-log";

    this.input = document.createElement("input");
    this.input.className = "chat-input";
    this.input.type = "text";
    this.input.maxLength = MAX_BODY;
    this.input.autocomplete = "off";

    const send = document.createElement("button");
    send.className = "btn";
    send.type = "submit";
    send.textContent = "Say";

    this.form = document.createElement("form");
    this.form.className = "chat-form";
    this.form.append(this.input, send);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });

    this.root.replaceChildren(this.log, this.form);
    this.close();
  }

  /** Before a mesh game exists there is nobody to talk to, so the box says so
   *  rather than silently swallowing what someone types into it. */
  close(): void {
    this.you = undefined;
    this.input.disabled = true;
    this.input.value = "";
    this.input.placeholder = "Chat opens when you host or join a game";
  }

  open(seat: { empire: number; member: number }): void {
    this.you = seat;
    this.input.disabled = false;
    this.input.placeholder = "Say something";
  }

  private submit(): void {
    const body = this.input.value.trim().slice(0, MAX_BODY);
    this.input.value = "";
    if (!body || !this.you) return;
    this.hooks.send(body);
  }

  /** A line nobody said: connection notices and the like. Local to this client,
   *  never signed, never sent. */
  note(text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line chat-note";
    line.textContent = text;
    this.append(line);
  }

  add(message: Message): void {
    const theme = empireTheme(message.empire);
    const mine =
      this.you?.empire === message.empire && this.you?.member === message.member;

    const line = document.createElement("div");
    line.className = mine ? "chat-line chat-mine" : "chat-line";

    const when = document.createElement("span");
    when.className = "chat-when";
    when.textContent = stamp(message.step);

    const who = document.createElement("span");
    who.className = "chat-who";
    who.style.color = theme.c1;
    // The member index only earns its place once an empire has more than one
    // seat; until then it is noise on every single line.
    who.textContent = message.member > 0 ? `${theme.name}·${message.member}` : theme.name;

    const body = document.createElement("span");
    body.className = "chat-body";
    body.textContent = message.body;

    line.append(when, who, body);
    this.append(line);
  }

  /** Stay pinned to the newest line unless the reader has scrolled up to read
   *  something, in which case yanking them back down is the wrong answer. */
  private append(line: HTMLElement): void {
    const pinned =
      this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;

    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
    if (pinned) this.log.scrollTop = this.log.scrollHeight;
  }
}
