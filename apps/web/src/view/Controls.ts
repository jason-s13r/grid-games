// What the game says about itself: the HUD across the top, the items you can
// buy, and the standings beside the board.
//
// There is no placement mode here any more. Arming a button to say "this next
// click is a bridge" restated something the map already knew — a bridge only
// ever goes on a river — so the click dispatch reads the terrain instead. See
// game/input.ts. The same goes for the standing modifiers: buying march turns
// march on, permanently, and a bought modifier has nothing left to press, so
// it stops being a button and becomes a badge on the HUD.

import type { State } from "@tessera/sim";
import { MOVE, PHASE, WIN, STEPS_PER_SECOND, isProtected, summarise } from "@tessera/sim";
import { empireTheme } from "./palette";
import type { Driver } from "../game/Driver";

const clock = (steps: number): string => {
  const total = Math.floor(steps / STEPS_PER_SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

const WIN_TEXT: Record<number, string> = {
  [WIN.TIMEOUT]: "time expired",
  [WIN.LAST_EMPIRE]: "last empire standing",
  [WIN.LAST_ROSTER]: "opponents abandoned the field",
};

/** One tile of the shop. Every one of these is a purchase now — the things
 *  that used to need placing place themselves. */
interface Act {
  buy: string;
  glyph: string;
  name: string;
  what: string;
  cost: number;
  /** How many are in hand, for the things you can stockpile. */
  held?: number;
  affordable: boolean;
}

const tile = (act: Act): string =>
  `<button class="act" data-buy="${act.buy}" title="${act.what}"${act.affordable ? "" : " disabled"}>
     <span class="act-glyph">${act.glyph}</span>
     <span class="act-name">${act.name}</span>
     <span class="act-meta">${act.cost}&#9670;</span>
     ${act.held ? `<span class="act-count">&times;${act.held}</span>` : ""}
   </button>`;

export class Controls {
  constructor(
    private game: Driver,
    private els: {
      hud: HTMLElement;
      acts: HTMLElement;
      standings: HTMLElement;
      roster: HTMLElement;
      rosterPanel: HTMLElement;
      clock: HTMLElement;
      banner: HTMLElement;
      zoomhint: HTMLElement;
    },
  ) {
    this.els.acts.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-buy]");
      if (!target) return;
      switch (target.dataset.buy) {
        case "bridge": this.game.act(MOVE.BUY_BRIDGE); return;
        case "ladder": this.game.act(MOVE.BUY_LADDER); return;
        case "march": this.game.act(MOVE.BUY_MARCH); return;
        case "growth": this.game.act(MOVE.BUY_GROWTH); return;
      }
    });
  }

  render(state: State): void {
    // An observer holds no empire, and empire 0 is neutral. It has a clock and
    // a board like everyone else; what it does not have is a seat to describe.
    const empire = state.empires[this.game.empire - 1];
    if (!empire) {
      this.els.clock.textContent = `${clock(state.step)} · step ${state.step}`;
      this.els.hud.innerHTML = `<strong class="hud-name">Watching</strong>`;
      this.els.acts.innerHTML = "";
      this.els.rosterPanel.hidden = true;
      this.renderStandings(state);
      return;
    }
    const member = empire.members[this.game.member]!;
    const rules = state.genesis.rules;
    const theme = empireTheme(empire.id);

    this.els.clock.textContent = `${clock(state.step)} · step ${state.step}`;

    const pct = Math.round((member.popTimer / rules.popMax) * 100);

    this.els.hud.innerHTML = `
      <span class="swatch" data-empire="${empire.id}"></span>
      <strong class="hud-name">${theme.name}</strong>
      ${isProtected(state, empire) ? '<span class="tag">protected</span>' : ""}
      <div class="meter" title="population timer">
        <div class="meter-fill" style="width:${pct}%; background:${theme.c1}"></div>
        <span class="meter-label">${member.popTimer} / ${rules.popMax}</span>
      </div>
      <span class="fact"><i>Tiles</i><b>${empire.tilesOwned}</b></span>
      <span class="fact"><i>Population</i><b>${empire.popTotal.toLocaleString()}</b></span>
      <span class="fact"><i>Diamonds</i><b>${empire.diamonds}</b></span>
      ${
        empire.marchUnlocked
          ? '<span class="mod" title="Claims reach two tiles out instead of one.">March</span>'
          : ""
      }
      ${
        empire.growthUnlocked
          ? '<span class="mod" title="Tiles connected to your capital gain population over time.">Growth</span>'
          : ""
      }
    `;

    // A bought modifier is not a button. It has no second state to toggle and
    // nothing left to spend, so it leaves the shop and shows on the HUD.
    this.els.acts.innerHTML = [
      tile({
        buy: "bridge",
        glyph: "&#9636;",
        name: "Bridge",
        what: "Crosses a river. Click any river tile beside your border.",
        cost: rules.bridgeCost,
        held: empire.bridges,
        affordable: empire.diamonds >= rules.bridgeCost,
      }),
      tile({
        buy: "ladder",
        glyph: "&#9637;",
        name: "Ladder",
        what: "Crosses a wall. Click any wall tile beside your border.",
        cost: rules.ladderCost,
        held: empire.ladders,
        affordable: empire.diamonds >= rules.ladderCost,
      }),
      empire.marchUnlocked
        ? ""
        : tile({
            buy: "march",
            glyph: "&#187;",
            name: "March",
            what: "Permanent. Claims reach two tiles out instead of one.",
            cost: rules.marchCost,
            affordable: empire.diamonds >= rules.marchCost,
          }),
      empire.growthUnlocked
        ? ""
        : tile({
            buy: "growth",
            glyph: "&#8593;",
            name: "Growth",
            what: "Permanent. Tiles connected to your capital gain population.",
            cost: rules.growthCost,
            affordable: empire.diamonds >= rules.growthCost,
          }),
    ].join("");

    // Only a shared empire has seats worth listing; a solo player is the seat.
    this.els.rosterPanel.hidden = empire.members.length < 2;
    if (empire.members.length > 1) {
      this.els.roster.innerHTML = empire.members
        .map((m, i) => {
          const live = state.step - m.lastBeat <= rules.livenessWindow;
          return `<div class="roster-row${live ? "" : " afk"}">
            <span>${i === this.game.member ? "You" : m.kind === 1 ? `Bot ${i}` : `Member ${i}`}</span>
            <span class="roster-pop">${m.popTimer}</span>
          </div>`;
        })
        .join("");
    }

    this.renderStandings(state);

    if (state.phase === PHASE.ENDED) {
      const winner = state.winner > 0 ? empireTheme(state.winner).name : "Nobody";
      this.els.banner.hidden = false;
      this.els.banner.innerHTML = `<strong>${winner} wins</strong><span>${WIN_TEXT[state.winReason] ?? ""}</span>`;
    } else {
      this.els.banner.hidden = true;
    }
  }

  private renderStandings(state: State): void {
    const rows = summarise(state)
      .slice()
      .sort((a, b) => b.tilesOwned - a.tilesOwned);

    this.els.standings.innerHTML = rows
      .map((e) => {
        const t = empireTheme(e.id);
        return `<div class="standing${e.alive ? "" : " dead"}">
          <span class="swatch" data-empire="${e.id}"></span>
          <span class="standing-name">${t.name}${e.id === this.game.empire ? " (you)" : ""}</span>
          <span class="standing-tiles">${e.tilesOwned}</span>
          <span class="standing-meta">${e.largestCascade.tiles ? `${e.largestCascade.tiles}&#9733;` : ""}</span>
        </div>`;
      })
      .join("");
  }

  setZoomHint(text: string): void {
    this.els.zoomhint.textContent = text;
  }
}
