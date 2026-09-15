// Games other people are running, and what each row offers.
//
// Two halves, split on purpose. `rows()` turns listings into plain objects and
// `render()` turns those into strings, because this package has no jsdom and a
// card whose whole job is markup cannot otherwise be tested at all. Every claim
// worth making about a row — a closed join window, a length read back out of a
// step count, a game this build cannot play, a game with no door left to knock
// on — is an assertion about that array, under Node, with no DOM anywhere.
//
// It owns its own root and its own listener, following `Rivals` rather than
// living inside `LobbyPanel`. That panel replaces its `innerHTML` wholesale and
// `main.ts` drives it five times a second; a list of games inside it would have
// its rows rebuilt under the player's cursor between the mousedown and the
// mouseup. The panel is right to work that way — three short phases and no text
// to preserve — and it is exactly why this is a sibling of it.
//
// Nothing here decides anything. `GameListing` has already had its genesis
// re-hashed and its rules re-derived by `Directory`; what is left for a view to
// do is say which numbers are facts and which are the board's claims, and never
// to render one as the other.

import { STEPS_PER_SECOND, CONTROL } from "@tessera/sim";
import type { GameListing } from "@tessera/net";

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What a row's button does, or that there is nothing for it to do.
 *
 *  `rejoin` is the row the address book exists for: a game whose doors are all
 *  gone but whose state a keeper wrote down. Derived here from the listing
 *  alone — no refs, but a resume URL — and refined once `resolve` has actually
 *  knocked, because "announced no doors" and "announced doors that no longer
 *  answer" look identical to a player and only one of them can be known without
 *  dialling. */
export type RowAction = "join" | "rejoin" | "none";

/** One game, as a row reads. Strings, because every one of them is a rendering
 *  decision that is worth being able to assert on. */
export interface GameRow {
  gameId: string;
  /** Enough of the id to tell two games apart, which is all an id is for here.
   *  A game has no name until 0012 gives it one. */
  short: string;
  /** "4 empires · 160×112" */
  title: string;
  /** "2 of them bots", or nothing when they are all people. */
  opponents: string;
  /** "3 hours", "3 days" — the length the record says, never the board. */
  length: string;
  /** "2:14:09 left", "ended", or nothing at all for an open-ended game. */
  timeLeft: string;
  /** "seats open for 41:02" while the join window is open, "seats closed" once
   *  it has shut, nothing when the record sets no window. */
  joining: string;
  /** "4 seats", and the empty ones when there are any. Derived from the record,
   *  so it cannot be lied about. */
  seats: string;
  /** What the board says about occupancy, marked as the claim it permanently
   *  is. Empty when the board claimed nothing. */
  claim: string;
  /** "2 ways in", "one way in", or "no doors listed". */
  doors: string;
  /** The witnesses, which are the only thing on a row a stranger cannot
   *  manufacture. */
  proof: string;
  /** Anything that should stop a player before they click: a version this build
   *  cannot play, a rule set with a sunset, doors it cannot read. */
  notes: string[];
  action: RowAction;
}

/** What knocking on a row's doors turned up. A row starts with none of this —
 *  the card is drawn from listings, and a listing cannot say whether anybody is
 *  still there — and gains one the moment `resolve` has actually dialled.
 *
 *  The `resume` case is the one this exists for. A game whose doors have all
 *  closed is not a gone game, but taking it up means adopting a state signed by
 *  a quorum of its seats, and that is a thing to show somebody before they
 *  commit to it rather than after. */
export type RowOffer =
  | { kind: "knocking" }
  | { kind: "resume"; tally: string; step: number }
  | { kind: "gone"; problems: string[] };

export interface GamesHandlers {
  /** Go to this game. How is emphatically not the card's business — `resolve`
   *  and the lobby belong to `main.ts`, and a view that opened connections
   *  would be a second join sequence. */
  open: (row: GameRow) => void;
  /** Take up a resume point the player has now seen the tally for. */
  resume: (row: GameRow) => void;
}

