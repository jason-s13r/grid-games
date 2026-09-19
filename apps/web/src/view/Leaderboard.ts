// The table, and the list of everything that did not get into it.
//
// A leaderboard is normally the least trustworthy thing a game has: a number a
// client reported, kept by a server nobody can audit. This one is derived —
// every figure comes out of hashed state after replaying a signed log — so the
// interesting half of the screen is the refusals, and they are rendered beside
// the table rather than swallowed. `tessera-observe rank` prints them for the
// same reason: a leaderboard that silently drops what it could not check is one
// nobody can audit, and that is precisely the property the signatures were for.
//
// The other thing this view has to be honest about is its *scope*. There is no
// index of finished games anywhere in Tessera, so this table is over the
// archives this player happens to have, and it says so where the table's heading
// would normally imply otherwise.

import { MEMBER } from "@tessera/sim";
import type { Leaderboard as Table, Standing } from "@tessera/net";
import type { HostedTable, Window } from "../net/rankings";

export interface Refusal {
  /** The URL or filename it came from. `rankArchives` refuses by position,
   *  because two archives of one game share a game id and telling somebody
   *  which *file* was the duplicate is the entire point of saying so. */
  source: string;
  problems: string[];
}

export type Mood =
  /** Nothing configured and nothing dropped. */
  | { kind: "unset" }
  | { kind: "idle"; sources: number }
  | { kind: "reading"; done: number; total: number }
  | { kind: "checking"; games: number }
  | { kind: "table"; table: Table; names: string[]; unreadable: Refusal[] }
  /** A table this browser did not derive. It skips straight here — no reading,
   *  no replay — and the whole of what it costs is the sentence underneath. */
  | { kind: "hosted"; table: HostedTable; host: string; window: Window }
  | { kind: "problem"; message: string };

export interface Row {
  key: string;
  short: string;
  kind: string;
  games: number;
  wins: number;
  tiles: number;
  best: number;
}

