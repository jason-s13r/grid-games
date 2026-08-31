// The multiplayer panel: host a game, join one, see who is in it.
//
// Deliberately thin. It renders whatever the lobby says its phase is and turns
// clicks into lobby calls; it holds no state of its own beyond the text in the
// join box.

import type { Lobby } from "../net/Lobby";

export interface LobbyHandlers {
  host: () => void;
  join: (code: string) => void;
  start: () => void;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class LobbyPanel {
  private lobby?: Lobby;
  private status = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: LobbyHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-lobby-action]");
      if (!button) return;
      const action = button.dataset.lobbyAction;
      if (action === "host") this.handlers.host();
      if (action === "start") this.handlers.start();
      if (action === "join") {
        const input = this.root.querySelector<HTMLInputElement>("[data-lobby-code]");
        const code = input?.value.trim();
        if (code) this.handlers.join(code);
      }
    });
    this.render();
  }

  attach(lobby: Lobby): void {
    this.lobby = lobby;
    lobby.onChange = () => this.render();
    this.render();
  }

  /** The live line from the driver — peer count, or who we are waiting for. */
  setStatus(text: string): void {
    if (text === this.status) return;
    this.status = text;
    const el = this.root.querySelector("[data-lobby-status]");
    if (el) el.textContent = text;
  }

  render(): void {
    this.root.innerHTML = this.body();
    const el = this.root.querySelector("[data-lobby-status]");
    if (el) el.textContent = this.status;
  }

  private body(): string {
    const lobby = this.lobby;
    if (!lobby) {
      return `
        <p class="hint">Play with other people. No server holds the game — your
        browsers agree with each other.</p>
        <div class="lobby-actions">
          <button class="btn" data-lobby-action="host">Host a game</button>
        </div>
        <div class="lobby-actions">
          <input class="lobby-code" data-lobby-code placeholder="room code" spellcheck="false" />
          <button class="btn" data-lobby-action="join">Join</button>
        </div>`;
    }

    if (lobby.phase === "failed") {
      return `<p class="hint">Could not play: ${escape(lobby.problem)}</p>`;
    }
    if (lobby.phase === "connecting") {
      return `<p class="hint">Connecting…</p>`;
    }
    if (lobby.phase === "playing") {
      return `
        <p class="hint">Room <code>${escape(lobby.code)}</code></p>
        <p class="hint" data-lobby-status></p>`;
    }
    if (lobby.phase === "waiting") {
      return `
        <p class="hint">Joined <code>${escape(lobby.code)}</code>. Waiting for the
        host to start.</p>`;
    }

    const others = lobby.roster;
    return `
      <p class="hint">Share this room code:</p>
      <p class="lobby-room"><code>${escape(lobby.code)}</code></p>
      <p class="hint">${others.length + 1} player${others.length === 0 ? "" : "s"} here${
        others.length === 0 ? " — waiting for someone to join" : ""
      }.</p>
      <div class="lobby-actions">
        <button class="btn" data-lobby-action="start">Start the game</button>
      </div>`;
  }
}
