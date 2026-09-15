// Fetching finished games, from the only places that hold any.
//
// `rankArchives` takes archives and an address book holds none: 0007's row is
// the doors into a *live* game, and its TTL removes it shortly after the last
// door closes — which is exactly the moment a game becomes rankable. There is no
// index of finished games anywhere in this series, and adding one means giving a
// board a second job (holding megabytes, indefinitely) that it was written to
// refuse.
//
// So the leaderboard here is scoped and says what it is scoped to: archive URLs
// the player configured, plus files they have on disk. A public, cross-host
// table needs that index, and that is a plan rather than a paragraph in this
// one.
//
// **Corrected against plan 0008**, which says settings hold "a list of host
// peers to read from". A host peer serves `GET /room/:code/archive` and has no
// endpoint that enumerates its rooms, so a base URL alone is not enough to fetch
// anything. What is stored is therefore the archive URL itself — which is also
// what a person actually has, because it is what they were sent.

import type { ArchivedGame } from "@tessera/net";

/** Same deadline the address book uses. An archive is bigger but the question is
 *  the same one: a host that accepts a connection and never answers should not
 *  hold a screen open for as long as the page is. */
export const ARCHIVE_TIMEOUT_MS = 30_000;

/** A multi-day game's log is genuinely large — this is the one fetch in the
 *  client where megabytes are legitimate — but `response.json()` will buffer
 *  whatever it is given, so there is still a ceiling. */
export const ARCHIVE_CAP = 64_000_000;

/** One archive, or an error worth reading.
 *
 *  Nothing here checks the game. `verifyArchive` does that, in a worker, over
 *  every archive at once — and it is the whole reason a URL in this list carries
 *  no authority: a host that serves a forged log has served a log that will be
 *  refused by name. */
export async function fetchArchive(
  url: string,
  http: typeof fetch = (...args) => globalThis.fetch(...args),
  timeoutMs: number = ARCHIVE_TIMEOUT_MS,
): Promise<ArchivedGame> {
  let response: Response;
  try {
    response = await http(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A CORS refusal is opaque and looks exactly like a host that is down. Both
    // get the same sentence, because from here they are the same event.
    throw new Error(
      `could not read it — the host may be down, or it may not allow this page ` +
        `to read it (${(error as Error).message})`,
    );
  }

  if (!response.ok) throw new Error(`answered ${response.status} ${response.statusText}`.trim());

  const text = await response.text();
  if (text.length > ARCHIVE_CAP) throw new Error("answered more than a game's worth of data");

  let game: unknown;
  try {
    game = JSON.parse(text);
  } catch {
    throw new Error("answered something that is not JSON");
  }
  if (!isArchive(game)) throw new Error("answered something that is not a saved game");
  return game;
}

/** The shape check, and only the shape. Everything that decides whether a file
 *  is *true* is `verifyArchive`'s; this exists so that "not a saved game" and
 *  "a saved game that did not check out" stay different sentences. */
export function isArchive(value: unknown): value is ArchivedGame {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<ArchivedGame>;
  return !!game.genesis && Array.isArray(game.moveLog);
}

/** The archive URLs a player has configured, one per line, blank lines dropped.
 *
 *  Stored as an array and edited as text, because a list of three URLs in a
 *  settings drawer is a textarea and not a widget. */
export function urlsFrom(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
