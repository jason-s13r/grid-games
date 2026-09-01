// The multiplayer panel: host a game, join one, see who is in it.
//
// Deliberately thin. It renders whatever the lobby says its phase is and turns
// clicks into lobby calls; it holds no state of its own beyond the text in the
// join box.

import type { MemberKey } from "@tessera/protocol";
import type { Lobby, LobbyPlayer } from "../net/Lobby";
import { composeTeams } from "../net/teams";
import { empireTheme } from "./palette";

export interface LobbyHandlers {
  host: () => void;
  join: (code: string) => void;
  /** Empires as the host has arranged them, each a list of member keys, plus
   *  however many whole SimBot empires to put in the world. */
  start: (plan: { empires: MemberKey[][]; simbots: number }) => void;
  /** Tear the lobby down and go back to the opening choice. Every dead end
   *  needs one, or the only way out of a failed join is a page reload. */
  leave: () => void;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** SimBot empires the host can add. More than four and a small map has no
 *  room left for the people. */
const MAX_SIMBOTS = 4;

export class LobbyPanel {
  private lobby?: Lobby;
  private status = "";
  private busy = false;
  /** Which empire each player is on, by key. Sparse on purpose: a player with
   *  no entry gets an empire of their own. */
  private readonly teams = new Map<MemberKey, number>();
  private simbots = 1;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: LobbyHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-lobby-action]");
      if (!button) return;
      const action = button.dataset.lobbyAction;
      if (action === "host") this.handlers.host();
      if (action === "start") this.handlers.start(this.plan());
      if (action === "leave") this.handlers.leave();
      if (action === "join") {
        const input = this.root.querySelector<HTMLInputElement>("[data-lobby-code]");
        const code = input?.value.trim();
        if (code) this.handlers.join(code);
      }
    });

    this.root.addEventListener("change", (event) => {
      const select = event.target as HTMLSelectElement;
      if (!(select instanceof HTMLSelectElement)) return;
      const key = select.dataset.lobbyTeam;
      if (key !== undefined) this.teams.set(key, Number(select.value));
      else if (select.dataset.lobbySimbots !== undefined) {
        this.simbots = Number(select.value);
      } else return;
      // The list of empires to choose from grows and shrinks with the
      // assignment, so the whole picker is rebuilt rather than patched.
      this.render();
    });
    this.render();
  }

  attach(lobby: Lobby): void {
    this.lobby = lobby;
    this.busy = false;
    lobby.onChange = () => this.render();
    this.render();
  }

  /** Connecting to the broker takes a moment and downloads PeerJS. Without
   *  this the panel looks like the click did nothing. */
  connecting(): void {
    this.busy = true;
    this.render();
  }

  detach(problem = ""): void {
    this.lobby = undefined;
    this.busy = false;
    this.status = problem;
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
      if (this.busy) return `<p class="hint">Connecting…</p>`;
      return `
        ${this.status ? `<p class="hint lobby-problem">${escape(this.status)}</p>` : ""}
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
      return `
        <p class="hint lobby-problem">Could not play: ${escape(lobby.problem)}</p>
        <div class="lobby-actions">
          <button class="btn" data-lobby-action="leave">Back</button>
        </div>`;
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
        host to start.</p>
        <div class="lobby-actions">
          <button class="btn" data-lobby-action="leave">Leave</button>
        </div>`;
    }

    const { players, teamOf, empires } = this.compose();
    const count = empires.length + this.simbots;
    const alone = players.length === 1;

    return `
      <p class="hint">Share this room code:</p>
      <p class="lobby-room"><code>${escape(lobby.code)}</code></p>
      <p class="hint">${players.length} player${players.length === 1 ? "" : "s"} here${
        alone ? " — waiting for someone to join" : ""
      }.</p>
      ${
        alone
          ? ""
          : `<p class="hint">Put people on the same empire to play as a team. They
             share territory and each keep their own population timer, so three
             on one empire really is three times the pressure.</p>`
      }
      <ul class="lobby-teams">
        ${players.map((player, i) => this.seatRow(player, teamOf[i]!, empires.length)).join("")}
      </ul>
      <label class="lobby-field">Bot empires
        <select class="lobby-team" data-lobby-simbots>
          ${Array.from({ length: MAX_SIMBOTS + 1 }, (_, n) => option(String(n), String(n), n === this.simbots)).join("")}
        </select>
      </label>
      ${
        count < 2
          ? `<p class="hint lobby-problem">A game needs at least two empires —
             put someone on their own, or add a bot empire.</p>`
          : `<p class="hint">${count} empires will be playing.</p>`
      }
      <div class="lobby-actions">
        <button class="btn" data-lobby-action="start"${count < 2 ? " disabled" : ""}>Start the game</button>
        <button class="btn" data-lobby-action="leave">Cancel</button>
      </div>`;
  }

  private seatRow(player: LobbyPlayer, team: number, used: number): string {
    // One spare empire beyond those in use, so there is always somewhere to
    // move a player to. Anything more would be a list of empty choices.
    const choices = Array.from({ length: used + 1 }, (_, i) =>
      option(String(i), empireTheme(i + 1).name, i === team),
    );
    return `
      <li class="lobby-seat">
        <span class="lobby-who" style="color:${empireTheme(team + 1).c1}">${escape(
          player.label,
        )}${player.you ? " (you)" : ""}</span>
        <select class="lobby-team" data-lobby-team="${escape(player.key)}">${choices.join("")}</select>
      </li>`;
  }

  /** Compose, then write the compacted numbers back, so the empire a player is
   *  on is always the empire they will actually hold. */
  private compose(): { players: LobbyPlayer[]; teamOf: number[]; empires: MemberKey[][] } {
    const players = this.lobby?.players() ?? [];
    const { teamOf, empires } = composeTeams(players, this.teams);
    players.forEach((player, i) => this.teams.set(player.key, teamOf[i]!));
    return { players, teamOf, empires };
  }

  private plan(): { empires: MemberKey[][]; simbots: number } {
    return { empires: this.compose().empires, simbots: this.simbots };
  }
}

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${escape(value)}"${selected ? " selected" : ""}>${escape(label)}</option>`;