export interface LeaderboardView {
  label: string;
  /** What the table is over, said out loud. Empty when there is no table.
   *
   *  A table this browser derived keeps "the archives this browser was given";
   *  a table a service derived gets the service's own sentence with the host
   *  named in front of it, because a reader should be able to see whose claim
   *  they are looking at. Rendering the two identically is the failure mode,
   *  and it fails silently. */
  scope: string;
  rows: Row[];
  refusals: Refusal[];
  working: boolean;
  /** Whether pressing the button would do anything. */
  canBuild: boolean;
  /** Which table is on screen. `local` when this browser replayed the files. */
  from: "local" | "hosted";
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A key, shortened. Deliberately the key and not a name: seat numbers are per
 *  game, there are no accounts, and a key is the only identity this game has.
 *  Whoever is reading the table can put a face to it; nothing here can. */
export function shortKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 16)}…` : key;
}

export function rowsOf(standings: readonly Standing[]): Row[] {
  return standings.map((standing) => ({
    key: standing.key,
    short: shortKey(standing.key),
    // A key that ever played a seat of its own is a person who also ran night
    // cover, and `rankArchives` has already made that judgement.
    kind: standing.kind === MEMBER.BOT ? "bot" : "player",
    games: standing.games,
    wins: standing.wins,
    tiles: standing.tilesTaken,
    best: standing.bestMove,
  }));
}

export function view(mood: Mood): LeaderboardView {
  const empty = { rows: [], refusals: [], scope: "", from: "local" as const };

  if (mood.kind === "unset") {
    return {
      ...empty,
      // Says what is missing rather than what the button does: a control that
      // is greyed out with no reason beside it is one people press twice and
      // then stop trusting.
      label:
        "Nothing to build from yet. Open saved games above, or add archive URLs " +
        "in Settings. Nothing is counted until it has been replayed here.",
      working: false,
      canBuild: false,
    };
  }

  if (mood.kind === "idle") {
    return {
      ...empty,
      label: `${plural(mood.sources, "saved game")} to check.`,
      working: false,
      canBuild: mood.sources > 0,
    };
  }

  if (mood.kind === "reading") {
    return { ...empty, label: `Reading ${mood.done} of ${mood.total}…`, working: true, canBuild: false };
  }

  if (mood.kind === "checking") {
    // Named for what it is doing rather than shown as a share of it: this is one
    // call into `rankArchives`, which replays every log it is given and reports
    // nothing on the way through.
    return {
      ...empty,
      label: `Replaying ${plural(mood.games, "game")} to check what they claim…`,
      working: true,
      canBuild: false,
    };
  }

  if (mood.kind === "problem") {
    return { ...empty, label: mood.message, working: false, canBuild: true };
  }

  if (mood.kind === "hosted") {
    const { table, host, window } = mood;
    return {
      label:
        table.games === 0
          ? `${host} has counted nothing.`
          : `${plural(table.games, "game")} counted by ${host}${
              window === "all" ? ", all-time" : ""
            }.`,
      // The service's own sentence, with the host in front of it. Taken from
      // the response rather than written here: the service knows what its table
      // is over and this client does not, and a client that supplied its own
      // qualifier would be guessing on the reader's behalf.
      scope: `${host}: ${table.scope}`,
      rows: rowsOf(table.standings),
      // Rendered either way. A hosted leaderboard has more to hide than a local
      // one and exactly the same obligation.
      refusals: table.refused.map((one) => ({
        // `index` is a position in an input list, which means nothing across a
        // wire. `game` is the field that survives the trip.
        source: `game ${one.game.slice(0, 12)}`,
        problems: one.problems,
      })),
      working: false,
      canBuild: true,
      from: "hosted",
    };
  }

  const { table, names, unreadable } = mood;
  const refusals: Refusal[] = [
    ...unreadable,
    ...table.refused.map((one) => ({
      source: names[one.index] ?? `game ${one.game.slice(0, 12)}`,
      problems: one.problems,
    })),
  ];

  const unfinished =
    table.unfinished > 0
      ? ` ${plural(table.unfinished, "of them has", "of them have")} not finished, so ${
          table.unfinished === 1 ? "it contributes" : "they contribute"
        } no wins.`
      : "";

  return {
    label:
      table.counted.length === 0
        ? "Nothing counted."
        : `${plural(table.counted.length, "game")} counted.${unfinished}`,
    // The sentence that keeps the table from claiming more than it is. There is
    // no index of finished games, so this is over what this browser was handed
    // and nothing else.
    scope: "Over the archives this browser was given — not every game ever played.",
    rows: rowsOf(table.standings),
    refusals,
    working: false,
    canBuild: true,
    from: "local",
  };
}

export interface LeaderboardHandlers {
  build: () => void;
}

export class LeaderboardCard {
  private mood: Mood = { kind: "unset" };

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: LeaderboardHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-rank-build]")) this.handlers.build();
    });
    this.render();
  }

  set(mood: Mood): void {
    this.mood = mood;
    this.render();
  }

  render(): void {
    const shown = view(this.mood);
    this.root.innerHTML = `
      <h2>Leaderboard</h2>
      <p class="card-tag">${escape(shown.label)}</p>
      ${shown.scope ? `<p class="hint">${escape(shown.scope)}</p>` : ""}
      ${shown.rows.length > 0 ? this.table(shown.rows) : ""}
      ${
        shown.refusals.length > 0
          ? `<p class="hint">Not counted:</p>
             <ul class="rank-refusals">${shown.refusals
               .map(
                 (refusal) =>
                   `<li><span class="rank-source">${escape(refusal.source)}</span>
                      <ul>${refusal.problems
                        .map((problem) => `<li>${escape(problem)}</li>`)
                        .join("")}</ul></li>`,
               )
               .join("")}</ul>`
          : ""
      }
      <button class="btn" type="button" data-rank-build${shown.canBuild ? "" : " disabled"}>${
        shown.working ? "Working…" : "Build the table"
      }</button>`;
  }

  private table(rows: readonly Row[]): string {
    return `
      <div class="rank-scroll">
        <table class="rank">
          <thead>
            <tr><th>Key</th><th>Games</th><th>Wins</th><th>Tiles</th><th>Best</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `<tr>
                  <td class="rank-key" title="${escape(row.key)}">${escape(row.short)}${
                    row.kind === "bot" ? ' <span class="rank-bot">bot</span>' : ""
                  }</td>
                  <td>${row.games.toLocaleString()}</td>
                  <td>${row.wins.toLocaleString()}</td>
                  <td>${row.tiles.toLocaleString()}</td>
                  <td>${row.best.toLocaleString()}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>`;
  }
}
