// The multiplayer part of the setup screen: the room code, who is in the room,
// and what our empire is being asked to sign once a game is running.
//
// Deliberately thin, and thinner than it was. It used to own the whole
// multiplayer card — the host and join buttons that opened a lobby, its own
// list of bot empires, the count line and the button that started the game.
// All of that was a second copy of questions the setup screen was already
// asking, so the flow moved to `Setup` and the opponents to `Rivals`, and what
// is left here is the one thing neither of those can know: who is actually
// connected, and which empire each of them is on.
//
// It holds no state of its own beyond the team assignment it is in the middle
// of collecting.

import { cleanName, displayName } from "@tessera/protocol";
import type { MemberKey } from "@tessera/protocol";
import { MAX_SEATS, composeTeams } from "@tessera/net";
import type { Lobby, LobbyPlayer } from "@tessera/net";
import { empireTheme } from "./palette";
import { escape } from "./escape";
import { proposalBody, proposalChrome } from "./Proposal";

export interface LobbyHandlers {
  /** Propose seating this key on our own empire. */
  invite: (key: MemberKey) => void;
  /** Add our signature to somebody else's proposal. */
  endorse: (empire: number, key: MemberKey) => void;
  /** Agree to somebody who asked. The first member to press this starts a
   *  proposal, everybody after them signs the one that exists — which is the
   *  driver's distinction, not this panel's. */
  admit: (empire: number, key: MemberKey) => void;
  /** Put our name to a world somebody has proposed. Signing is what seats you:
   *  the roster of a co-signed game *is* the set of people who signed it, so
   *  this button is the whole of joining one. */
  consent: (id: string) => void;
  /** How many human empires the picker has composed, so the bot rows on the
   *  shared form can be coloured with the empires they will actually hold. */
  seated?: (empires: number) => void;
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
  /** People who have asked our empire for a seat and whom nobody has proposed
   *  yet. No tally: the count belongs to the amendment in flight, not to the
   *  request, and it resets when that record expires. A row with a number on it
   *  would be claiming the request had progress of its own. */
  applications: Array<{ key: MemberKey; label: string; empire: number }>;
  /** True once the join window has closed. The panel says so instead of
   *  offering a vote that would be refused — the people are still here and
   *  still watching, so the list stays; only the button goes. */
  joinsClosed: boolean;
}

/** What the picker has made of the people in the room, for whoever is drawing
 *  the button that starts the game. */
export interface Seating {
  /** Member keys per empire, in seat order — what goes into the genesis. */
  empires: MemberKey[][];
  /** True while some empire holds more seats than every empire is allowed. */
  crowded: boolean;
}


export class LobbyPanel {
  private lobby?: Lobby;
  /** The live line from the driver, shown only while a game is running. */
  private status = "";
  /** Why there is no lobby, when a lobby was wanted. Kept apart from `status`
   *  on purpose: the driver overwrites that several times a second, and a
   *  failure that shares a field with a stopwatch is a failure that gets
   *  quietly wiped or, worse, redrawn as one. */
  private problem = "";
  private busy = false;
  /** Which empire each player is on, by key. Sparse on purpose: a player with
   *  no entry gets an empire of their own. */
  private readonly teams = new Map<MemberKey, number>();
  private roster: RosterView | null = null;
  /** What the roster looked like when it was last drawn. A game in progress
   *  offers this several times a second; redrawing an unchanged list would
   *  cancel the click the player is in the middle of making. */
  private drawn = "";

  /** Told after every redraw, because the sentence above the start button
   *  counts the empires this panel has just composed. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: LobbyHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const sign = (event.target as HTMLElement).closest<HTMLElement>("[data-proposal='sign']");
      if (sign?.dataset.id) return this.handlers.consent(sign.dataset.id);

      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-lobby-action]");
      if (!button) return;
      const action = button.dataset.lobbyAction;
      if (action === "invite" && button.dataset.key) this.handlers.invite(button.dataset.key);
      if (action === "admit" && button.dataset.key) {
        this.handlers.admit(Number(button.dataset.empire), button.dataset.key);
        return;
      }
      if (action === "endorse" && button.dataset.key) {
        this.handlers.endorse(Number(button.dataset.empire), button.dataset.key);
        return;
      }
      if (action === "consent" && button.dataset.proposal) {
        this.handlers.consent(button.dataset.proposal);
      }
    });

    this.root.addEventListener("change", (event) => {
      const select = event.target;
      if (!(select instanceof HTMLSelectElement)) return;
      const key = select.dataset.lobbyTeam;
      if (key === undefined) return;
      this.teams.set(key, Number(select.value));
      // The list of empires to choose from grows and shrinks with the
      // assignment, so the whole picker is rebuilt rather than patched.
      this.render();
    });
    this.render();
  }

  attach(lobby: Lobby): void {
    this.lobby = lobby;
    this.busy = false;
    this.problem = "";
    lobby.onChange = () => this.render();
    this.render();
  }

  /** Connecting to the broker takes a moment and downloads PeerJS. Without
   *  this the panel looks like the click did nothing. */
  connecting(): void {
    this.busy = true;
    this.problem = "";
    this.render();
  }

