// What the game says about itself: the HUD across the top, the items you can
// buy, and the standings beside the board.
//
// There is no placement mode here any more. Arming a button to say "this next
// click is a bridge" restated something the map already knew — a bridge only
// ever goes on a river — so the click dispatch reads the terrain instead. See
// game/input.ts. The same goes for the standing modifiers: buying march turns
// march on, permanently, and a bought modifier has nothing left to press, so
// it stops being a button and becomes a badge on the HUD.

import type { EmpireSummary, State } from "@tessera/sim";
import { MEMBER, MOVE, PHASE, TUNING, STEPS_PER_SECOND, growthCeiling, isProtected, isVacant, summarise } from "@tessera/sim";
import type { Person } from "@tessera/room";
import { escape } from "./escape";
import { endBar, endCard } from "./EndCard";
import { span } from "./clock";
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

/** A big number in a few characters, for a narrow status bar: 12.2M. */
const short = (n: number): string =>
  n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });

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
  // Over: what is left of a game that has ended is nothing, and the countdown
  // it stopped on reads as a game that froze.
  if (state.phase === PHASE.ENDED) return `Game over · lasted ${span(state.step)}`;
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

/** One tile of the shop. Every one of these is a purchase now — the things
 *  that used to need placing place themselves. */
interface Act {
  buy: string;
  glyph: string;
  name: string;
  what: string;
  cost: number;
  /** Diamonds held, to say how many more it needs. */
  diamonds: number;
}

/** The keyboard shortcut for each purchase, shown on its row. */
const KEYS: Record<string, string> = { bridge: "B", ladder: "L", march: "M", growth: "G" };

