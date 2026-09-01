// Turning "who is here" plus "who the host put where" into a list of empires.
//
// Kept apart from both the panel that renders it and the lobby that seals it,
// because it is the one part of team-picking that is neither DOM nor network:
// a compaction and a validation, and both are worth being sure about.

import type { MemberKey } from "@tessera/protocol";

export interface Seated {
  key: MemberKey;
}

export interface Composition {
  /** The empire index each player ended up on, parallel to the input. */
  teamOf: number[];
  /** Member keys per empire, in seat order. */
  empires: MemberKey[][];
}

/** Read an assignment back as empires, compacting the numbers as it goes.
 *
 *  Compaction is what keeps the picker honest. A host who puts everyone on
 *  empire 3 and leaves 0, 1 and 2 empty has made one empire, not four, and the
 *  colour beside a player's name has to be the colour they will actually play.
 *  Empires come out in the order they were first claimed, so the host's own
 *  empire is first whenever the host is listed first.
 *
 *  A player with no entry in `wanted` gets an empire of their own — the default
 *  before anybody touches anything, and the only sensible reading of silence. */
export function composeTeams(
  players: readonly Seated[],
  wanted: ReadonlyMap<MemberKey, number>,
): Composition {
  const claimed: number[] = [];
  const empires: MemberKey[][] = [];
  const teamOf: number[] = [];

  players.forEach((player, index) => {
    const asked = wanted.get(player.key) ?? index;
    let at = claimed.indexOf(asked);
    if (at < 0) {
      at = claimed.length;
      claimed.push(asked);
      empires.push([]);
    }
    empires[at]!.push(player.key);
    teamOf.push(at);
  });

  return { teamOf, empires };
}

export interface Plan {
  empires: MemberKey[][];
  simbots: number;
  /** Bot seats to add to each empire, parallel to `empires`. A bot seat is a
   *  full member with its own keypair, not a mode the empire is in: it accrues,
   *  it signs, and it can be left holding the line overnight. */
  bots?: number[];
}

/** Bot seats one empire may hold. Enough for a team to cover a night shift,
 *  few enough that "add bots" is not a way to out-populate everyone else. */
export const MAX_BOTS_PER_EMPIRE = 3;

/** Why this plan cannot be played, or "" if it can.
 *
 *  Checked before the genesis record is sealed rather than after. inspectGenesis
 *  would catch a duplicate key too, but by then the record is broadcast and the
 *  host — the only person who can still fix it — has already told everyone. */
export function checkPlan(plan: Plan, expected: Iterable<MemberKey>): string {
  const seated = plan.empires.flat();
  if (seated.length === 0) return "nobody is seated";
  if (new Set(seated).size !== seated.length) return "somebody is seated twice";
  if (plan.empires.some((keys) => keys.length === 0)) return "an empire has no members";

  const waiting = new Set(expected);
  for (const key of seated) if (!waiting.delete(key)) return "a stranger is seated";
  if (waiting.size > 0) return "somebody here has no seat";

  const bots = plan.bots ?? [];
  if (bots.length > plan.empires.length) return "a bot is seated in no empire";
  if (bots.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_BOTS_PER_EMPIRE)) {
    return `an empire may hold up to ${MAX_BOTS_PER_EMPIRE} bot seats`;
  }
  // Empire and member ids ride in single bytes of every signed move.
  if (plan.empires.some((keys, e) => keys.length + (bots[e] ?? 0) > 255)) {
    return "an empire has too many seats";
  }

  // One empire is last-empire-standing on the first step: a game nobody plays.
  if (plan.empires.length + plan.simbots < 2) return "a game needs at least two empires";
  return "";
}
