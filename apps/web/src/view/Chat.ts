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
import type { Channel, MemberKey, Message } from "@tessera/protocol";
import { empireTheme } from "./palette";

/** Long enough to scroll back through a fight, short enough that a multi-day
 *  game does not accumulate a DOM node per line said since Tuesday. */
const MAX_LINES = 200;

/** The wire accepts 2048 characters. Stopping well short of it is a UI choice,
 *  not a protocol one: a chat line that needs a paragraph belongs elsewhere. */
const MAX_BODY = 280;

export interface ChatHooks {
  /** `to` is set only on a direct message, and is the recipient's key.
   *
   *  A DM is not a channel you select — it is a channel **plus a person** — and
   *  the two-option `<select>` this panel had could not express that. The
   *  obvious gesture for picking the person, clicking a name in a line, is
   *  already bound to muting and is not worth stealing for a panel 0014
   *  rebuilds. So the select carries the people instead: the smallest widget
   *  that makes the feature reachable, and no new gesture to unlearn. */
  send: (body: string, channel: Channel, to?: MemberKey) => void;
}

/** Somebody a direct message can be addressed to.
 *
 *  **Seated peers only.** There is no key directory outside the roster, so an
 *  observer — somebody asking for a seat, somebody just watching — cannot be
 *  written to. That is the cost of not inventing one here, and it falls on
 *  exactly the people most likely to want a private word. */
export interface Correspondent {
  key: MemberKey;
  /** `name#fingerprint`, because this is a list somebody picks from. */
  label: string;
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
  /** Keys addressable by DM, by the select value that names them. */
  private readonly correspondents = new Map<string, MemberKey>();

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
    this.correspondents.clear();
    this.rebuild(0, []);
    this.channel.value = String(CHANNEL.PUBLIC);
  }

  open(seat: { empire: number; member: number }, teammates = 0): void {
    this.you = seat;
    this.input.disabled = false;
    this.input.placeholder = "Say something";
    this.channel.disabled = false;
    this.channel.title = teammates === 0 ? "You are the only seat on this empire" : "";
    this.rebuild(teammates);
  }

  /** Who can be written to privately. Rebuilt as the roster changes — people
   *  arrive by amendment and by claim, and a list captured once would be a list
   *  of who was here when the game started. */
  setCorrespondents(people: readonly Correspondent[]): void {
    const chosen = this.channel.value;
    this.correspondents.clear();
    for (const one of people) this.correspondents.set(`dm:${one.key}`, one.key);
    this.rebuild(undefined, people);
    // Keep the reader's choice across a rebuild, unless the person they were
    // writing to has gone.
    if ([...this.channel.options].some((option) => option.value === chosen)) {
      this.channel.value = chosen;
    }
  }

  private rebuild(teammates?: number, people?: readonly Correspondent[]): void {
    const list = people ?? [...this.correspondents.entries()].map(([value, key]) => ({
      key,
      label: value.slice(3, 11),
    }));
    const options = [
      new Option("All", String(CHANNEL.PUBLIC)),
      ...(teammates === 0 ? [] : [new Option("Team", String(CHANNEL.TEAM))]),
      ...list.map((one) => new Option(`\u2192 ${one.label}`, `dm:${one.key}`)),
    ];
    this.channel.replaceChildren(...options);
  }

  private submit(): void {
    const body = this.input.value.trim().slice(0, MAX_BODY);
    this.input.value = "";
    if (!body || !this.you) return;
    const chosen = this.channel.value;
    const to = this.correspondents.get(chosen);
    if (to) return this.hooks.send(body, CHANNEL.DIRECT, to);
    this.hooks.send(body, Number(chosen) as Channel);
  }

  /** A line nobody said: connection notices and the like. Local to this client,
   *  never signed, never sent. */
  note(text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line chat-note";
    line.textContent = text;
    this.append(line);
  }

  /** `text` is what the message says to us, and null when it says nothing.
   *
   *  Another empire's team traffic arrives here as ciphertext by design, and
   *  used to be shown as a sealed line — the argument being that knowing an
   *  exchange happened is part of reading the game. In play it is not: it is a
   *  stranger's private conversation announcing itself in your log, several
   *  times a minute, saying nothing. Traffic analysis is not a feature anybody
   *  asked for. So a team line from an empire that is not yours is dropped
   *  outright, and the sealed rendering below now only covers the case that
   *  really is worth seeing — our own team's line that we could not open.
   *
   *  **A direct message follows the same rule, and needed the filter edited
   *  rather than extended.** A DM has no empire to compare against — it arrives
   *  from an arbitrary one and is addressed by key — so the old condition let
   *  every DM in the game through, and each would have rendered as "sealed to
   *  their empire" on every peer. That is exactly the noise the paragraph above
   *  says was removed, reintroduced by a channel the condition predates.
   *
   *  So `text === null` stops being sufficient to classify a line. It used to
   *  mean "our team, unopenable"; with DMs it means that *or* "not for us", and
   *  only `channel` separates them. */
  add(message: Message, text: string | null): void {
    if (this.muted.has(seatKey(message))) return;
    // Not for us: another empire's team traffic, or somebody else's private
    // word. Both are a stranger's conversation announcing itself.
    if (message.channel === CHANNEL.TEAM && message.empire !== this.you?.empire) return;
    if (message.channel === CHANNEL.DIRECT && text === null) return;

    const theme = empireTheme(message.empire);
    const mine =
      this.you?.empire === message.empire && this.you?.member === message.member;
    const team = message.channel === CHANNEL.TEAM;
    const direct = message.channel === CHANNEL.DIRECT;

    const line = document.createElement("div");
    line.className = `chat-line${mine ? " chat-mine" : ""}${team ? " chat-team" : ""}${
      direct ? " chat-direct" : ""
    }`;
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
    if (team || direct) {
      const mark = document.createElement("span");
      mark.className = "chat-mark";
      mark.textContent = team ? "team" : "direct";
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
