// The online card: connecting to a game, and its lobby while it fills up.
//
// It renders and reports clicks; main.ts owns the connection and decides what
// a click does. Creating a game is the create page's (view/Create.ts).

import type { LobbyView } from "@tessera/room";
import type { BannerId } from "@tessera/sim";
import { bannerById } from "./palette";
import { flag, housesHtml, lobbyHouses } from "./Houses";
import { escape } from "./escape";

export interface OnlineHandlers {
  create: () => void;
  join: (input: string) => void;
  /** A house to fly, or null to stand back. */
  pick: (banner: BannerId | null) => void;
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
  /** Set once the constructor is done. See render(). */
  private ready = false;

  constructor(
    private readonly els: OnlineElements,
    private readonly handlers: OnlineHandlers,
  ) {
    els.root.addEventListener("click", (event) => {
      const house = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-house]");
      if (house && !house.disabled) {
        event.preventDefault();
        // Pressing your own house again is standing back from it.
        return handlers.pick(house.getAttribute("aria-pressed") === "true" ? null : house.dataset.house!);
      }
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
        case "stand-back":
          return handlers.pick(null);
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
    this.ready = true;
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
    // Arrived by a game link and now past "Connecting…": the start page's
    // lists can come back (see index.html). Not on the first, constructor's
    // render, which comes before the link is followed.
    if (this.ready && view.kind !== "connecting") document.documentElement.removeAttribute("data-arriving");
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

    const players = lobby.players.map((p) => ({
      key: p.key,
      banner: p.banner,
      html: `${name(p)}${p.key === me ? " (you)" : ""}${p.connected ? "" : " (away)"}`,
    }));
    const houses = lobbyHouses(players, me, lobby.empires, lobby.seatsPerEmpire);
    const taken = new Set(lobby.players.flatMap((p) => (p.banner ? [p.banner] : []))).size;
    const myHouse = bannerById(mine?.banner ?? undefined);

    const undecided = lobby.players.filter((p) => p.banner === null);
    const picked = taken > 0;
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
      <div class="lobby-you">
        ${
          myHouse
            ? `${flag(myHouse)}<span>You fly <strong>${escape(myHouse.name)}</strong>.</span>
               <button class="btn btn-small" type="button" data-online-action="stand-back">Stand back</button>`
            : `<span>Pick the house you will play as. Pick one somebody already has to join their empire.</span>`
        }
      </div>
      <p class="hint lobby-tally">${taken} of ${lobby.empires} ${lobby.empires === 1 ? "empire" : "empires"} taken · up to
        ${lobby.seatsPerEmpire} ${lobby.seatsPerEmpire === 1 ? "player" : "players"} each · ${lobby.bots} bot
        ${lobby.bots === 1 ? "empire" : "empires"} as well. Empires nobody picks stay open for people to claim
        after the start.</p>
      ${housesHtml(houses, "house")}
      ${undecided.length ? `<p class="hint">Not picked yet: ${undecided.map(name).join(", ")}</p>` : ""}
      ${startsAt}
      ${
        creator
          ? `<div class="setup-foot"><button class="btn primary" type="button" data-online-action="start"${
              picked ? "" : " disabled"
            }>Start game</button></div>`
          : lobby.startsAt
            ? `<p class="hint">Pick a house before then to play: a game nobody has picked one in by the start is called off.</p>`
            : `<p class="hint">Waiting for the game's creator to start it.</p>`
      }`;
  }
}
