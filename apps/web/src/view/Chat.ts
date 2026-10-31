// The chat panel: what has been said in this game, and a box to say more.
//
// Lines come from the room and are only ever shown, never interpreted; every
// one is escaped on the way in. A team line is marked, because knowing a line
// was private is part of reading it.

import type { ChatLine } from "@tessera/room";
import { empireTheme } from "./palette";
import { escape } from "./escape";

/** Players this browser has blocked, by key: their lines are not shown, in
 *  any game. Kept here and nowhere else; nobody is told. */
const BLOCKED_STORE = "tessera.blocked";

function loadBlocked(): Map<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(BLOCKED_STORE) ?? "[]") as Array<[string, string]>;
    return new Map(raw.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string"));
  } catch {
    return new Map();
  }
}

export class ChatPanel {
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly channel: HTMLSelectElement;
  private readonly form: HTMLFormElement;
  private readonly status: HTMLElement;
  private readonly blockedEl: HTMLElement;
  /** Key to the name it had when blocked, for the unblock list. */
  private readonly blocked = loadBlocked();
  private chatMode: "open" | "team" | "off" = "open";
  private isSeated = false;

  constructor(
    root: HTMLElement,
    private readonly section: HTMLElement,
    say: (text: string, channel: "all" | "team") => void,
  ) {
    root.innerHTML = `
      <div class="chat-log" data-chat-log aria-live="polite"></div>
      <form class="chat-form" data-chat-form>
        <select class="chat-channel" data-chat-channel aria-label="Who hears it">
          <option value="all">All</option>
          <option value="team">Team</option>
        </select>
        <input class="chat-input" data-chat-input maxlength="500" placeholder="Say something" autocomplete="off" />
      </form>
      <p class="chat-status hint" data-chat-status hidden></p>
      <div class="chat-blocked" data-chat-blocked hidden></div>`;
    this.log = root.querySelector("[data-chat-log]")!;
    this.input = root.querySelector("[data-chat-input]")!;
    this.channel = root.querySelector("[data-chat-channel]")!;
    this.form = root.querySelector("[data-chat-form]")!;
    this.status = root.querySelector("[data-chat-status]")!;
    this.blockedEl = root.querySelector("[data-chat-blocked]")!;
    // Click a name to block that player; click a blocked one to let them back.
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-block], [data-unblock]");
      if (!target) return;
      if (target.dataset.block) this.block(target.dataset.block, target.dataset.name ?? "");
      else this.unblock(target.dataset.unblock!);
    });
    this.showBlocked();
    root.querySelector("[data-chat-form]")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      say(text, this.channel.value === "team" ? "team" : "all");
      this.input.value = "";
    });
  }

  /** Show the panel for an online game, with its history. */
  open(lines: readonly ChatLine[], me: string, seated: boolean): void {
    this.section.hidden = false;
    this.log.innerHTML = "";
    this.add(lines, me);
    this.seated(seated);
  }

  close(): void {
    this.section.hidden = true;
    this.log.innerHTML = "";
  }

  /** Team chat needs an empire to be on. */
  seated(seated: boolean): void {
    this.isSeated = seated;
    this.applyMode();
  }

  /** Who may chat in this game, as its creator set it. */
  mode(mode: "open" | "team" | "off"): void {
    this.chatMode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    const mode = this.chatMode;
    this.form.hidden = mode === "off" || (mode === "team" && !this.isSeated);
    const all = this.channel.querySelector<HTMLOptionElement>('option[value="all"]')!;
    all.disabled = mode === "team";
    this.channel.disabled = !this.isSeated || mode === "team";
    this.channel.value = mode === "team" ? "team" : this.isSeated ? this.channel.value : "all";
    const say =
      mode === "off" ? "Chat is off in this game." : mode === "team" && !this.isSeated ? "Chat is team only in this game." : "";
    this.status.hidden = !say;
    this.status.textContent = say;
  }

  /** A word from the room about something just said, such as a refusal. */
  notice(text: string): void {
    const row = document.createElement("div");
    row.className = "chat-line chat-notice";
    row.textContent = text;
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private block(key: string, name: string): void {
    this.blocked.set(key, name);
    this.save();
    for (const row of this.log.querySelectorAll<HTMLElement>(`[data-from="${CSS.escape(key)}"]`)) row.remove();
    this.showBlocked();
  }

  private unblock(key: string): void {
    this.blocked.delete(key);
    this.save();
    this.showBlocked();
  }

  private save(): void {
    try {
      localStorage.setItem(BLOCKED_STORE, JSON.stringify([...this.blocked]));
    } catch {
      // A block that does not survive a reload still holds for now.
    }
  }

  private showBlocked(): void {
    this.blockedEl.hidden = this.blocked.size === 0;
    this.blockedEl.innerHTML = this.blocked.size
      ? `<span class="chat-muted-label">Blocked</span>${[...this.blocked]
          .map(([key, name]) => `<button type="button" class="chat-chip" data-unblock="${escape(key)}" title="Show their lines again">${escape(name || key.slice(0, 6))} &times;</button>`)
          .join("")}`
      : "";
  }

  add(lines: readonly ChatLine[], me: string): void {
    const pinned = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8;
    for (const line of lines) {
      if (this.blocked.has(line.key)) continue;
      const row = document.createElement("div");
      row.className = `chat-line${line.key === me ? " chat-mine" : ""}`;
      row.dataset.from = line.key;
      const when = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const colour = line.empire ? empireTheme(line.empire).c1 : "inherit";
      const who = line.name || `player ${line.key.slice(0, 6)}`;
      row.innerHTML = `
        <span class="chat-when">${escape(when)}</span>
        ${line.channel === "team" ? `<span class="chat-mark">team</span>` : ""}
        ${
          line.key === me
            ? `<span class="chat-who" style="color:${colour}">${escape(who)}</span>`
            : `<button type="button" class="chat-who chat-mutable" style="color:${colour}" data-block="${escape(line.key)}" data-name="${escape(who)}" title="Block ${escape(who)}: hide their lines, in every game">${escape(who)}</button>`
        }
        <span class="chat-body">${escape(line.text)}</span>`;
      this.log.append(row);
    }
    // Follow the conversation, unless the reader has scrolled back to read.
    if (pinned) this.log.scrollTop = this.log.scrollHeight;
  }
}
