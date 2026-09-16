// Who is here, who has asked, and which empires nobody is playing.
//
// **This content already existed and could not be reached.** It was rendered by
// `LobbyPanel.rosterBody` into `[data-lobby]`, which lives inside
// `<section class="screen" data-menu>` — and `Shell.show` sets that element
// `hidden` from the moment a game starts. So the invitation list was rebuilt
// five times a second, with an Agree button on every row, into a subtree with
// `display: none` on it. The only control that goes the other way is Leave,
// which closes the lobby and drops the mesh: the one way to look at the panel
// destroyed the thing it was about.
//
// So this panel is a **move**, not a rewrite. What it adds is the third list —
// empires nobody is playing, which 0010 made a thing you can do something about
// — and names on every row, which 0012 made possible.

import { escape } from "./escape";
import { empireTheme } from "./palette";
import type { MemberKey } from "@tessera/protocol";

export interface PeopleHandlers {
  /** Propose seating this key on our own empire. */
  invite: (key: MemberKey) => void;
  /** Add our signature to a proposal somebody else started. */
  endorse: (empire: number, key: MemberKey) => void;
  /** Agree to somebody who asked. The first member to press this starts a
   *  proposal; everybody after them signs the one that exists. */
  admit: (empire: number, key: MemberKey) => void;
  /** Take an empire nobody is playing. Needs nobody's approval, and the screen
   *  must not imply otherwise. */
  claim: (empire: number) => void;
}

export interface PeopleView {
  /** True while we hold no seat ourselves. */
  watching: boolean;
  /** True once the join window has closed. Both doors close on the same line. */
  joinsClosed: boolean;
  /** People connected to this game who hold no seat. */
  waiting: Array<{ key: MemberKey; label: string }>;
  /** Proposals our empire has been asked to sign and has not yet. */
  asks: Array<{ key: MemberKey; label: string; empire: number; endorsed: number; needed: number }>;
  /** People who asked our empire for a seat and whom nobody has proposed yet.
   *  No tally: the count belongs to the amendment in flight, not to the
   *  request, and it resets when that record expires. */
  applications: Array<{ key: MemberKey; label: string; empire: number }>;
  /** Empires nobody has taken. */
  vacancies: Array<{ empire: number; label: string }>;
}

export class RosterPanel {
  /** The last view rendered, as a key.
   *
   *  `LobbyPanel` keeps one of these and says why: "redrawing an unchanged list
   *  would cancel the click the player is in the middle of making." This panel
   *  holds four lists of buttons and is fed from a 200 ms block, so it needs
   *  the same guard for the same reason. */
  private drawn = "";
  private view: PeopleView | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly handlers: PeopleHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-people]");
      if (!button) return;
      const key = button.dataset.key;
      const empire = Number(button.dataset.empire);
      switch (button.dataset.people) {
        case "invite": return key ? this.handlers.invite(key) : undefined;
        case "endorse": return key ? this.handlers.endorse(empire, key) : undefined;
        case "admit": return key ? this.handlers.admit(empire, key) : undefined;
        case "claim": return this.handlers.claim(empire);
      }
    });
  }

  set(view: PeopleView | null): void {
    const key = view ? JSON.stringify(view) : "";
    if (key === this.drawn) return;
    this.drawn = key;
    this.view = view;
    this.render();
  }

  private render(): void {
    const view = this.view;
    // Hidden rather than empty: an empty panel with a tab on a phone costs a
    // row of height to say nothing. Written only when it changed, because
    // `Tabs` watches the subtree for `hidden` and the same value still counts
    // as a mutation.
    const worth =
      !!view &&
      (view.waiting.length > 0 ||
        view.asks.length > 0 ||
        view.applications.length > 0 ||
        view.vacancies.length > 0);
    if (this.panel.hidden === worth) this.panel.hidden = !worth;
    if (!view) {
      this.root.replaceChildren();
      return;
    }

    this.root.innerHTML = [
      view.watching
        ? `<p class="hint">You are watching this game. Your browser is checking every
           move like everyone else's — you just hold no seat.</p>`
        : "",
      // A vacancy needs nobody's permission, so it is the one list with no
      // tally, no quorum and no waiting.
      this.list(
        "Nobody is playing these",
        view.vacancies.map(
          (one) => `
          <li class="lobby-seat">
            <span class="lobby-who" style="color:${empireTheme(one.empire).c1}">${escape(one.label)}</span>
            ${
              view.watching && !view.joinsClosed
                ? `<button class="btn btn-small" type="button" data-people="claim"
                     data-empire="${one.empire}">Take it</button>`
                : `<span class="lobby-tally">${view.joinsClosed ? "the door is closed" : "unclaimed"}</span>`
            }
          </li>`,
        ),
      ),
      this.list(
        "Asking for a seat on your empire",
        view.watching
          ? []
          : view.applications.map(
              (who) => `
          <li class="lobby-seat">
            <span class="lobby-who">${escape(who.label)}</span>
            ${
              view.joinsClosed
                ? `<span class="lobby-tally">the door is closed</span>`
                : `<button class="btn btn-small" type="button" data-people="admit"
                     data-key="${escape(who.key)}" data-empire="${who.empire}">Let them in</button>`
            }
          </li>`,
            ),
      ),
      this.list(
        "Asked to join your empire",
        view.asks.map(
          (ask) => `
          <li class="lobby-seat">
            <span class="lobby-who" style="color:${empireTheme(ask.empire).c1}">${escape(ask.label)}
              <span class="lobby-tally">${ask.endorsed}/${ask.needed}</span></span>
            <button class="btn btn-small" type="button" data-people="endorse"
              data-key="${escape(ask.key)}" data-empire="${ask.empire}">Agree</button>
          </li>`,
        ),
      ),
      this.list(
        "Watching, and not playing",
        view.watching
          ? []
          : view.waiting.map(
              (who) => `
          <li class="lobby-seat">
            <span class="lobby-who">${escape(who.label)}</span>
            ${
              view.joinsClosed
                ? `<span class="lobby-tally">the door is closed</span>`
                : `<button class="btn btn-small" type="button" data-people="invite"
                     data-key="${escape(who.key)}">Offer a seat</button>`
            }
          </li>`,
            ),
      ),
    ].join("");
  }

  private list(heading: string, rows: string[]): string {
    if (rows.length === 0) return "";
    return `<p class="hint">${heading}:</p><ul class="lobby-teams">${rows.join("")}</ul>`;
  }
}
