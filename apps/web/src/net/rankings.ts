// A table somebody else derived, and what it costs to take it.
//
// Today `buildTable` fetches every archive URL in settings, one at a time, and
// posts them to a worker that replays all of them. For a player with six hosts
// listed that is six multi-megabyte downloads and six full replays, and it takes
// minutes. With a service configured there is a second route: fetch the table.
//
// The cost is that it is somebody's claim rather than this browser's derivation,
// and the whole of the honesty is that the two get different sentences under
// them. A hosted table names its host, so a reader can see whose claim they are
// looking at; a local one says "this browser was given". A client that rendered
// them identically would be the failure, and it would fail silently.
//
// The local path is not removed and must not be. A player with a file on disk
// and no service configured still gets a table, and the ability to check a
// hosted one by replaying its corpus locally is the property the whole design
// rests on — which means the code that does it has to stay.

import type { Leaderboard } from "@tessera/net";

/** Same deadline the address book uses. A table is small — it is a few hundred
 *  rows of arithmetic — so this is about a service that accepts a connection
 *  and never answers, not about a large body. */
export const TABLE_TIMEOUT_MS = 15_000;

/** A table is standings and refusals. Big only if the corpus is, and the corpus
 *  is a list of ids. */
export const TABLE_CAP = 4_000_000;

/** Which of the two tables a service publishes. */
export type Window = "held" | "all";

/** What a hosted service answers. `Leaderboard`'s shape, plus the three fields
 *  only a hosted table needs: how many games, when it was derived, and the
 *  sentence that bounds it. */
export interface HostedTable extends Omit<Leaderboard, "counted"> {
  /** The corpus — ids for the window, `null` for all-time, because an all-time
   *  corpus is unbounded. Null is not "nothing counted": it means fetch
   *  `/rankings/applied` instead. */
  counted: string[] | null;
  games: number;
  derivedAt: string;
  scope: string;
}

/** One table, or an error worth reading.
 *
 *  Nothing here checks the figures, and nothing can from inside one fetch. What
 *  makes them checkable is `counted`: the ids the service says went into the
 *  table, which a reader fetches from the same service's `/archives/:gameId` and
 *  runs `rankArchives` over. That is a recipe rather than a guarantee, and the
 *  client's job is to keep it possible and to say whose claim this is. */
export async function fetchTable(
  base: string,
  window: Window = "held",
  http: typeof fetch = (...args) => globalThis.fetch(...args),
  timeoutMs: number = TABLE_TIMEOUT_MS,
): Promise<HostedTable> {
  const url = `${base.replace(/\/+$/, "")}/rankings?window=${window}`;
  let response: Response;
  try {
    response = await http(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A CORS refusal is opaque and looks exactly like a service that is down.
    // Both get the same sentence, because from here they are the same event.
    throw new Error(
      `could not read that table — the service may be down, or it may not allow ` +
        `this page to read it (${(error as Error).message})`,
    );
  }

  if (!response.ok) throw new Error(`that service answered ${response.status}`);

  const text = await response.text();
  if (text.length > TABLE_CAP) throw new Error("that service sent more than a table");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("that service did not answer with JSON");
  }
  if (!isTable(body)) throw new Error("that service did not answer with a table");
  return body;
}

/** The shape check, and only the shape — the same discipline `isArchive` uses,
 *  so "that is not a table" and "that table says something odd" stay different
 *  sentences. */
export function isTable(value: unknown): value is HostedTable {
  if (!value || typeof value !== "object") return false;
  const table = value as Partial<HostedTable>;
  if (!Array.isArray(table.standings) || !Array.isArray(table.refused)) return false;
  if (table.counted !== null && !Array.isArray(table.counted)) return false;
  return typeof table.scope === "string";
}

/** The host, as a reader should see it named. The origin rather than the whole
 *  URL, because the sentence under a table wants "api.example" and not a path
 *  and a query string. A URL that will not parse is shown as typed rather than
 *  dropped: the player wrote it, and hiding it would make the table look like
 *  nobody's. */
export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
