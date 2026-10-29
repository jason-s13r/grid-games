// The games card: public games to join or watch, your own games, and who has
// won the most. Read from the Worker's records when a tab is opened, and again
// when it is opened later; nothing here polls.

import { empireTheme } from "./palette";
import { escape } from "./escape";
import { leaderboard, listGames, playerStats } from "../net/records";
import type { ListedGame, PlayerGame } from "../net/records";

type Tab = "open" | "running" | "ended" | "mine" | "leaders";

const TABS: Array<[Tab, string]> = [
  ["open", "Open"],
  ["running", "Running"],
  ["ended", "Finished"],
  ["mine", "Mine"],
  ["leaders", "Leaderboard"],
];

const EMPTY: Record<Tab, string> = {
  open: "No public games are taking players right now. Create one and tick “List it publicly”.",
  running: "No public games are running.",
  ended: "No public games have finished yet.",
  mine: "You have not played online yet.",
  leaders: "Nobody has finished a game yet.",
};

export interface GamesHandlers {
  open: (roomId: string) => void;
  /** Watch a finished game from its archive. */
  replay: (roomId: string) => void;
  /** The key whose games "Mine" shows. */
  me: () => Promise<string>;
}

export class GamesPanel {
  private tab: Tab = "open";
  /** Bumped on every load, so a slow answer for an old tab is dropped. */
  private ticket = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: GamesHandlers,
  ) {
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const tab = target.closest<HTMLElement>("[data-games-tab]");
      if (tab) {
        this.show(tab.dataset.gamesTab as Tab);
        return;
      }
      const game = target.closest<HTMLElement>("[data-games-open]");
      if (!game) return;
      if (game.dataset.gamesEnded) handlers.replay(game.dataset.gamesOpen!);
      else handlers.open(game.dataset.gamesOpen!);
    });
  }

  /** Show a tab, fetching it fresh. */
  show(tab: Tab = this.tab): void {
    this.tab = tab;
    this.paint(`<p class="hint">Loading…</p>`);
    const ticket = ++this.ticket;
    void this.body(tab).then(
      (html) => ticket === this.ticket && this.paint(html),
      (error: Error) =>
        ticket === this.ticket && this.paint(`<p class="hint">Could not load this: ${escape(error.message)}</p>`),
    );
  }

  private paint(body: string): void {
    const tabs = TABS.map(
      ([id, label]) =>
        `<button type="button" class="btn btn-small${id === this.tab ? " primary" : ""}" data-games-tab="${id}"
           aria-pressed="${id === this.tab}">${label}</button>`,
    ).join("");
    this.root.innerHTML = `<div class="games-tabs">${tabs}</div><div class="games-body">${body}</div>`;
  }

  private async body(tab: Tab): Promise<string> {
    if (tab === "leaders") {
      const leaders = await leaderboard();
      if (!leaders.length) return `<p class="hint">${EMPTY.leaders}</p>`;
      const rows = leaders
        .map(
          (l, i) => `<tr><td>${i + 1}</td><td>${escape(l.name)} <span class="hint">#${escape(l.key.slice(0, 6))}</span></td>
            <td>${l.won}</td><td>${l.played}</td><td>${Math.round(l.score * 100)}%</td></tr>`,
        )
        .join("");
      return `<table class="games-table"><thead><tr><th></th><th>Player</th><th>Won</th><th>Played</th>
        <th title="Average finish: 100% is always first, 0% always last">Finish</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    if (tab === "mine") {
      const stats = await playerStats(await this.handlers.me());
      if (!stats.games.length) return `<p class="hint">${EMPTY.mine}</p>`;
      const record = `<p class="card-tag">${stats.played} finished, ${stats.won} won${
        stats.bestPlace ? `, best place ${stats.bestPlace}` : ""
      }, ${stats.tilesTaken.toLocaleString()} tiles taken.</p>`;
      return record + this.list(stats.games);
    }

    const games = await listGames(tab);
    return games.length ? this.list(games) : `<p class="hint">${EMPTY[tab]}</p>`;
  }

  private list(games: Array<ListedGame | PlayerGame>): string {
    return `<ul class="games-list">${games.map((g) => this.row(g)).join("")}</ul>`;
  }

  private row(game: ListedGame | PlayerGame): string {
    const mine = "empire" in game ? game : undefined;
    const theme = mine?.empire ? empireTheme(mine.empire) : undefined;
    const size = `${game.width}×${game.height}`;
    const people = `${game.players} ${game.players === 1 ? "player" : "players"}`;
    const action = game.phase === "ended" ? "View" : game.phase === "lobby" ? "Join" : mine?.empire ? "Play" : "Open";
    return `<li class="lobby-seat">
      ${theme ? `<span class="swatch" style="background:${theme.c1}"></span>` : ""}
      <span class="lobby-who"><strong>${escape(game.id)}</strong> · ${escape(this.status(game, mine))}
        <span class="hint">· ${size}, ${game.empires} empires + ${game.bots} bots, ${people}</span></span>
      <button class="btn btn-small" type="button" data-games-open="${escape(game.id)}"${
        game.phase === "ended" ? " data-games-ended" : ""
      }>${action}</button>
    </li>`;
  }

  private status(game: ListedGame, mine?: PlayerGame): string {
    const now = Date.now();
    if (game.phase === "lobby") {
      return game.startsAt ? `starts ${when(game.startsAt, now)}` : "in the lobby";
    }
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
