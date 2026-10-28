// The chat panel: what has been said in this game, and a box to say more.
//
// Lines come from the room and are only ever shown, never interpreted; every
// one is escaped on the way in. A team line is marked, because knowing a line
// was private is part of reading it.

import type { ChatLine } from "@tessera/room";
import { empireTheme } from "./palette";
import { escape } from "./escape";

export class ChatPanel {
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly channel: HTMLSelectElement;

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
      </form>`;
    this.log = root.querySelector("[data-chat-log]")!;
    this.input = root.querySelector("[data-chat-input]")!;
    this.channel = root.querySelector("[data-chat-channel]")!;
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
    this.channel.disabled = !seated;
    if (!seated) this.channel.value = "all";
  }

  add(lines: readonly ChatLine[], me: string): void {
    const pinned = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8;
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = `chat-line${line.key === me ? " chat-mine" : ""}`;
      const when = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const colour = line.empire ? empireTheme(line.empire).c1 : "inherit";
      const who = line.name || `player ${line.key.slice(0, 6)}`;
      row.innerHTML = `
        <span class="chat-when">${escape(when)}</span>
        ${line.channel === "team" ? `<span class="chat-mark">team</span>` : ""}
        <span class="chat-who" style="color:${colour}">${escape(who)}</span>
        <span class="chat-body">${escape(line.text)}</span>`;
      this.log.append(row);
    }
    // Follow the conversation, unless the reader has scrolled back to read.
    if (pinned) this.log.scrollTop = this.log.scrollHeight;
  }
}
