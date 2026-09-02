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
//
// Muting lives here and only here. It is a decision about what this reader
// wants to see, so it needs no agreement, no log entry and no record type: two
// peers who disagree about whether someone is worth listening to still hold
// identical state. Anything that had to be agreed would be a rule about who may
// speak, which is a different and much worse feature.

import { STEPS_PER_SECOND } from "@tessera/sim";
import { CHANNEL } from "@tessera/protocol";
import type { Channel, Message } from "@tessera/protocol";
import { empireTheme } from "./palette";

/** Long enough to scroll back through a fight, short enough that a multi-day
 *  game does not accumulate a DOM node per line said since Tuesday. */
const MAX_LINES = 200;

/** The wire accepts 2048 characters. Stopping well short of it is a UI choice,
 *  not a protocol one: a chat line that needs a paragraph belongs elsewhere. */
const MAX_BODY = 280;

export interface ChatHooks {
  send: (body: string, channel: Channel) => void;
}

/** Game time, not wall-clock time: the step number is the one clock every peer
 *  already agrees on, so two players comparing screenshots see the same stamp. */
function stamp(step: number): string {
  const seconds = Math.floor(step / STEPS_PER_SECOND);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** Seats whose lines this reader has chosen not to see, keyed empire:member. */
const seatKey = (seat: { empire: number; member: number }): string =>
  `${seat.empire}:${seat.member}`;

export class ChatPanel {
  private readonly log: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly channel: HTMLSelectElement;
  private readonly muted = new Map<string, { empire: number; member: number }>();
  private readonly mutedBar: HTMLDivElement;
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

    // Only offered once the empire has someone else on it. A team channel with
    // an audience of one is a box that swallows what you type.
    this.channel = document.createElement("select");
    this.channel.className = "chat-channel";
    this.channel.append(
      new Option("All", String(CHANNEL.PUBLIC)),
      new Option("Team", String(CHANNEL.TEAM)),
    );

    const send = document.createElement("button");
    send.className = "btn";
    send.type = "submit";
    send.textContent = "Say";

    // Muting something you can no longer see has to be undoable from
    // somewhere, and the lines themselves are gone.
    this.mutedBar = document.createElement("div");
    this.mutedBar.className = "chat-muted";
    this.mutedBar.hidden = true;

    this.form = document.createElement("form");
    this.form.className = "chat-form";
    this.form.append(this.channel, this.input, send);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });

    this.root.replaceChildren(this.log, this.mutedBar, this.form);
    this.close();
  }

  /** Before a mesh game exists there is nobody to talk to, so the box says so
   *  rather than silently swallowing what someone types into it. */
  close(): void {
    // A new game is a new roster: empire 2 seat 1 is somebody else next time.
    this.muted.clear();
    this.renderMuted();
    this.you = undefined;
    this.input.disabled = true;
    this.input.value = "";
    this.input.placeholder = "Chat opens when you host or join a game";
    this.channel.disabled = true;
    this.channel.value = String(CHANNEL.PUBLIC);
  }

  open(seat: { empire: number; member: number }, teammates = 0): void {
    this.you = seat;
    this.input.disabled = false;
    this.input.placeholder = "Say something";
    this.channel.disabled = teammates === 0;
    this.channel.title = teammates === 0 ? "You are the only seat on this empire" : "";
  }

  private submit(): void {
    const body = this.input.value.trim().slice(0, MAX_BODY);
    this.input.value = "";
    if (!body || !this.you) return;
    this.hooks.send(body, Number(this.channel.value) as Channel);
  }

  /** A line nobody said: connection notices and the like. Local to this client,
   *  never signed, never sent. */
  note(text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line chat-note";
    line.textContent = text;
    this.append(line);
  }

  /** `text` is what the message says to us, and null when it says nothing:
   *  another empire's team traffic arrives here as ciphertext by design, and
   *  showing that it happened is better than pretending it did not. */
  add(message: Message, text: string | null): void {
    if (this.muted.has(seatKey(message))) return;

    const theme = empireTheme(message.empire);
    const mine =
      this.you?.empire === message.empire && this.you?.member === message.member;
    const team = message.channel === CHANNEL.TEAM;

    const line = document.createElement("div");
    line.className = `chat-line${mine ? " chat-mine" : ""}${team ? " chat-team" : ""}`;
    // So a later mute can take this line down with the rest of theirs.
    line.dataset.seat = seatKey(message);

    const when = document.createElement("span");
    when.className = "chat-when";
    when.textContent = stamp(message.step);

    const who = document.createElement("span");
    who.className = "chat-who";
    who.style.color = theme.c1;
    // The member index only earns its place once an empire has more than one
    // seat; until then it is noise on every single line.
    who.textContent = message.member > 0 ? `${theme.name}·${message.member}` : theme.name;
    if (!mine) {
      who.classList.add("chat-mutable");
      who.title = `Mute ${who.textContent}`;
      who.addEventListener("click", () =>
        this.mute({ empire: message.empire, member: message.member }, who.textContent!),
      );
    }

    const body = document.createElement("span");
    body.className = text === null ? "chat-body chat-sealed" : "chat-body";
    // Never message.body: on a team line that is the ciphertext, and on any
    // line it is a string another player chose.
    body.textContent = text ?? "sealed to their empire";

    line.append(when, who, body);
    if (team) {
      const mark = document.createElement("span");
      mark.className = "chat-mark";
      mark.textContent = "team";
      line.insertBefore(mark, body);
    }
    this.append(line);
  }

  private mute(seat: { empire: number; member: number }, name: string): void {
    this.muted.set(seatKey(seat), seat);
    // Their existing lines go too. Muting somebody and still reading them is
    // not what anyone means by it.
    for (const line of Array.from(this.log.children)) {
      if ((line as HTMLElement).dataset.seat === seatKey(seat)) line.remove();
    }
    this.renderMuted();
    this.note(`Muted ${name}.`);
  }

  private renderMuted(): void {
    this.mutedBar.replaceChildren();
    this.mutedBar.hidden = this.muted.size === 0;
    if (this.muted.size === 0) return;

    const label = document.createElement("span");
    label.className = "chat-muted-label";
    label.textContent = "Muted";
    this.mutedBar.append(label);

    for (const [key, seat] of this.muted) {
      const theme = empireTheme(seat.empire);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.style.color = theme.c1;
      chip.textContent = seat.member > 0 ? `${theme.name}·${seat.member}` : theme.name;
      chip.title = "Unmute";
      chip.addEventListener("click", () => {
        this.muted.delete(key);
        this.renderMuted();
      });
      this.mutedBar.append(chip);
    }
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