/** What the card is showing when it is not showing games. Four states, because
 *  a board that is down and a board with no games are different sentences and
 *  the fetch reports them identically. */
type Mood =
  | { kind: "unset" }
  | { kind: "loading" }
  | { kind: "listed"; rows: GameRow[] }
  | { kind: "problem"; message: string; url: string };

export class Games {
  private mood: Mood = { kind: "unset" };
  /** What `resolve` found, per game, since this list was drawn. Kept beside the
   *  rows rather than in them: a refreshed list replaces the rows and should not
   *  silently throw away the knock the player is in the middle of reading. */
  private readonly offers = new Map<string, RowOffer>();

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: GamesHandlers,
  ) {
    this.root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-game]");
      if (!button) return;
      // A bare <button> inside anything that may become a form defaults to
      // submitting, which would reload the page.
      event.preventDefault();
      if (this.mood.kind !== "listed") return;
      const row = this.mood.rows.find((one) => one.gameId === button.dataset.game);
      if (!row) return;
      if (button.dataset.act === "resume") return this.handlers.resume(row);
      this.handlers.open(row);
    });

    this.render();
  }

  /** What knocking turned up for one row. */
  offer(gameId: string, offer: RowOffer): void {
    this.offers.set(gameId, offer);
    this.render();
  }

  /** No board has been configured, which is the default and is not an error.
   *  There is no board shipped with this client and no public one to fall back
   *  to — a board is a URL that arrives the way a room code used to. */
  unset(): void {
    this.mood = { kind: "unset" };
    this.render();
  }

  loading(): void {
    this.mood = { kind: "loading" };
    this.render();
  }

  show(listings: readonly GameListing[], now = Date.now()): void {
    this.mood = { kind: "listed", rows: rows(listings, now) };
    // A knock is about doors, and a fresh list may carry different ones. Games
    // that are gone from the board lose their offer with their row.
    for (const gameId of [...this.offers.keys()]) {
      if (!this.mood.rows.some((one) => one.gameId === gameId)) this.offers.delete(gameId);
    }
    this.render();
  }

  /** The board could not be read. The URL goes on screen with the message,
   *  because "could not read that board" is unactionable without knowing which
   *  board was tried — and the most common cause is a URL typed slightly
   *  wrong. */
  problem(message: string, url: string): void {
    this.mood = { kind: "problem", message, url };
    this.render();
  }

  render(): void {
    this.root.innerHTML = this.body();
  }

  private body(): string {
    const head = `<h2>Games</h2>`;

    if (this.mood.kind === "unset") {
      return `${head}
        <p class="card-tag">Games other people are running show up here. Put an
        address book in <strong>Settings</strong> below to see them &mdash; there
        is no default one, because a board is a URL somebody sends you the way a
        room code used to be.</p>`;
    }

    if (this.mood.kind === "loading") {
      return `${head}<p class="card-tag">Reading the address book&hellip;</p>`;
    }

    if (this.mood.kind === "problem") {
      return `${head}
        <p class="card-tag lobby-problem">${escape(this.mood.message)}</p>
        <p class="hint">Tried <code>${escape(this.mood.url)}</code>. A board that is
        down and a board that does not allow this page to read it look the same
        from here.</p>`;
    }

    if (this.mood.rows.length === 0) {
      return `${head}<p class="card-tag">That address book is not listing any games
        right now.</p>`;
    }

    return `${head}
      <p class="card-tag">Anyone can list a game on a board, so your browser
      checks every one it is shown. What a board cannot fake is the
      witnesses.</p>
      <ul class="games-list">${this.mood.rows
        .map((one) => row(one, this.offers.get(one.gameId)))
        .join("")}</ul>`;
  }
}

/** One row's markup. Free of the class on purpose: it takes a `GameRow` and
 *  whatever knocking turned up, so a test can hand it both. */
