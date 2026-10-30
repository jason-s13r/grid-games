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
import { MOVE, PHASE, WIN, STEPS_PER_SECOND, isProtected, isVacant, summarise } from "@tessera/sim";
import { empireTheme } from "./palette";
import type { Driver } from "../game/Driver";

/** A step count as a wall clock. Exported because the scrubber counts in the
 *  same units and a second formatter would drift from this one. */
export const clock = (steps: number): string => {
  const total = Math.floor(steps / STEPS_PER_SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

/** What the clock says, which in a game with an end is not how long it has been
 *  running.
 *
 *  `clock(step)` is elapsed time, and in an open-ended game that is the only
 *  honest reading. In a game the record gives an `endStep`, it is the wrong
 *  number on screen: a player three hours into a three-hour game wants to know
 *  they have minutes left, and what they were shown was "3:00:00" counting up.
 *
 *  Both readings come off the genesis rules and this peer's own step. Never off
 *  a listing, which is a claim somebody posted, and never off a wall clock —
 *  the step number already is one, agreed by everybody playing.
 *
 *  `online` is only about the join window. A solo game is composed by the same
 *  form as a hosted one and carries the same `DurationRules`, join window and
 *  all — which is right, because the two are the same world with different
 *  seats in it — but there is nobody who could walk through that door, so
 *  counting down to it closing is a countdown to nothing. */
export function clockLine(state: State, online = true): string {
  const end = state.genesis.rules.endStep ?? 0;
  const label = end > 0 ? `${clock(Math.max(0, end - state.step))} left` : clock(state.step);

  // Only while it is open, and only where somebody could use it. Once the window
  // has passed it stops being news about when to hurry, and the panel already
  // says the seats are closed.
  // Read the way the rest of the client reads it: a v3 record predates the
  // field, and a number that means nothing should not be counted down.
  const window = online && state.genesis.protocol >= 4 ? (state.genesis.rules.joinWindow ?? 0) : 0;
  const joining =
    window > 0 && state.step < window ? ` · seats open for ${clock(window - state.step)}` : "";

  // The step number is for debugging, not for playing: it rides in the
  // clock's tooltip rather than on the bar.
  return `${label}${joining}`;
}

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
  affordable: boolean;
}

const tile = (act: Act): string =>
  `<button class="act" data-buy="${act.buy}"${act.affordable ? "" : " disabled"}>
     <span class="act-glyph">${act.glyph}</span>
     <span class="act-name">${act.name}</span>
     <span class="act-meta">${act.cost}&#9670;</span>
     <span class="act-what">${act.what}</span>
   </button>`;

export class Controls {
  constructor(
    private game: Driver,
    private els: {
      hud: HTMLElement;
      acts: HTMLElement;
      storeHead: HTMLElement;
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

  /** The last markup written to each subtree, so an unchanged one is left
   *  alone.
   *
   *  Not an optimisation. `render` runs from a 200 ms block and used to rewrite
   *  three subtrees unconditionally on every call — and **`[data-acts]` is the
   *  shop**, whose tiles are buttons. Replace a button between `pointerdown` and
   *  `pointerup` and the browser fires `click` on the nearest surviving
   *  ancestor, where `closest("[data-buy]")` finds nothing and the purchase is
   *  silently dropped. At 200 ms and a typical press, a meaningful fraction of
   *  every purchase in the game was being thrown away.
   *
   *  Nobody noticed because the standings hold no buttons and the HUD holds
   *  none either. The guard is per subtree so a HUD that changes every step
   *  does not force the shop to redraw with it. */
  private readonly drawn = new Map<string, string>();

  /** Write only if it changed. Returns whether it did. */
  private put(el: HTMLElement, key: string, markup: string): boolean {
    if (this.drawn.get(key) === markup) return false;
    this.drawn.set(key, markup);
    el.innerHTML = markup;
    return true;
  }

  render(state: State): void {
    // An observer holds no empire, and empire 0 is neutral. It has a clock and
    // a board like everyone else; what it does not have is a seat to describe.
    const empire = state.empires[this.game.empire - 1];
    if (!empire) {
      this.showClock(state);
      this.put(this.els.hud, "hud", `<strong class="hud-name">Watching</strong>`);
      this.put(this.els.acts, "acts", "");
      this.put(this.els.storeHead, "storeHead", "");
      this.els.rosterPanel.hidden = true;
      this.renderStandings(state);
      return;
    }
    const member = empire.members[this.game.member]!;
    const rules = state.genesis.rules;
    const theme = empireTheme(empire.id);

    this.showClock(state);

    const pct = Math.round((member.popTimer / rules.popMax) * 100);

    this.put(
      this.els.hud,
      "hud",
      `
      <span class="swatch" data-banner="${empireTheme(empire.id).id}"></span>
      <strong class="hud-name">${theme.name}</strong>
      ${isProtected(state, empire) ? '<span class="tag">protected</span>' : ""}
      <div class="meter" title="population timer">
        <div class="meter-fill" style="width:${pct}%; background:${theme.c1}"></div>
        <span class="meter-label">${member.popTimer} / ${rules.popMax}</span>
      </div>
      <span class="fact"><i>Tiles</i><b>${empire.tilesOwned}</b></span>
      <span class="fact fact-pop"><i>Population</i><b>${empire.popTotal.toLocaleString()}</b></span>
    `,
    );

    // What there is to spend, and what is already bought, at the top of the
    // store: that is where the number matters.
    const owned = [
      empire.bridges ? `<span class="mod" title="Bridges in hand: click a river tile beside your border.">Bridge &times;${empire.bridges}</span>` : "",
      empire.ladders ? `<span class="mod" title="Ladders in hand: click a wall tile beside your border.">Ladder &times;${empire.ladders}</span>` : "",
      empire.marchUnlocked ? '<span class="mod" title="Claims reach two tiles out instead of one.">March</span>' : "",
      empire.growthUnlocked ? '<span class="mod" title="Tiles connected to your capital gain population over time.">Growth</span>' : "",
    ].join("");
    this.put(
      this.els.storeHead,
      "storeHead",
      `<span class="store-diamonds"><b>${empire.diamonds}</b>&#9670; <i>diamonds</i></span>
       ${owned ? `<span class="store-owned"><i>Owned</i>${owned}</span>` : ""}`,
    );

    // A bought modifier is not a button. It has no second state to toggle and
    // nothing left to spend, so it leaves the shop and shows on the HUD.
    this.put(
      this.els.acts,
      "acts",
      [
      tile({
        buy: "bridge",
        glyph: "&#9636;",
        name: "Bridge",
        what: "Crosses a river. Click any river tile beside your border.",
        cost: rules.bridgeCost,
        affordable: empire.diamonds >= rules.bridgeCost,
      }),
      tile({
        buy: "ladder",
        glyph: "&#9637;",
        name: "Ladder",
        what: "Crosses a wall. Click any wall tile beside your border.",
        cost: rules.ladderCost,
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
      ].join(""),
    );

    // Only a shared empire has seats worth listing; a solo player is the seat.
    // Only when it actually changes. Writing the same value still counts as an
    // attribute mutation, and this runs every frame — anything watching the
    // page for panels appearing and disappearing would hear it constantly.
    const seats = empire.members.length >= 2;
    if (this.els.rosterPanel.hidden === seats) this.els.rosterPanel.hidden = !seats;
    if (empire.members.length > 1) {
      this.put(
        this.els.roster,
        "roster",
        empire.members
          .map((m, i) => {
            const live = state.step - m.lastBeat <= rules.livenessWindow;
            return `<div class="roster-row${live ? "" : " afk"}">
            <span>${i === this.game.member ? "You" : m.kind === 1 ? `Bot ${i}` : `Member ${i}`}</span>
            <span class="roster-pop">${m.popTimer}</span>
          </div>`;
          })
          .join(""),
      );
    }

    this.renderStandings(state);

    if (state.phase === PHASE.ENDED) {
      const winner = state.winner > 0 ? empireTheme(state.winner).name : "Nobody";
      this.els.banner.hidden = false;
      this.put(
        this.els.banner,
        "banner",
        `<strong>${winner} wins</strong><span>${WIN_TEXT[state.winReason] ?? ""}</span>`,
      );
    } else {
      this.els.banner.hidden = true;
    }
  }

  private showClock(state: State): void {
    this.els.clock.textContent = clockLine(state, this.game.online);
    this.els.clock.title = `step ${state.step}`;
  }

  private renderStandings(state: State): void {
    const rows = summarise(state)
      .slice()
      .sort((a, b) => b.tilesOwned - a.tilesOwned);

    // Whether *this* viewer could take an empire nobody has taken: a mesh game,
    // watching rather than playing, and the door still open. The same
    // `joinWindow` expression the simulation and the lobby panel use, read off
    // the record rather than off this build's constant — a claim is a human
    // ROSTER_AMEND, so the join window is the front door's opening hours and
    // needs no rule of its own.
    const window =
      state.genesis.protocol >= 4 ? (state.genesis.rules.joinWindow ?? 0) : 0;
    // The same condition serves both buttons, and deliberately: taking an empire
    // nobody has and asking one that somebody does are the two doors into a
    // running game, and the join window closes both on the same line.
    const claimable =
      this.game.online &&
      this.game.empire === 0 &&
      !(window > 0 && state.step >= window);

    this.put(
      this.els.standings,
      "standings",
      rows
      .map((e) => {
        const t = empireTheme(e.id);
        // An empire nobody has claimed is in the standings, not hidden from
        // them: it has a name, a flag and a capital, all sealed into the record
        // before anybody arrived, and "which vacancy" is a real choice a player
        // makes. Listing it as territory with nobody in it is the honest
        // rendering — and it never shows as dead, because it was never alive.
        const vacant = isVacant(state.empires[e.id - 1]!);
        return `<div class="standing${!vacant && !e.alive ? " dead" : ""}${vacant ? " vacant" : ""}">
          <span class="swatch" data-banner="${empireTheme(e.id).id}"></span>
          <span class="standing-name">${t.name}${e.id === this.game.empire ? " (you)" : ""}</span>
          <span class="standing-tiles">${
            vacant && claimable
              ? `<button class="btn btn-small" type="button" data-claim="${e.id}">Take it</button>`
              : vacant
                ? "unclaimed"
                : claimable && e.alive
                  ? `<button class="btn btn-small" type="button" data-ask="${e.id}">Ask</button>`
                  : e.tilesOwned
          }</span>
          <span class="standing-meta">${e.largestCascade.tiles ? `${e.largestCascade.tiles}&#9733;` : ""}</span>
        </div>`;
        })
        .join(""),
    );
  }

  setZoomHint(text: string): void {
    this.els.zoomhint.textContent = text;
  }
}
