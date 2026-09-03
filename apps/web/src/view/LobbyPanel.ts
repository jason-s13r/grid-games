// The multiplayer panel: host a game, join one, see who is in it.
//
// Deliberately thin. It renders whatever the lobby says its phase is and turns
// clicks into lobby calls; it holds no state of its own beyond the text in the
// join box.

import type { MemberKey } from "@tessera/protocol";
import { MAX_SEATS, composeTeams } from "@tessera/net";
import type { Difficulty } from "@tessera/sim";
import type { Lobby, LobbyPlayer } from "@tessera/net";
import { EMPIRE_THEMES, empireTheme } from "./palette";

export interface LobbyHandlers {
  host: () => void;
  join: (code: string) => void;
  /** Empires as the host has arranged them, each a list of member keys, plus
   *  however many whole SimBot empires to put in the world. */
  start: (plan: { empires: MemberKey[][]; simbots: Difficulty[] }) => void;
  /** Tear the lobby down and go back to the opening choice. Every dead end
   *  needs one, or the only way out of a failed join is a page reload. */
  leave: () => void;
  /** Propose seating this key on our own empire. */
  invite: (key: MemberKey) => void;
  /** Add our signature to somebody else's proposal. */
  endorse: (empire: number, key: MemberKey) => void;
}

/** The living roster of a game in progress: who is here without a seat, and
 *  what our empire is being asked to sign. */
export interface RosterView {
  /** True while we hold no seat ourselves. */
  watching: boolean;
  /** People connected to this game who hold no seat. */
  waiting: Array<{ key: MemberKey; label: string }>;
  /** Proposals our empire has been asked to endorse and has not yet. */
  asks: Array<{ key: MemberKey; label: string; empire: number; endorsed: number; needed: number }>;
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** SimBot empires the host can add. More than four and a small map has no
 *  room left for the people. */
const MAX_SIMBOTS = 4;

const LEVELS: Difficulty[] = ["easy", "steady", "hard"];

export class LobbyPanel {
  private lobby?: Lobby;
  private status = "";
  private busy = false;
  /** Which empire each player is on, by key. Sparse on purpose: a player with
   *  no entry gets an empire of their own. */
  private readonly teams = new Map<MemberKey, number>();
  /** One entry per bot empire, in the order they will be seated. Bot empires
   *  are not interchangeable now that each has its own difficulty, so this is
   *  a list rather than a count. */
  private simbots: Difficulty[] = ["steady"];
  private roster: RosterView | null = null;
  /** What the roster looked like when it was last drawn. A game in progress
   *  offers this several times a second; redrawing an unchanged list would
   *  cancel the click the player is in the middle of making. */
  private drawn = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: LobbyHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-lobby-action]");
      if (!button) return;
      const action = button.dataset.lobbyAction;
      if (action === "host") this.handlers.host();
      if (action === "add-bot" && this.simbots.length < MAX_SIMBOTS) {
        // New ones arrive matching the last, because somebody adding a third
        // opponent after setting two to hard meant the third to be hard too.
        this.simbots.push(this.simbots.at(-1) ?? "steady");
        this.render();
      }
      if (action === "drop-bot") {
        this.simbots.splice(Number(button.dataset.index), 1);
        this.render();
      }
      if (action === "start") this.handlers.start(this.plan());
      if (action === "leave") this.handlers.leave();
      if (action === "invite" && button.dataset.key) this.handlers.invite(button.dataset.key);
      if (action === "endorse" && button.dataset.key) {
        this.handlers.endorse(Number(button.dataset.empire), button.dataset.key);
      }
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
      const bot = select.dataset.lobbyLevel;
      if (key !== undefined) this.teams.set(key, Number(select.value));
      else if (bot !== undefined) this.simbots[Number(bot)] = select.value as Difficulty;
      else return;
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