function row(one: GameRow, offer?: RowOffer): string {
  const facts = [one.length, one.timeLeft, one.joining].filter(Boolean);
  const under = [one.seats, one.doors, one.claim].filter(Boolean);

  return `<li class="games-row${one.action === "none" ? " games-row-off" : ""}">
    <div class="games-main">
      <strong class="games-title">${escape(one.title)}</strong>
      ${one.opponents ? `<span class="games-op">${escape(one.opponents)}</span>` : ""}
      <span class="games-id">#${escape(one.short)}</span>
    </div>
    <p class="games-facts">${facts.map(escape).join(" &middot; ")}</p>
    <p class="games-facts">${under.map(escape).join(" &middot; ")}</p>
    <p class="games-proof">${escape(one.proof)}</p>
    ${one.notes.map((note) => `<p class="hint lobby-problem">${escape(note)}</p>`).join("")}
    ${found(one, offer)}
    <div class="games-act">${act(one, offer)}</div>
  </li>`;
}

/** What knocking turned up, under the row rather than in place of it: the facts
 *  about the game have not changed because nobody answered the door. */
function found(one: GameRow, offer?: RowOffer): string {
  if (!offer) return "";
  if (offer.kind === "knocking") {
    return `<p class="hint">Knocking on ${escape(one.doors)}&hellip;</p>`;
  }
  if (offer.kind === "resume") {
    // The tally, before the player commits to anything. This is the whole of
    // what the rejoin flow has to say for itself: nobody is in this game, and a
    // majority of the seats that were signed for the state you would be taking
    // up.
    return `<p class="games-found">Nobody is there. ${escape(offer.tally)}, at step
      ${offer.step.toLocaleString()}. Taking it up puts the game back on the board
      with you in it.</p>`;
  }
  return `<div class="games-found">
    <p>Could not get in:</p>
    <ul class="games-problems">${offer.problems
      .map((problem) => `<li>${escape(problem)}</li>`)
      .join("")}</ul>
  </div>`;
}

/** The button, which is a different button once a knock has come back. */
function act(one: GameRow, offer?: RowOffer): string {
  if (one.action === "none") return `<span class="hint">Nothing to join</span>`;
  if (offer?.kind === "knocking") {
    return `<button class="btn" type="button" disabled>Knocking&hellip;</button>`;
  }
  if (offer?.kind === "resume") {
    return `<button class="btn primary" type="button" data-act="resume"
      data-game="${escape(one.gameId)}">Take it up</button>`;
  }
  // A dead knock leaves the button, because a game whose host is rebooting is a
  // game worth trying again in a minute.
  const label = offer?.kind === "gone" ? "Try again" : one.action === "rejoin" ? "Rejoin" : "Join";
  return `<button class="btn" type="button" data-game="${escape(one.gameId)}">${label}</button>`;
}

/** Listings to rows. The whole of this file that is worth testing. */
export function rows(listings: readonly GameListing[], now: number): GameRow[] {
  return listings.map((one) => {
    const bots = one.genesis.empires.filter((e) => e.control === CONTROL.SIMBOT).length;
    const empires = one.genesis.empires.length;
    const { width, height } = one.genesis.map;
    const empty = one.seats.total - one.seats.keyed;

    const notes: string[] = [];
    // Shown, never hidden. A lobby that silently omits the game a player is in
    // is the worst possible answer, so a game this build cannot play is a row
    // that says why.
    if (!one.playable) {
      notes.push(`This build does not play v${one.genesis.protocol} games.`);
    }
    if (one.sunset) {
      notes.push(
        `This game uses rule set ${one.sunset.version}. Your build plays it until ${one.sunset.until}.`,
      );
    }
    if (one.unreadable.length > 0) {
      notes.push(
        one.unreadable.length === 1
          ? `One of its doors is a kind this build cannot open.`
          : `${one.unreadable.length} of its doors are kinds this build cannot open.`,
      );
    }

    return {
      gameId: one.gameId,
      short: one.gameId.slice(0, 12),
      title: `${empires} ${empires === 1 ? "empire" : "empires"} · ${width}×${height}`,
      opponents: bots > 0 ? `${bots} of them ${bots === 1 ? "a bot" : "bots"}` : "",
      length: lengthLabel(one.genesis.rules.endStep ?? 0),
      timeLeft: timeLeftLabel(one.endsAt, now),
      joining: joiningLabel(one.joinableUntil, now),
      seats: empty > 0 ? `${one.seats.total} seats, ${empty} empty` : `${one.seats.total} seats`,
      claim: claimLabel(one.seatsUsed),
      doors: doorsLabel(one.refs.length),
      proof: proofLabel(one.proof),
      notes,
      action: actionFor(one),
    };
  });
}