  detach(problem = ""): void {
    this.lobby = undefined;
    this.busy = false;
    this.problem = problem;
    this.render();
  }

  /** True once the broker has given us a room, which is the first moment a
   *  game could actually be sealed and broadcast. */
  get hosting(): boolean {
    return this.lobby?.phase === "hosting";
  }

  /** True while a lobby was wanted and there is none — a failed join, or a
   *  broker that could not be reached. */
  get failed(): boolean {
    return this.problem !== "" && !this.lobby;
  }

  /** The empires the host has arranged, and whether any of them is over the
   *  seat cap. Composed on demand rather than remembered, because people
   *  arrive and leave underneath it. */
  get seating(): Seating {
    const { empires } = this.compose();
    return { empires, crowded: empires.some((keys) => keys.length > MAX_SEATS) };
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
    this.onChange?.();
  }

  private body(): string {
    const lobby = this.lobby;
    if (!lobby) {
      // No lobby, no human empires but ours — so the bot rows on the shared
      // form are a solo game's again, whatever a lobby we have since left had
      // them showing.
      this.handlers.seated?.(1);
      if (this.busy) return `<p class="hint">Connecting…</p>`;
      return this.problem ? `<p class="hint lobby-problem">${escape(this.problem)}</p>` : "";
    }

    if (lobby.phase === "failed") {
      return `<p class="hint lobby-problem">Could not play: ${escape(lobby.problem)}</p>`;
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
        <p class="hint">Joined <code>${escape(lobby.shareable)}</code>. The host sets
        the map, the length and the opponents; the game starts when they do.</p>`;
    }
    if (lobby.phase === "composing") return this.tableBody(lobby);
    if (lobby.phase === "starting") {
      const secs = Math.ceil(lobby.startsIn / 1000);
      return `
        <p class="hint">Agreed. The game starts in ${secs} second${secs === 1 ? "" : "s"},
        at the instant in the record — so everybody begins on the same step rather
        than whenever their copy of it arrived.</p>
        <p class="hint" data-lobby-status></p>`;
    }

    const { players, teamOf, empires } = this.compose();
    const alone = players.length === 1;
    const crowded = empires.some((keys) => keys.length > MAX_SEATS);

    return `
      <p class="hint">Share this room:</p>
      <p class="lobby-room"><code>${escape(lobby.shareable)}</code></p>
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
      }`;
  }

  /** Worlds on the table, and the one button that matters.
   *
   *  A signer count and no tally: there is no threshold to reach, because the
   *  set of signatures *is* the roster. Four people signing is a game of four,
   *  not four votes out of some number — so the line says how many will be
   *  playing rather than how many are still needed.
   *
   *  The proposal screen proper — the duration control, the vacancy rows, the
   *  profile editor, the revision history — is 0014. This is the sign button on
   *  the panel that already exists, and nothing more. */
  /** Worlds on the table, as a shared sheet.
   *
   *  Two halves, and the split is the point. `proposalBody` is derived from the
   *  proposal and nothing else, so it is identical on every peer and two players
   *  are entitled to compare it. `proposalChrome` is this peer's — whether *this*
   *  key has signed, and how long is left — and is allowed to differ.
   *
   *  Nobody's controls are privileged. 0009 removed the host role, so any player
   *  may post a revision, and the only live count is how many people have agreed
   *  to *this* revision of the world. */
  private tableBody(lobby: Lobby): string {
    const worlds = lobby.proposals();
    if (worlds.length === 0) return `<p class="hint">Nothing on the table yet.</p>`;

    const sheets = worlds
      .map(
        (world) => `
        <div class="sheet">
          ${proposalBody(world.proposal)}
          ${proposalChrome(
            {
              mine: world.mine,
              signed: world.signers.length,
              rev: world.rev,
              startsIn: Math.max(0, world.proposal.startedAt - Date.now()),
            },
            world.id,
          )}
        </div>`,
      )
      .join("");

    return `
      <p class="hint">Share this room:</p>
      <p class="lobby-room"><code>${escape(lobby.shareable)}</code></p>
      <p class="hint">A game on the table. Signing it is what seats you \u2014 the
      players are whoever signed, so nobody can put you in a game you did not
      agree to, and nobody else signing changes the world you did.</p>
      ${sheets}`;
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
          shown(player),
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

    // Somebody who asked, and whom nobody has proposed yet. Once a member
    // agrees, the row moves to `asks` above with a tally on it — because from
    // that point there is a record in flight and a count that means something.
    const asked = view.watching
      ? ""
      : view.applications
          .map(
            (who) => `
        <li class="lobby-seat">
          <span class="lobby-who">${escape(who.label)}</span>
          ${
            view.joinsClosed
              ? `<span class="lobby-tally">the door is closed</span>`
              : `<button class="btn btn-small" data-lobby-action="admit"
            data-key="${escape(who.key)}" data-empire="${who.empire}">Let them in</button>`
          }
        </li>`,
          )
          .join("");

    // An observer cannot invite anyone: it holds no seat, so it is not part of
    // any empire's quorum and has nothing to offer. Past the join window
    // nobody can, so the button goes and the list stays: these people are
    // still here, still watching, and a button that lies is worse than none.
    const waiting = view.watching
      ? ""
      : view.waiting
          .map(
            (who) => `
        <li class="lobby-seat">
          <span class="lobby-who">${escape(who.label)}</span>
          ${
            view.joinsClosed
              ? `<span class="lobby-tally">the door is closed</span>`
              : `<button class="btn btn-small" data-lobby-action="invite"
            data-key="${escape(who.key)}">Offer a seat</button>`
          }
        </li>`,
          )
          .join("");

    return `
      ${
        view.watching
          ? `<p class="hint">You are watching this game. Your browser is checking
             every move like everyone else's — you just hold no seat. Ask an
             empire for one below, or wait for somebody to offer.</p>`
          : ""
      }
      ${asked ? `<p class="hint">Asking for a seat on your empire:</p><ul class="lobby-teams">${asked}</ul>` : ""}
      ${asks ? `<p class="hint">Asked to join your empire:</p><ul class="lobby-teams">${asks}</ul>` : ""}
      ${waiting ? `<p class="hint">Watching, and not playing:</p><ul class="lobby-teams">${waiting}</ul>` : ""}`;
  }

  /** Compose, then write the compacted numbers back, so the empire a player is
   *  on is always the empire they will actually hold. */
  private compose(): { players: LobbyPlayer[]; teamOf: number[]; empires: MemberKey[][] } {
    const players = this.lobby?.players() ?? [];
    const { teamOf, empires } = composeTeams(players, this.teams);
    players.forEach((player, i) => this.teams.set(player.key, teamOf[i]!));
    // Whoever draws the bot rows needs to know how many colours the people
    // have taken, or a bot row promises a colour somebody else is wearing.
    this.handlers.seated?.(empires.length);
    return { players, teamOf, empires };
  }
}

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${escape(value)}"${selected ? " selected" : ""}>${escape(label)}</option>`;

/** A player as a screen where a decision is made must show them.
 *
 *  **The fingerprint is not optional.** Nothing stops two players choosing
 *  `master5o1` and nothing should — uniqueness needs an authority to arbitrate,
 *  and there is no authority anywhere in this system by design. So the eight hex
 *  characters are the identity, the prefix is a convenience, and impersonation
 *  is made visible rather than prevented.
 *
 *  `cleanName` runs here as well as in the driver, because this is also where a
 *  **lobby** name lands and a lobby name has never been through anything: it
 *  rides an unauthenticated hello and proves nothing beyond "here is a key to
 *  seat me under". A bidi override in one would reverse the rendering of
 *  everything after it on the line, fingerprint included, and `escape()`
 *  replaces four characters and would let it straight through. */
const shown = (player: LobbyPlayer): string =>
  displayName(cleanName(player.name), player.label);
