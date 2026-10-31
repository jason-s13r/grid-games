// The game's settings, in a dialog over the board: the game keeps running
// behind it, and closing it puts you straight back.
//
// What can change is changeable here: your name, and (for the game's creator)
// whether an online game is listed publicly. What was sealed into the game at
// the start (map, length, teams, bots) is shown for reference.

import { CONTROL, STEPS_PER_SECOND } from "@tessera/sim";
import { chatChoices } from "./Create";
import type { State } from "@tessera/sim";
import type { GameSettings } from "@tessera/room";
import { escape } from "./escape";

export interface SettingsContext {
  state: State;
  /** Online only: the room's link, its settings, and whether you created it. */
  online?: { link: string; settings: GameSettings | undefined; mine: boolean };
  name: string;
  shownAs: string;
}

export interface SettingsHandlers {
  rename: (name: string) => void;
  setPublic: (value: boolean) => void;
  setChat: (mode: "open" | "team" | "off") => void;
}

export class GameSettingsDialog {
  private context: SettingsContext | undefined;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly body: HTMLElement,
    private readonly handlers: SettingsHandlers,
  ) {
    dialog.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target === dialog || target.closest("[data-settings-close]")) return dialog.close();
      if (target.closest("[data-settings-copy]")) {
        const input = body.querySelector<HTMLInputElement>("[data-settings-link]");
        if (input) void navigator.clipboard?.writeText(input.value);
      }
    });
    body.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.settings === "name") handlers.rename(input.value);
      if (input.dataset.settings === "public") handlers.setPublic(input.checked);
      if (input.dataset.settings === "chat") handlers.setChat(input.value as "open" | "team" | "off");
    });
  }

  get open(): boolean {
    return this.dialog.open;
  }

  show(context: SettingsContext): void {
    this.context = context;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Redraw with fresh facts (a setting changed elsewhere) if it is showing. */
  update(context: SettingsContext): void {
    if (!this.dialog.open) return;
    const focused = document.activeElement;
    // Leave the name field alone while it is being typed in.
    if (focused instanceof HTMLInputElement && focused.dataset.settings === "name") return;
    this.context = context;
    this.render();
  }

  private render(): void {
    const c = this.context;
    if (!c) return;
    const rules = c.state.genesis.rules;
    const length = rules.endStep > 0 ? duration(rules.endStep) : "no end";
    const left = rules.endStep > 0 ? duration(Math.max(0, rules.endStep - c.state.step)) : "";
    const window = rules.joinWindow ?? 0;
    const humans = c.state.genesis.empires.filter((e) => e.control === CONTROL.HUMAN).length;
    const bots = c.state.genesis.empires.length - humans;
    const online = c.online;

    this.body.innerHTML = `
      <section>
        <h3>You</h3>
        <label class="settings-field">Your name
          <input class="lobby-code" data-settings="name" maxlength="24" placeholder="kestrel"
            spellcheck="false" autocomplete="off" value="${escape(c.name)}" /></label>
        <p class="hint">${escape(c.shownAs)}</p>
        <button class="btn btn-small settings-account" type="button" data-account-open>Back up or move your player&hellip;</button>
      </section>

      ${
        online
          ? `<section>
              <h3>This game</h3>
              <div class="lobby-actions">
                <input class="lobby-code" data-settings-link readonly value="${escape(online.link)}" />
                <button class="btn" type="button" data-settings-copy>Copy</button>
              </div>
              <label class="field-check settings-check">
                <input type="checkbox" data-settings="public"${online.settings?.public ? " checked" : ""}${
                  online.mine ? "" : " disabled"
                } />
                List it publicly, so anybody can find and join it</label>
              <label class="settings-field">Chat
                <select class="lobby-code" data-settings="chat"${online.mine ? "" : " disabled"}>${chatChoices(online.settings?.chat ?? "open")}</select></label>
              <p class="hint">${
                online.mine
                  ? "Unlisted games can still be joined by anyone with the link."
                  : "Only the game's creator can change this."
              }</p>
            </section>`
          : ""
      }

      <section>
        <h3>Set at the start</h3>
        <dl class="settings-facts">
          <dt>Map</dt><dd>${c.state.width} × ${c.state.height}</dd>
          <dt>Length</dt><dd>${length}${left ? `, ${left} left` : ""}</dd>
          <dt>Empires</dt><dd>${humans} for people, up to ${rules.maxSeats} each, and ${bots} ${bots === 1 ? "bot" : "bots"}</dd>
          ${online && window > 0 ? `<dt>Joining</dt><dd>${c.state.step < window ? `open for ${duration(window - c.state.step)}` : "closed"}</dd>` : ""}
        </dl>
        <p class="hint">These are part of the game's rules, so they cannot change once it has started.</p>
      </section>`;
  }
}

function duration(steps: number): string {
  const minutes = Math.round(steps / STEPS_PER_SECOND / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${Math.round(hours / 24)} days`;
}