  /** The roster as the driver sees it, offered continuously while playing. */
  setRoster(view: RosterView | null): void {
    const shape = view ? JSON.stringify(view) : "";
    if (shape === this.drawn) return;
    this.drawn = shape;
    this.roster = view;
    this.render();
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
        <p class="hint">Host a game and share the code, or join one someone sent
        you.</p>
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
        <p class="hint" data-lobby-status></p>
        ${this.rosterBody()}`;
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
    const count = empires.length + this.simbots.length;
    const alone = players.length === 1;
    const crowded = empires.some((keys) => keys.length > MAX_SEATS);
    // Room for one more bot empire only while the palette can still tell it
    // apart from everything else on the board.
    const room = Math.min(MAX_SIMBOTS, Math.max(0, EMPIRE_THEMES.length - empires.length));
    const ready = count >= 2 && !crowded;

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
             on one empire really is three times the pressure — which is why
             every empire is capped at ${MAX_SEATS} seats.</p>`
      }
      <ul class="lobby-teams">
        ${players.map((player, i) => this.seatRow(player, teamOf[i]!, empires.length)).join("")}
      </ul>
      ${
        crowded
          ? `<p class="hint lobby-problem">An empire may hold up to ${MAX_SEATS}
             seats. Every empire gets the same number, so no side can field more
             people than another.</p>`
          : ""
      }
      <p class="hint">Bot empires, each played by the simulation itself. Set them
      separately: one hard opponent and two easy ones is a different game from
      three of anything, and a better one.</p>
      <ul class="lobby-teams lobby-rivals">
        ${this.simbots.map((level, i) => this.rivalRow(level, empires.length + i + 1, i)).join("")}
      </ul>
      <div class="lobby-actions">
        <button class="btn" data-lobby-action="add-bot"${
          this.simbots.length >= room ? " disabled" : ""
        }>Add a bot empire</button>
      </div>
      ${
        count < 2
          ? `<p class="hint lobby-problem">A game needs at least two empires —
             put someone on their own, or add a bot empire.</p>`
          : `<p class="hint">${count} empires will be playing.</p>`
      }
      <div class="lobby-actions">
        <button class="btn" data-lobby-action="start"${ready ? "" : " disabled"}>Start the game</button>
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

  /** Who is here without a seat, and what we are being asked to sign.
   *
   *  Both live in the panel that is already on screen during a game, because
   *  both are answers to the same question — who is playing — and a marathon
   *  game changes its answer while you watch. */
  private rosterBody(): string {
    const view = this.roster;
    if (!view) return "";

    const asks = view.asks
      .map(
        (ask) => `
        <li class="lobby-seat">
          <span class="lobby-who" style="color:${empireTheme(ask.empire).c1}">${escape(ask.label)}
            <span class="lobby-tally">${ask.endorsed}/${ask.needed}</span></span>
          <button class="btn btn-small" data-lobby-action="endorse"
            data-key="${escape(ask.key)}" data-empire="${ask.empire}">Agree</button>
        </li>`,
      )
      .join("");

    // An observer cannot invite anyone: it holds no seat, so it is not part of
    // any empire's quorum and has nothing to offer.
    const waiting = view.watching
      ? ""
      : view.waiting
          .map(
            (who) => `
        <li class="lobby-seat">
          <span class="lobby-who">${escape(who.label)}</span>
          <button class="btn btn-small" data-lobby-action="invite"
            data-key="${escape(who.key)}">Offer a seat</button>
        </li>`,
          )
          .join("");

    return `
      ${
        view.watching
          ? `<p class="hint">You are watching this game. Your browser is checking
             every move like everyone else's — you just hold no seat. Ask a
             player to offer you one.</p>`
          : ""
      }
      ${asks ? `<p class="hint">Asked to join your empire:</p><ul class="lobby-teams">${asks}</ul>` : ""}
      ${waiting ? `<p class="hint">Watching, and not playing:</p><ul class="lobby-teams">${waiting}</ul>` : ""}`;
  }

  /** Compose, then write the compacted numbers back, so the empire a player is
   *  on is always the empire they will actually hold. */
  private compose(): { players: LobbyPlayer[]; teamOf: number[]; empires: MemberKey[][] } {
    const players = this.lobby?.players() ?? [];
    const { teamOf, empires } = composeTeams(players, this.teams);
    players.forEach((player, i) => this.teams.set(player.key, teamOf[i]!));
    return { players, teamOf, empires };
  }

  private plan(): { empires: MemberKey[][]; simbots: Difficulty[] } {
    return { empires: this.compose().empires, simbots: [...this.simbots] };
  }

  /** One bot empire: the colour it will play, how hard, and a way to change
   *  its mind about being here. */
  private rivalRow(level: Difficulty, empire: number, index: number): string {
    const theme = empireTheme(empire);
    return `
      <li class="lobby-seat">
        <span class="lobby-who" style="color:${theme.c1}">${escape(theme.name)}</span>
        <select class="lobby-team" data-lobby-level="${index}">
          ${LEVELS.map((one) => option(one, one, one === level)).join("")}
        </select>
        <button class="btn lobby-drop" data-lobby-action="drop-bot" data-index="${index}"
                title="Remove this empire">&times;</button>
      </li>`;
  }
}

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${escape(value)}"${selected ? " selected" : ""}>${escape(label)}</option>`;
