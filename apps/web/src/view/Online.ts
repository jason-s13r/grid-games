// The online card: connecting to a game, and its lobby while it fills up.
//
// It renders and reports clicks; main.ts owns the connection and decides what
// a click does. Creating a game is the create page's (view/Create.ts).

import type { LobbyView } from "@tessera/room";
import { empireTheme } from "./palette";
import { escape } from "./escape";

export interface OnlineHandlers {
  create: () => void;
  join: (input: string) => void;
  pick: (empire: number | null) => void;
  start: () => void;
  leave: () => void;
}

export interface OnlineElements {
  root: HTMLElement;
  /** Join box, status line and lobby. */
  body: HTMLElement;
}

type View =
  | { kind: "home"; problem?: string }
  | { kind: "connecting"; roomId: string; note: string }
  | { kind: "lobby"; roomId: string; lobby: LobbyView; me: string }
  | { kind: "playing"; roomId: string };

export class OnlinePanel {
  private view: View = { kind: "home" };

  constructor(
    private readonly els: OnlineElements,
    private readonly handlers: OnlineHandlers,
  ) {
    els.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-online-action]");
      if (!button) return;
      event.preventDefault();
      switch (button.dataset.onlineAction) {
        case "create":
          return handlers.create();
        case "join": {
          const input = els.root.querySelector<HTMLInputElement>("[data-online-code]");
          if (input?.value.trim()) handlers.join(input.value);
          return;
        }
        case "pick":
          return handlers.pick(button.dataset.empire === "" ? null : Number(button.dataset.empire));
        case "start":
          return handlers.start();
        case "leave":
          return handlers.leave();
        case "copy": {
          const link = els.root.querySelector<HTMLInputElement>("[data-online-link]");
          if (link) void navigator.clipboard?.writeText(link.value);
          return;
        }
      }
    });
    els.root.addEventListener("keydown", (event) => {
      const input = event.target;
      if (event.key !== "Enter" || !(input instanceof HTMLInputElement)) return;
      if (input.dataset.onlineCode === undefined) return;
      event.preventDefault();
      if (input.value.trim()) handlers.join(input.value);
    });

    this.render();
  }

  home(problem?: string): void {
    this.view = problem ? { kind: "home", problem } : { kind: "home" };
    this.render();
  }

  connecting(roomId: string, note = "Connecting…"): void {
    this.view = { kind: "connecting", roomId, note };
    this.render();
  }

  lobby(roomId: string, lobby: LobbyView, me: string): void {
    this.view = { kind: "lobby", roomId, lobby, me };
    this.render();
  }

  playing(roomId: string): void {
    this.view = { kind: "playing", roomId };
    this.render();
  }

  private render(): void {
    const { view } = this;
    this.els.body.innerHTML = this.body().trim();
    this.els.root.hidden = !this.els.body.innerHTML;
  }

  private body(): string {
    const view = this.view;
    switch (view.kind) {
      // Creating and joining are on the start page's header now; at home this
      // card has something to say only when something went wrong.
      case "home":
        return view.problem ? `<p class="hint lobby-problem">${escape(view.problem)}</p>` : "";
      case "connecting":
        return `
          ${this.title(view.roomId)}
          <p class="hint">${escape(view.note)}</p>`;
      case "playing":
        return `
          ${this.title(view.roomId)}
          <p class="hint">This game is running. Use <strong>Back to the game</strong> to return to it.</p>`;
      case "lobby":
        return this.lobbyBody(view.roomId, view.lobby, view.me);
    }
  }

  private title(roomId: string): string {
    return `
      <div class="setup-title">
        <h2>Game ${escape(roomId)}</h2>
        <button class="btn btn-small" type="button" data-online-action="leave">Leave</button>
      </div>`;
  }

  private lobbyBody(roomId: string, lobby: LobbyView, me: string): string {
    const link = `${location.origin}/g/${roomId}`;
    const mine = lobby.players.find((p) => p.key === me);
    const creator = lobby.creator === me;
    const name = (p: { name: string; key: string }): string => escape(p.name || `player ${p.key.slice(0, 6)}`);

    const empires = Array.from({ length: lobby.empires }, (_, i) => {
      const theme = empireTheme(i + 1);
      const here = lobby.players.filter((p) => p.empire === i);
      const full = here.length >= lobby.seatsPerEmpire;
      const action =
        mine?.empire === i
          ? `<button class="btn btn-small" type="button" data-online-action="pick" data-empire="">Leave empire</button>`
          : full
            ? `<span class="hint">full</span>`
            : `<button class="btn btn-small" type="button" data-online-action="pick" data-empire="${i}">Join</button>`;
      return `
        <li class="lobby-seat">
          <span class="swatch" style="background:${theme.c1}"></span>
          <span class="lobby-who"><strong>${escape(theme.name)}</strong>
            ${here.length ? `· ${here.map((p) => `${name(p)}${p.connected ? "" : " (away)"}`).join(", ")}` : `· <span class="hint">open</span>`}
          </span>
          ${action}
        </li>`;
    }).join("");

    const undecided = lobby.players.filter((p) => p.empire === null);
    const picked = lobby.players.some((p) => p.empire !== null);
    const startsAt = lobby.startsAt
      ? `<p class="hint">Starts on its own at ${escape(new Date(lobby.startsAt).toLocaleString())}.</p>`
      : "";

    return `
      ${this.title(roomId)}
      <p class="card-tag">Send this link to the people you are playing with.</p>
      <div class="lobby-actions">
        <input class="lobby-code" data-online-link readonly value="${escape(link)}" />
        <button class="btn" type="button" data-online-action="copy">Copy</button>
      </div>
      <ul class="lobby-teams">${empires}</ul>
      <p class="hint">${lobby.bots} bot ${lobby.bots === 1 ? "empire" : "empires"} as well. Up to
        ${lobby.seatsPerEmpire} ${lobby.seatsPerEmpire === 1 ? "player" : "players"} per empire; empires nobody
        picks stay open for people to claim after the start.</p>
      ${undecided.length ? `<p class="hint">Not picked yet: ${undecided.map(name).join(", ")}</p>` : ""}
      ${startsAt}
      ${
        creator
          ? `<div class="setup-foot"><button class="btn primary" type="button" data-online-action="start"${
              picked ? "" : " disabled"
            }>Start game</button></div>`
          : `<p class="hint">Waiting for the game's creator to start it.</p>`
      }`;
  }
}
