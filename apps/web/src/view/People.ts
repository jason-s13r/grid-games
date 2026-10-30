// Who is in an online game, who is asking to join your empire, and the invite
// link that lets somebody straight in.
//
// Rendered from what the room says (RoomClient.people) and nothing else. It
// redraws only when that changes, so a button is never replaced under the
// pointer between press and release.

import type { People } from "@tessera/room";
import { empireTheme } from "./palette";
import { escape } from "./escape";

export interface PeopleHandlers {
  approve: (key: string) => void;
  decline: (key: string) => void;
  withdraw: () => void;
  /** Make an invite to our empire; resolves to the link. */
  invite: () => Promise<string | undefined>;
}

export class PeoplePanel {
  private people: People = { people: [], requests: [] };
  private me = "";
  private myEmpire = 0;
  private inviteLink = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly handlers: PeopleHandlers,
  ) {
    root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-people-action]");
      if (!button) return;
      event.preventDefault();
      const key = button.dataset.key ?? "";
      switch (button.dataset.peopleAction) {
        case "approve":
          return handlers.approve(key);
        case "decline":
          return handlers.decline(key);
        case "withdraw":
          return handlers.withdraw();
        case "invite":
          void handlers.invite().then((link) => {
            this.inviteLink = link ?? "";
            this.render();
          });
          return;
        case "copy":
          if (this.inviteLink) void navigator.clipboard?.writeText(this.inviteLink);
          return;
      }
    });
  }

  /** Show for an online game; hide for anything else. */
  set(people: People | null, me = "", myEmpire = 0): void {
    this.panel.hidden = !people;
    if (!people) {
      this.inviteLink = "";
      this.root.innerHTML = "";
      return;
    }
    if (myEmpire !== this.myEmpire) this.inviteLink = "";
    this.people = people;
    this.me = me;
    this.myEmpire = myEmpire;
    this.render();
  }

  private render(): void {
    const { people, requests } = this.people;
    const name = (p: { name: string; key: string }): string =>
      escape(p.name || `player ${p.key.slice(0, 6)}`);

    const mine = this.myEmpire ? requests.filter((r) => r.empire === this.myEmpire) : [];
    const asked = requests.find((r) => r.key === this.me);

    const requestRows = mine
      .map(
        (r) => `<div class="lobby-seat">
          <span class="lobby-who">${name(r)} asks to join</span>
          <button class="btn btn-small" type="button" data-people-action="approve" data-key="${escape(r.key)}">Let in</button>
          <button class="btn btn-small" type="button" data-people-action="decline" data-key="${escape(r.key)}">No</button>
        </div>`,
      )
      .join("");

    const invite = this.myEmpire
      ? this.inviteLink
        ? `<div class="lobby-actions">
             <input class="lobby-code" readonly value="${escape(this.inviteLink)}" />
             <button class="btn btn-small" type="button" data-people-action="copy">Copy</button>
           </div>
           <p class="hint">Whoever opens this joins your empire. It works once, for a week.</p>`
        : `<button class="btn btn-small" type="button" data-people-action="invite">Invite to my empire</button>`
      : "";

    const waiting = asked
      ? `<p class="hint">You asked ${escape(empireTheme(asked.empire).name)} for a seat.
           <button class="btn btn-small" type="button" data-people-action="withdraw">Withdraw</button></p>`
      : "";

    // The players are listed under their empires in the standings; here are
    // the people holding no seat.
    const watching = people.filter((p) => !p.seat);
    const watchers = watching.length
      ? `<p class="hint">Watching: ${watching
          .map((p) => `${name(p)}${p.key === this.me ? " (you)" : ""}${p.connected ? "" : " (away)"}`)
          .join(", ")}</p>`
      : "";

    this.root.innerHTML = `${requestRows}${waiting}${invite}${watchers}`;
  }
}