const tile = (act: Act): string => {
  const short = act.cost - act.diamonds;
  return `<button class="act" data-buy="${act.buy}"${short > 0 ? " disabled" : ""}
      aria-keyshortcuts="${KEYS[act.buy]}">
     <span class="act-glyph">${act.glyph}</span>
     <span class="act-name">${act.name} <kbd>${KEYS[act.buy]}</kbd></span>
     <span class="act-meta">${act.cost}&#9670;</span>
     <span class="act-what">${act.what}</span>
     ${short > 0 ? `<span class="act-why">Needs ${short} more &#9670;</span>` : ""}
   </button>`;
};

const BUY: Record<string, (typeof MOVE)[keyof typeof MOVE]> = {
  bridge: MOVE.BUY_BRIDGE,
  ladder: MOVE.BUY_LADDER,
  march: MOVE.BUY_MARCH,
  growth: MOVE.BUY_GROWTH,
};

/** The ways the standings can be ranked, all from the same public summary. */
type Ranking = "tiles" | "pop" | "cascade" | "coins" | "mined";
const RANKINGS: Record<Ranking, { label: string; title: string; value: (e: EmpireSummary) => number }> = {
  tiles: { label: "Tiles", title: "Tiles held now", value: (e) => e.tilesOwned },
  pop: { label: "Pop", title: "Population now", value: (e) => e.popTotal },
  cascade: { label: "Cascade", title: "Largest coin cascade this game, in tiles", value: (e) => e.largestCascade.tiles },
  coins: { label: "Coins", title: "Coins taken this game", value: (e) => e.coins.bronze + e.coins.silver + e.coins.gold },
  mined: { label: "&#9670;", title: "Diamonds collected this game", value: (e) => e.diamonds },
};

/** Fill a panel's `data-v` (text) and `data-w` (width) slots, touching only
 *  what changed. */
function fill(root: HTMLElement, values: Record<string, string>): void {
  const slots = root.querySelectorAll?.<HTMLElement>("[data-v], [data-w]");
  if (!slots) return;
  for (const slot of slots) {
    const v = slot.dataset.v;
    if (v !== undefined) {
      const text = values[v] ?? "";
      if (slot.textContent !== text) slot.textContent = text;
    }
    const w = slot.dataset.w;
    if (w !== undefined) {
      const width = values[w] ?? "";
      if (slot.style.width !== width) slot.style.width = width;
    }
  }
}

/** A number in a few characters: 12.2M. */
const compact = (n: number): string =>
  n < 10_000 ? String(n) : n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });

export class Controls {
  constructor(
    private game: Driver,
    private els: {
      hud: HTMLElement;
      acts: HTMLElement;
      storeHead: HTMLElement;
      standings: HTMLElement;
      clock: HTMLElement;
      banner: HTMLElement;
      /** The end card's dialog. Optional, so a test can leave it out. */
      end?: HTMLDialogElement;
      zoomhint: HTMLElement;
    },
  ) {
    this.els.acts.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-buy]");
      const type = target ? BUY[target.dataset.buy ?? ""] : undefined;
      if (type === undefined) return;
      this.game.act(type);
      if (type === MOVE.BUY_BRIDGE || type === MOVE.BUY_LADDER) this.onPlaces?.();
    });
    // A bridge or ladder in hand, in the store's Owned line: press it to see
    // where it can go.
    this.els.storeHead.addEventListener?.("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-places]")) this.onPlaces?.();
    });

    // The standings do change every step (each member's counter), and they
    // hold buttons too, so they are left alone while a finger or the mouse is
    // pressed on them. See `drawn`.
    const press = (el: HTMLElement) => {
      el.addEventListener?.("pointerdown", () => this.pressed.add(el));
      const release = () => this.pressed.delete(el);
      globalThis.addEventListener?.("pointerup", release);
      globalThis.addEventListener?.("pointercancel", release);
    };
    press(this.els.standings);
    press(this.els.acts);

    // The end card's buttons, and the bar's way back to it. Assigned rather
    // than added: these elements outlive a game, and a Controls is made for
    // each one, so the next game's handlers replace this one's instead of
    // stacking up beside them.
    const end = this.els.end;
    if (end) {
      if (end.open) end.close();
      end.onclick = (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-end-home]")) {
          end.close();
          this.onHome?.();
        } else if (target.closest("[data-end-hide]")) {
          end.close();
        }
      };
      // However it closes (the button, or Escape), the board comes back to colour.
      end.onclose = () => this.dim(false);
      this.els.banner.onclick = (event) => {
        if (!(event.target as HTMLElement).closest("[data-end-show]")) return;
        end.showModal();
        this.dim(true);
      };
    }
    this.dim(false);

    // What the standings are ranked by.
    this.els.standings.addEventListener?.("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-rank-by]");
      const key = button?.dataset.rankBy as Ranking | undefined;
      if (!key || !(key in RANKINGS)) return;
      this.rankBy = key;
      this.drawn.delete("standings");
    });

    // Which empires' player lists are open, kept across redraws.
    this.els.standings.addEventListener?.(
      "toggle",
      (event) => {
        const group = event.target as HTMLDetailsElement;
        const id = Number(group.dataset?.empire);
        if (!id) return;
        if (group.open) this.expanded.add(id);
        else this.expanded.delete(id);
      },
      true,
    );
  }

  /** What the store last showed, so a shortcut only buys what is on offer. */
  private offered = new Set<string>();

  /** Buy by keyboard shortcut. True if the key is one of the store's, whether
   *  or not the purchase went through (validation decides that). */
  buyKey(key: string): boolean {
    const name = Object.keys(KEYS).find((k) => KEYS[k] === key.toUpperCase());
    if (!name || !this.offered.has(name)) return false;
    this.game.act(BUY[name]!);
    if (name === "bridge" || name === "ladder") this.onPlaces?.();
    return true;
  }

  /** Show where a bridge or ladder can go: after buying one, or pressing one
   *  in hand. */
  onPlaces: (() => void) | null = null;

  /** What the standings are ranked by. */
  private rankBy: Ranking = "tiles";

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
   *  The guard is per subtree so a HUD that changes every step does not force
   *  the shop to redraw with it. The standings hold buttons now as well and
   *  change every step, so a subtree is also left alone while it is pressed. */
  private readonly drawn = new Map<string, string>();

  /** Subtrees with a press in progress on them. */
  private readonly pressed = new Set<HTMLElement>();

  /** Write only if it changed. Returns whether it did.
   *
   *  `values` are the numbers that change every step: banks, the meter, tile
   *  and population counts. They are not part of the markup compared here;
   *  the markup carries an empty `data-v` (text) or `data-w` (width) slot for
   *  each, filled in place afterwards. Rewriting a whole panel twelve times a
   *  second because one bank ticked made it flicker and cost a layout every
   *  time; this way the panel is rebuilt when its shape changes (an empire
   *  falls, the order moves, somebody joins) and otherwise only text nodes
   *  change. */
  private put(el: HTMLElement, key: string, markup: string, values?: Record<string, string>): boolean {
    let wrote = false;
    // Pressed: the next render after the release writes it.
    if (this.drawn.get(key) !== markup && !this.pressed.has(el)) {
      this.drawn.set(key, markup);
      el.innerHTML = markup;
      wrote = true;
    }
    if (values) fill(el, values);
    return wrote;
  }

  render(state: State): void {
    // An observer holds no empire, and empire 0 is neutral. It has a clock and
    // a board like everyone else; what it does not have is a seat to describe.
    const empire = state.empires[this.game.empire - 1];
    if (!empire) {
      this.showClock(state);
      this.put(this.els.hud, "hud", `<strong class="hud-name">Watching</strong>`);
      this.put(this.els.acts, "acts", "");
      this.offered.clear();
      this.put(this.els.storeHead, "storeHead", "");
      this.renderStandings(state);
      this.renderEnd(state);
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
        <div class="meter-fill" data-w="pct" style="background:${theme.c1}"></div>
        <span class="meter-label" data-v="bank"></span>
      </div>
      <span class="fact"><i>Tiles</i><b data-v="tiles"></b></span>
      <span class="fact fact-pop"><i class="full">Population</i><i class="short">Pop</i><b class="full" data-v="pop"></b><b class="short" data-v="popShort"></b></span>
    `,
      {
        pct: `${pct}%`,
        bank: `${member.popTimer} / ${rules.popMax}`,
        tiles: String(empire.tilesOwned),
        pop: empire.popTotal.toLocaleString(),
        popShort: short(empire.popTotal),
      },
    );

    // What there is to spend, and what is already bought, at the top of the
    // store: that is where the number matters.
    const owned = [
      empire.bridges ? `<button type="button" class="mod mod-place" data-places title="Bridges in hand: show where one can go, then click a river tile beside your border.">Bridge &times;${empire.bridges}</button>` : "",
      empire.ladders ? `<button type="button" class="mod mod-place" data-places title="Ladders in hand: show where one can go, then click a wall tile beside your border.">Ladder &times;${empire.ladders}</button>` : "",
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
    // nothing left to spend, so it leaves the shop for the Owned line above.
    this.offered = new Set(["bridge", "ladder"]);
    if (!empire.marchUnlocked) this.offered.add("march");
    if (!empire.growthUnlocked) this.offered.add("growth");
    this.put(
      this.els.acts,
      "acts",
      [
      tile({
        buy: "bridge",
        glyph: "&#9636;",
        name: "Bridge",
        what: "Crosses a river. The tiles where it can go light up.",
        cost: rules.bridgeCost,
        diamonds: empire.diamonds,
      }),
      tile({
        buy: "ladder",
        glyph: "&#9637;",
        name: "Ladder",
        what: "Crosses a wall. The tiles where it can go light up.",
        cost: rules.ladderCost,
        diamonds: empire.diamonds,
      }),
      empire.marchUnlocked
        ? ""
        : tile({
            buy: "march",
            glyph: "&#187;",
            name: "March",
            what: "Permanent. Claims reach two tiles out instead of one.",
            cost: rules.marchCost,
            diamonds: empire.diamonds,
          }),
      empire.growthUnlocked
        ? ""
        : tile({
            buy: "growth",
            glyph: "&#8593;",
            name: "Growth",
            what:
              state.genesis.protocol >= 5
                ? `Permanent. Tiles joined to your capital fill up to ${growthCeiling(state)} by themselves, while someone in your empire is playing.`
                : "Permanent. Tiles connected to your capital gain population.",
            cost: rules.growthCost,
            diamonds: empire.diamonds,
          }),
      ].join(""),
    );

    this.renderStandings(state);

    this.renderEnd(state);
  }

  /** The end of the game: a card over a dimmed board, or the bar it tucks
   *  into. Watchers and replays get it too. A replay seeked back before the
   *  end takes both away again. */
  private renderEnd(state: State): void {
    const ended = state.phase === PHASE.ENDED;
    const end = this.els.end;
    this.els.banner.hidden = !ended;
    if (ended) {
      this.put(this.els.banner, "banner", endBar(state, this.game.empire));
      if (end) this.put(end, "end", endCard(state, this.game.empire, (id) => this.who(state, id)));
      // Once per ending: when the game ends in front of you, or when you open
      // one that already has. After that it is yours to open from the bar.
      if (!this.endShown) {
        this.endShown = true;
        if (end && !end.open) end.showModal();
        this.dim(true);
      }
    } else if (this.endShown) {
      this.endShown = false;
      if (end?.open) end.close();
      this.dim(false);
    }
  }

  /** Whether this ending's card has been shown. */
  private endShown = false;

  /** The board in muted colours, while the end card is over it. */
  private dim(on: boolean): void {
    this.els.banner.closest?.(".board")?.toggleAttribute("data-ended", on);
  }

  /** The start page, from the end card. */
  onHome: (() => void) | null = null;

  private showClock(state: State): void {
    this.els.clock.textContent = clockLine(state, this.game.online);
    this.els.clock.title = `step ${state.step}`;
  }

  /** Who is in an online game, from the room: names for the seats. */
  private people: Person[] = [];
  /** Empires whose player list is open. Yours opens the first time. */
  private readonly expanded = new Set<number>();
  private expandedYours = false;

  setPeople(people: Person[]): void {
    this.people = people;
  }

  /** The players of one empire, one line each: name, a dot for whether they
   *  are live, and for your own empire each seat's bank. */
  /** What to call a seat: the person's name, "hard bot" and the like for a
   *  seat the simulation plays, or a stand-in. */
  private seatName(state: State, empireId: number, i: number): { name: string; bot: boolean } {
    const m = state.empires[empireId - 1]!.members[i]!;
    const person = this.people.find((p) => p.seat?.empire === empireId && p.seat.member === i);
    const you = empireId === this.game.empire && i === this.game.member;
    if (person) return { name: escape(person.name || `player ${person.key.slice(0, 6)}`), bot: !!person.bot || m.kind === MEMBER.BOT };
    if (m.kind === MEMBER.BOT) {
      const level = (Object.keys(TUNING) as Array<keyof typeof TUNING>).find((d) => TUNING[d].popMax === m.popMax);
      return { name: level ? `${level} bot` : "bot", bot: true };
    }
    return { name: you ? "You" : `Seat ${i + 1}`, bot: false };
  }

  /** An empire's stock in a few symbols: diamonds, bridges and ladders in
   *  hand, and the two standing upgrades. Everything here is public: every
   *  peer runs the same simulation. */
  private stock(state: State, empireId: number): string {
    const e = state.empires[empireId - 1]!;
    const bits = [
      e.diamonds ? `<span class="stock-diamonds" title="diamonds">&#9670;${e.diamonds}</span>` : "",
      e.bridges ? `<span title="bridges in hand">&#9636;${e.bridges}</span>` : "",
      e.ladders ? `<span title="ladders in hand">&#9637;${e.ladders}</span>` : "",
      e.marchUnlocked ? `<span class="stock-mod" title="claims reach two tiles out">&#187;March</span>` : "",
      e.growthUnlocked ? `<span class="stock-mod" title="joined-up land fills by itself">&#8593;Growth</span>` : "",
    ].filter(Boolean);
    // Nothing at all says nothing: no empty symbols at zero.
    return bits.length ? `<span class="member-stock">${bits.join("")}</span>` : "";
  }

  /** After an empire's name: "(you)" for yours, and the player's name when
   *  one seat holds it, so a bot's empire says it is a bot. */
  private who(state: State, empireId: number): string {
    if (empireId === this.game.empire) return " (you)";
    const empire = state.empires[empireId - 1]!;
    if (empire.members.length !== 1) return "";
    return ` <span class="standing-who">(${this.seatName(state, empireId, 0).name})</span>`;
  }

  private members(state: State, empireId: number): string {
    const empire = state.empires[empireId - 1]!;
    const rules = state.genesis.rules;
    const ours = empireId === this.game.empire;
    // The empire's stock is shared by its seats: on the seat's own line when
    // there is one, on a line of its own above them when there are several.
    const single = empire.members.length === 1;
    const stock = this.stock(state, empireId);
    const shared = single || !stock ? "" : `<div class="member member-shared"><span></span><span class="member-name">shared</span>${stock}<span></span></div>`;
    return shared + empire.members
      .map((m, i) => {
        const { name, bot } = this.seatName(state, empireId, i);
        const you = ours && i === this.game.member;
        const person = this.people.some((p) => p.seat?.empire === empireId && p.seat.member === i);
        const tag = bot && person ? ' <span class="tag">bot</span>' : "";
        const live = state.step - m.lastBeat <= rules.livenessWindow;
        return `<div class="member${live ? "" : " afk"}">
          <span class="dot${live ? " on" : ""}" title="${live ? "here" : "away"}"></span>
          <span class="member-name">${name}${you && person ? " (you)" : ""}${tag}</span>
          ${single && stock ? stock : "<span></span>"}
          <span class="member-bank" title="this seat's bank: what its next claim puts down" data-v="bank:${empireId}:${i}"></span>
        </div>`;
      })
      .join("");
  }

  private renderStandings(state: State): void {
    const rank = RANKINGS[this.rankBy];
    const rows = summarise(state)
      .slice()
      .sort((a, b) => rank.value(b) - rank.value(a) || b.tilesOwned - a.tilesOwned);

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

    if (!this.expandedYours && this.game.empire > 0) {
      this.expanded.add(this.game.empire);
      this.expandedYours = true;
    }

    const choices = (Object.keys(RANKINGS) as Ranking[])
      .map(
        (key) =>
          `<button type="button" class="rank-btn${key === this.rankBy ? " on" : ""}" data-rank-by="${key}" title="${RANKINGS[key].title}">${RANKINGS[key].label}</button>`,
      )
      .join("");
    // The numbers that change every step, filled in place. See put().
    const values: Record<string, string> = {};
    for (const e of rows) {
      values[`val:${e.id}`] = compact(rank.value(e));
      state.empires[e.id - 1]!.members.forEach((m, i) => (values[`bank:${e.id}:${i}`] = String(m.popTimer)));
    }
    this.put(
      this.els.standings,
      "standings",
      `<div class="rank-by" role="group" aria-label="Rank empires by">${choices}</div>` +
      rows
      .map((e) => {
        const t = empireTheme(e.id);
        // An empire nobody has claimed is in the standings, not hidden from
        // them: it has a name, a flag and a capital, all sealed into the record
        // before anybody arrived, and "which vacancy" is a real choice a player
        // makes. Listing it as territory with nobody in it is the honest
        // rendering — and it never shows as dead, because it was never alive.
        const vacant = isVacant(state.empires[e.id - 1]!);
        const row = `<span class="swatch" data-banner="${empireTheme(e.id).id}"></span>
          <span class="standing-name">${t.name}${this.who(state, e.id)}</span>
          <span class="standing-tiles">${
            vacant && claimable
              ? `<button class="btn btn-small" type="button" data-claim="${e.id}">Take it</button>`
              : vacant
                ? "unclaimed"
                : claimable && e.alive
                  ? `<button class="btn btn-small" type="button" data-ask="${e.id}">Ask</button>`
                  : `<span data-v="val:${e.id}"></span>`
          }</span>
          <span class="standing-meta">${this.rankBy !== "cascade" && e.largestCascade.tiles ? `${e.largestCascade.tiles}&#9733;` : ""}</span>
          <button class="find" type="button" data-find="${e.id}" title="Show ${t.name}'s capital" aria-label="Show ${t.name}'s capital">&#9678;</button>`;
        const cls = `standing${!vacant && !e.alive ? " dead" : ""}${vacant ? " vacant" : ""}`;
        // An empire with people in it opens to list them.
        if (vacant || state.empires[e.id - 1]!.members.length === 0) return `<div class="${cls}">${row}</div>`;
        return `<details class="standing-group" data-empire="${e.id}"${this.expanded.has(e.id) ? " open" : ""}>
          <summary class="${cls}">${row}</summary>
          <div class="members">${this.members(state, e.id)}</div>
        </details>`;
        })
        .join(""),
      values,
    );
  }

  setZoomHint(text: string): void {
    this.els.zoomhint.textContent = text;
  }
}
