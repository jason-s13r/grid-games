// Sidebar: your empire's resources, the shop, and standings.

import type { State } from "@tessera/sim";
import { MOVE, PHASE, WIN, STEPS_PER_SECOND, isProtected, summarise } from "@tessera/sim";
import { empireTheme } from "./palette";
import type { Driver } from "../game/Driver";

export type PlaceMode = "none" | "bridge" | "ladder" | "march";

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

export class Controls {
  placeMode: PlaceMode = "none";

  constructor(
    private game: Driver,
    private els: {
      you: HTMLElement;
      standings: HTMLElement;
      clock: HTMLElement;
      banner: HTMLElement;
      zoomhint: HTMLElement;
    },
  ) {
    this.els.you.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-buy]");
      if (!target) return;
      const what = target.dataset.buy;
      if (what === "bridge") this.game.act(MOVE.BUY_BRIDGE);
      if (what === "ladder") this.game.act(MOVE.BUY_LADDER);
      if (what === "march") this.game.act(MOVE.BUY_MARCH);
      if (what === "growth") this.game.act(MOVE.BUY_GROWTH);
      if (what === "place-bridge") this.toggle("bridge");
      if (what === "place-ladder") this.toggle("ladder");
      if (what === "place-march") this.toggle("march");
    });
  }

  private toggle(mode: PlaceMode): void {
    this.placeMode = this.placeMode === mode ? "none" : mode;
  }

  /** Put the board back to plain claiming.
   *
   *  Arming used to be sticky: a placed bridge left placeMode on "bridge" with
   *  nothing left in stock, so every later click became a PLACE_BRIDGE that
   *  failed validation silently and the player simply could not play. One
   *  placement, one disarm — and render() disarms again if the stock runs out
   *  some other way. */
  disarm(): void {
    this.placeMode = "none";
  }

  render(state: State): void {
    // An observer holds no empire, and empire 0 is neutral. It has a clock and
    // a board like everyone else; what it does not have is a seat to describe.
    const empire = state.empires[this.game.empire - 1];
    if (!empire) {
      this.els.clock.textContent = `${clock(state.step)} · step ${state.step}`;
      this.els.you.innerHTML = `<div class="you-head"><strong>Watching</strong></div>`;
      return;
    }
    const member = empire.members[this.game.member]!;
    const rules = state.genesis.rules;
    const theme = empireTheme(empire.id);

    // Nothing left to place means nothing to be armed for. Without this a
    // player whose last bridge was spent by a teammate stays stuck in place
    // mode with no button lit to tell them why. March is exempt: it is an
    // ability, not a stock, so once it is bought it cannot run out.
    if (
      (this.placeMode === "bridge" && empire.bridges === 0) ||
      (this.placeMode === "ladder" && empire.ladders === 0)
    ) {
      this.placeMode = "none";
    }

    this.els.clock.textContent = `${clock(state.step)} · step ${state.step}`;

    const pct = Math.round((member.popTimer / rules.popMax) * 100);
    const protectedFor = isProtected(state, empire);

    this.els.you.innerHTML = `
      <div class="you-head">
        <span class="swatch" data-empire="${empire.id}"></span>
        <strong>${theme.name}</strong>
        ${protectedFor ? '<span class="tag">protected</span>' : ""}
      </div>
      <div class="meter" title="population timer">
        <div class="meter-fill" style="width:${pct}%; background:${theme.c1}"></div>
        <span class="meter-label">${member.popTimer} / ${rules.popMax}</span>
      </div>
      <dl class="facts">
        <div><dt>Tiles</dt><dd>${empire.tilesOwned}</dd></div>
        <div><dt>Population</dt><dd>${empire.popTotal.toLocaleString()}</dd></div>
        <div><dt>Diamonds</dt><dd>${empire.diamonds}</dd></div>
      </dl>
      <div class="shop">
        <button class="btn sm" data-buy="bridge" ${empire.diamonds < rules.bridgeCost ? "disabled" : ""}>
          Buy bridge <span class="cost">${rules.bridgeCost}&#9670;</span>
        </button>
        <button class="btn sm ${this.placeMode === "bridge" ? "armed" : ""}" data-buy="place-bridge" ${empire.bridges === 0 ? "disabled" : ""}>
          Place bridge (${empire.bridges})
        </button>
        <button class="btn sm" data-buy="ladder" ${empire.diamonds < rules.ladderCost ? "disabled" : ""}>
          Buy ladder <span class="cost">${rules.ladderCost}&#9670;</span>
        </button>
        <button class="btn sm ${this.placeMode === "ladder" ? "armed" : ""}" data-buy="place-ladder" ${empire.ladders === 0 ? "disabled" : ""}>
          Place ladder (${empire.ladders})
        </button>
      </div>
      <p class="shop-hint">${this.hint()}</p>
      <h3 class="side-sub">Upgrades</h3>
      <div class="upgrades">
        ${
          empire.marchUnlocked
            ? `<button class="btn sm up ${this.placeMode === "march" ? "armed" : ""}" data-buy="place-march">
                 March <span class="up-what">reach two tiles</span>
               </button>`
            : `<button class="btn sm up" data-buy="march" ${empire.diamonds < rules.marchCost ? "disabled" : ""}>
                 Buy march <span class="up-what">reach two tiles</span>
                 <span class="cost">${rules.marchCost}&#9670;</span>
               </button>`
        }
        ${
          empire.growthUnlocked
            ? `<button class="btn sm up owned" disabled>
                 Growth <span class="up-what">connected tiles gain population</span>
               </button>`
            : `<button class="btn sm up" data-buy="growth" ${empire.diamonds < rules.growthCost ? "disabled" : ""}>
                 Buy growth <span class="up-what">connected tiles gain population</span>
                 <span class="cost">${rules.growthCost}&#9670;</span>
               </button>`
        }
      </div>
      ${
        empire.members.length > 1
          ? `<div class="roster">${empire.members
              .map((m, i) => {
                const live = state.step - m.lastBeat <= rules.livenessWindow;
                return `<div class="roster-row${live ? "" : " afk"}">
                  <span>${i === this.game.member ? "You" : m.kind === 1 ? `Bot ${i}` : `Member ${i}`}</span>
                  <span class="roster-pop">${m.popTimer}</span>
                </div>`;
              })
              .join("")}</div>`
          : ""
      }
    `;

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

    if (state.phase === PHASE.ENDED) {
      const winner = state.winner > 0 ? empireTheme(state.winner).name : "Nobody";
      this.els.banner.hidden = false;
      this.els.banner.innerHTML = `<strong>${winner} wins</strong><span>${WIN_TEXT[state.winReason] ?? ""}</span>`;
    } else {
      this.els.banner.hidden = true;
    }
  }

  /** What an armed board is waiting for. Placement modes look identical to
   *  ordinary play until you click the wrong tile, so say it out loud.
   *
   *  Bridges and ladders are stock: bought, carried, spent. March and growth
   *  are not — they are standing modifiers to how the empire plays, bought
   *  once and kept, which is why they sit in their own section rather than
   *  beside the consumables. */
  private hint(): string {
    if (this.placeMode === "bridge") return "Click a river tile beside your border.";
    if (this.placeMode === "ladder") return "Click a wall tile beside your border.";
    if (this.placeMode === "march") return "Click two tiles out; the one between fills too. Stays on.";
    return "";
  }

  setZoomHint(text: string): void {
    this.els.zoomhint.textContent = text;
  }
}
