// The start page's lists, all showing at once:
//
// - Your games: the ones you are in that have not finished, to resume,
//   private ones included.
// - Public games: open and running together. An open one you can join; a
//   running one you can watch.
// - Finished: games that have ended, to watch back: yours (private ones
//   included) and public ones.
// - The leaderboard: the top ten for each stat, over every game or the best
//   single game.
//
// Read from the Worker's records whenever the start page is shown. Nothing
// here polls.

import { empireTheme } from "./palette";
import { escape } from "./escape";
import { leaderboard, listGames, playerStats } from "../net/records";
import type { LeaderScope, LeaderStat, ListedGame, PlayerGame } from "../net/records";

export interface GamesHandlers {
  open: (roomId: string) => void;
  /** Watch a finished game from its archive. */
  replay: (roomId: string) => void;
  /** The key whose games "Your games" shows. */
  me: () => Promise<string>;
}

const STATS: Array<[LeaderStat, string, string]> = [
  ["won", "Games won", "wins"],
  ["area", "Area", "tiles"],
  ["population", "Population", "at the peak"],
  ["cascade", "Coin cascade", "tiles in one"],
];

export class GamesPanel {
  private scope: LeaderScope = "total";
  /** Bumped on every load, so a slow answer from an old one is dropped. */
  private ticket = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: GamesHandlers,
  ) {
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const scope = target.closest<HTMLElement>("[data-leader-scope]");
      if (scope) {
        this.scope = scope.dataset.leaderScope as LeaderScope;
        void this.loadLeaders();
        return;
      }
      const game = target.closest<HTMLElement>("[data-games-open]");
      if (!game) return;
      if (game.dataset.gamesEnded) handlers.replay(game.dataset.gamesOpen!);
      else handlers.open(game.dataset.gamesOpen!);
    });
    root.innerHTML = `
      <section class="card" data-list="mine" hidden></section>
      <section class="card" data-list="public"></section>
      <section class="card" data-list="finished"></section>
      <section class="card" data-list="leaders"></section>`;
  }

  /** Load every list afresh. */
  refresh(): void {
    const ticket = ++this.ticket;
    const section = (name: string): HTMLElement => this.root.querySelector(`[data-list="${name}"]`)!;
    const fill = (name: string, html: string): void => {
      if (ticket === this.ticket) section(name).innerHTML = html;
    };
    const failed = (name: string, title: string) => (error: Error) =>
      fill(name, `<h2>${title}</h2><p class="hint">Could not load this: ${escape(error.message)}</p>`);

    // Yours first, so the public list can say "Resume" for a game you are in.
    const all = this.handlers
      .me()
      .then(playerStats)
      .then((stats) => stats.games)
      .catch(() => [] as PlayerGame[]);
    const mine = all.then((games) => games.filter((g) => g.phase !== "ended"));

    void mine.then((games) => {
      if (ticket !== this.ticket) return;
      section("mine").hidden = games.length === 0;
      fill("mine", `<h2>Your games</h2>${this.list(games, () => "resume")}`);
    });

    void Promise.all([listGames("open"), listGames("running"), mine]).then(([open, running, yours]) => {
      const seen = new Set<string>();
      // Yours are listed above, so not again here.
      for (const g of yours) seen.add(g.id);
      const merged = [...open, ...running].filter((g) => !seen.has(g.id) && seen.add(g.id));
      const now = Date.now();
      fill(
        "public",
        `<h2>Public games</h2>${
          merged.length
            ? this.list(merged, (g) => (g.phase === "lobby" || (g.joinUntil ?? 0) > now ? "join" : "watch"))
            : `<p class="hint">No public games right now. Make one with New game, and list it publicly under More.</p>`
        }`,
      );
    }, failed("public", "Public games"));

    void Promise.all([listGames("ended"), all]).then(([ended, yours]) => {
      // Yours first, with how you did; then the public ones you were not in.
      const seen = new Set<string>();
      const games = [...yours.filter((g) => g.phase === "ended"), ...ended]
        .filter((g) => !seen.has(g.id) && seen.add(g.id))
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
      fill(
        "finished",
        `<h2>Finished</h2>${games.length ? this.list(games, () => "view") : `<p class="hint">No games have finished yet.</p>`}`,
      );
    }, failed("finished", "Finished"));

    void this.loadLeaders(ticket);
  }

  private async loadLeaders(ticket = this.ticket): Promise<void> {
    const section = this.root.querySelector<HTMLElement>('[data-list="leaders"]')!;
    const scopes: Array<[LeaderScope, string]> = [
      ["total", "All games"],
      ["game", "Best single game"],
    ];
    const head = `<div class="list-head"><h2>Leaderboard</h2>
      <div class="seg">${scopes
        .map(
          ([value, label]) =>
            `<button type="button" class="seg-btn${value === this.scope ? " on" : ""}" data-leader-scope="${value}">${label}</button>`,
        )
        .join("")}</div></div>`;
    try {
      const lists = await leaderboard(this.scope);
      if (ticket !== this.ticket) return;
      const any = STATS.some(([stat]) => lists[stat]?.length);
      section.innerHTML = `${head}${
        any
          ? `<div class="leaders">${STATS.map(([stat, title, unit]) => this.leaders(title, unit, lists[stat] ?? [])).join("")}</div>`
          : `<p class="hint">Nobody has finished a game yet.</p>`
      }`;
    } catch (error) {
      if (ticket === this.ticket) section.innerHTML = `${head}<p class="hint">Could not load this: ${escape((error as Error).message)}</p>`;
    }
  }

  private leaders(title: string, unit: string, rows: Array<{ key: string; name: string; value: number }>): string {
    return `<div class="leader-list"><h3>${title}</h3>${
      rows.length
        ? `<ol>${rows
            .map(
              (r) => `<li><span class="leader-name">${escape(r.name)} <span class="hint">#${escape(r.key.slice(0, 6))}</span></span>
                <b>${r.value.toLocaleString()}</b></li>`,
            )
            .join("")}</ol><p class="hint">${unit}</p>`
        : `<p class="hint">Nobody yet.</p>`
    }</div>`;
  }

  private list(games: Array<ListedGame | PlayerGame>, action: (g: ListedGame) => "resume" | "join" | "watch" | "view"): string {
    return `<ul class="games-list">${games.map((g) => this.row(g, action(g))).join("")}</ul>`;
  }

  private row(game: ListedGame | PlayerGame, action: "resume" | "join" | "watch" | "view"): string {
    const mine = "empire" in game ? game : undefined;
    const theme = mine?.empire ? empireTheme(mine.empire) : undefined;
    const size = `${game.width}×${game.height}`;
    const people = `${game.players} ${game.players === 1 ? "player" : "players"}`;
    const bots = `${game.bots} ${game.bots === 1 ? "bot" : "bots"}`;
    const label = { resume: game.phase === "lobby" ? "Open lobby" : "Resume", join: "Join", watch: "Watch", view: "View" }[action];
    return `<li class="game-row">
      ${theme ? `<span class="swatch" style="background:${theme.c1}"></span>` : ""}
      <span class="game-what">
        <span><strong>${escape(game.id)}</strong> · ${escape(this.status(game, mine))}</span>
        <span class="hint">${size}, ${game.empires} ${game.empires === 1 ? "empire" : "empires"} + ${bots}, ${people}</span>
      </span>
      <button class="btn btn-small${action === "join" || action === "resume" ? " go" : ""}" type="button"
        data-games-open="${escape(game.id)}"${action === "view" ? " data-games-ended" : ""}>${label}</button>
    </li>`;
  }

  private status(game: ListedGame, mine?: PlayerGame): string {
    const now = Date.now();
    if (game.phase === "lobby") return game.startsAt ? `starts ${when(game.startsAt, now)}` : "in the lobby";
    if (game.phase === "ended") {
      if (mine?.place) return mine.won ? "you won" : `you came ${ordinal(mine.place)}`;
      return game.winner ? `won by ${empireTheme(game.winner).name}` : "ended";
    }
    const joining = game.joinUntil && game.joinUntil > now ? `, joining until ${when(game.joinUntil, now)}` : "";
    return game.endsAt ? `ends ${when(game.endsAt, now)}${joining}` : `running${joining}`;
  }
}

function when(at: number, now: number): string {
  const ms = at - now;
  const abs = Math.abs(ms);
  const span =
    abs < 3_600_000
      ? `${Math.max(1, Math.round(abs / 60_000))} min`
      : abs < 172_800_000
        ? `${Math.round(abs / 3_600_000)} h`
        : `${Math.round(abs / 86_400_000)} days`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}