function actionFor(one: GameListing): RowAction {
  // Nothing to offer: this build would refuse the record on arrival, so a
  // button here would be a button that fails.
  if (!one.playable) return "none";
  if (one.refs.length > 0) return "join";
  // No doors at all, but somebody kept the state. This is the row the address
  // book exists for: a game everybody left on Tuesday is not a gone game.
  if (one.resume.length > 0) return "rejoin";
  return "none";
}

/** A step count as a length a person would say. The record carries steps —
 *  twelfths of a second — and nobody looking for a game to join thinks in
 *  those. Exact divisions only: a game of 72 hours is "3 days", and one of 90
 *  minutes is "90 minutes" rather than a rounded "2 hours" that would be a
 *  different game. */
export function lengthLabel(steps: number): string {
  if (steps <= 0) return "open-ended";
  const seconds = Math.round(steps / STEPS_PER_SECOND);
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds >= 60) return plural(Math.round(seconds / 60), "minute");
  return plural(seconds, "second");
}

function timeLeftLabel(endsAt: number | undefined, now: number): string {
  if (endsAt === undefined) return "";
  return endsAt <= now ? "ended" : `${span(endsAt - now)} left`;
}

/** The join window, and only while it is open. Once it has shut it stops being
 *  news about when to hurry and becomes a fact about the game, which is what
 *  "seats closed" says. */
function joiningLabel(joinableUntil: number | undefined, now: number): string {
  if (joinableUntil === undefined) return "";
  return joinableUntil > now ? `seats open for ${span(joinableUntil - now)}` : "seats closed";
}

/** Occupancy is a claim, permanently: it moves by amendment and by drop and the
 *  board sees neither. Rendered as one, in the board's voice, or not at all. */
function claimLabel(seatsUsed: number | undefined): string {
  return seatsUsed === undefined ? "" : `the board says ${seatsUsed} are in use`;
}

function doorsLabel(count: number): string {
  if (count === 0) return "no doors listed";
  return count === 1 ? "one way in" : `${count} ways in`;
}

/** The witnesses, said plainly. A row with them is a game; a row without them
 *  is a rumour, and both are shown — hiding the unproven ones would hide every
 *  game composed in the last five minutes, which are the games a board is most
 *  needed for.
 *
 *  `needed` is the tally's own word for a majority of an electorate this view
 *  never sees, so it is quoted rather than recounted. */
function proofLabel(proof: GameListing["proof"]): string {
  if (!proof) return "No witnesses yet — nobody has vouched that this game exists.";
  if (proof.ok) {
    return `Witnessed at step ${proof.step.toLocaleString()} by ${proof.endorsed} of the ${proof.needed} seats it needs.`;
  }
  return `Claims step ${proof.step.toLocaleString()}, with only ${proof.endorsed} of the ${proof.needed} signatures it needs.`;
}

const pad = (value: number): string => String(value).padStart(2, "0");

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

/** A duration in milliseconds, at the precision it is worth reading. A game
 *  with two days left does not need its seconds; one with four minutes left
 *  needs nothing else. */
function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
