// Where is this game, and if nowhere, what state is it in.
//
// It resolves and stops. Building a driver here would be the third
// implementation of the join sequence — `headless/src/peer.ts` has one with
// WebRTC installation and a pump timer, `apps/web` has one with a render loop,
// and each has real reasons for its own version. What both lacked was an answer
// to the question above, and that answer is the same on every client.
//
// The two halves are the two ways a game can still exist. A room somebody is
// sitting in answers when you dial it. A game everybody left on Tuesday answers
// nothing, and what is left of it is a resume point a host peer kept — bytes
// plus the signatures of a majority of its own seats (0005). A lookup that only
// dialled would call the second one gone.

import { openConnection } from "./connect.js";
import { BOARD_TIMEOUT_MS, CAPS } from "./directory.js";
import type { Directory, GameListing } from "./directory.js";
import { formatRef } from "./ref.js";
import type { ConnectionRef } from "./ref.js";
import { verifyResumePoint } from "./resume.js";
import type { ResumePoint, ResumeTally } from "./resume.js";

/** How long a door gets to answer before the next one is tried. Shorter than
 *  the lobby's own join timeout on purpose: this is a knock, not an arrival,
 *  and a listing with three dead refs should not cost forty-five seconds. */
export const PROBE_TIMEOUT_MS = 6_000;

export type Route =
  /** Dial it. **The caller passes `expect: listing.gameId` to `Lobby.open`** —
   *  that is why this returns a ref rather than a connection, and it is the
   *  check that makes a ref from a stranger safe to use: the room answered, the
   *  room's record will be well formed, and the only remaining question is
   *  whether it is the game we looked up. */
  | { kind: "dial"; ref: ConnectionRef; listing: GameListing }
  /** Nobody is there, but a majority of its seats signed for this state.
   *  `Lockstep.resume` is the caller's call to make, because only the caller
   *  has a driver — and it is the half that checks the bytes. */
  | { kind: "resume"; point: ResumePoint; tally: ResumeTally; listing: GameListing }
  | { kind: "gone"; problems: string[]; listing?: GameListing };

export interface ResolveOptions {
  /** Open a ref and close it again. Injected for tests, and for a client that
   *  already holds a connection it would rather reuse. */
  probe?: (ref: ConnectionRef) => Promise<boolean>;
  now?: () => number;
}

/** Turn a game id into something to do about it. Dials nothing that stays open
 *  and builds nothing. */
export async function resolve(
  directory: Directory,
  gameId: string,
  options: ResolveOptions = {},
): Promise<Route> {
  const problems: string[] = [];

  let listing: GameListing | undefined;
  try {
    listing = await directory.get(gameId);
  } catch (error) {
    return { kind: "gone", problems: [(error as Error).message] };
  }
  if (!listing) return { kind: "gone", problems: ["no board here has heard of that game"] };

  for (const text of listing.unreadable) {
    problems.push(`one of its doors is a kind this build cannot open: ${text}`);
  }
  // Noted, never a refusal. A game that has run out its clock is still worth
  // reaching — the archive is there, the last state is there — and the reason
  // nobody answers the door is something a player should be told rather than
  // left to infer from silence.
  const now = (options.now ?? Date.now)();
  if (listing.endsAt !== undefined && listing.endsAt <= now) {
    problems.push(`that game's clock ran out on ${new Date(listing.endsAt).toISOString()}`);
  }
  if (!listing.playable) {
    problems.push(`this build does not play v${listing.genesis.protocol}`);
  }

  // In announced order, and the first that answers wins. There is no ranking to
  // do: a ref is an address, every door into a game leads to the same game, and
  // preferring one transport over another here would be a fallback ladder —
  // the thing 0003 refused, for the reason it gave.
  const probe = options.probe ?? knock;
  for (const ref of listing.refs) {
    if (await probe(ref).catch(() => false)) return { kind: "dial", ref, listing };
    problems.push(`${formatRef(ref)} did not answer`);
  }

  // Nobody home. What is left is whatever a keeper wrote down, and a point that
  // fails is reported rather than skipped: "the resume point for this game was
  // endorsed by 1 of 4 seats" is something a player should read before deciding
  // that their game is gone.
  let best: { point: ResumePoint; tally: ResumeTally } | undefined;
  for (const url of listing.resume) {
    const point = await readPoint(directory, url).catch((error: Error) => {
      problems.push(error.message);
      return undefined;
    });
    if (!point) continue;
    const tally = await verifyResumePoint(listing.genesis, point);
    if (!tally.ok) {
      // The tally's own words, not a recount: `needed` is a majority of an
      // electorate this function never sees, and inventing the denominator back
      // out of it would be arithmetic on a number that has two answers.
      problems.push(
        `the resume point at ${url} has ${tally.endorsed} of the ${tally.needed} ` +
          `signatures it needs${tally.problems[0] ? ` (${tally.problems[0]})` : ""}`,
      );
      continue;
    }
    if (!best || point.step > best.point.step) best = { point, tally };
  }

  if (best) return { kind: "resume", point: best.point, tally: best.tally, listing };
  return { kind: "gone", problems, listing };
}

/** A resume point, read under the same discipline as a board row: a capped
 *  body, a deadline, and nothing believed until `verifyResumePoint` has
 *  counted. The host peer serving this is a stranger too. */
async function readPoint(directory: Directory, url: string): Promise<ResumePoint | undefined> {
  const response = await directory.http(url, {
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
  }).catch(() => {
    throw new Error(`could not read the resume point at ${url}`);
  });
  if (!response.ok) {
    if (response.status === 404) return undefined; // no point kept yet: not a problem
    throw new Error(`${url} answered ${response.status}`);
  }
  const text = await response.text();
  if (text.length > CAPS.point) throw new Error(`the resume point at ${url} is too large to read`);
  try {
    return JSON.parse(text) as ResumePoint;
  } catch {
    throw new Error(`the resume point at ${url} is not JSON`);
  }
}

/** The default probe: open the ref, close it, and never wait longer than the
 *  knock is worth. A connection that arrives after the deadline is closed
 *  rather than leaked — a redial loop running for the life of the page is what
 *  `openConnection` is careful to avoid, and abandoning one here would put it
 *  back. */
async function knock(ref: ConnectionRef): Promise<boolean> {
  // Closed either way, and closed even when the race has already been lost:
  // that is the leak this shape exists to prevent.
  const opening = openConnection(ref, {})
    .then((connection) => {
      connection.close();
      return true;
    })
    .catch(() => false);

  return Promise.race([
    opening,
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}
