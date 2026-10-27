// The genesis record is the root of trust, and its hash is the game id.
//
// Two peers must derive byte-identical bytes from the same record or they
// derive different game ids and never meet — so serialisation is canonical
// (keys sorted, no whitespace) rather than whatever JSON.stringify felt like
// given the insertion order of the object it was handed.

import {
  CONTROL,
  DEFAULT_RULES,
  MAX_EMPIRES,
  bannerById,
  MIN_ABANDON_WINDOW,
  SEAT_CEILING,
  playsProtocol,
} from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { toHex, utf8 } from "./bytes.js";
import { sha256 } from "./identity.js";

/** Deterministic JSON: object keys in code-unit order, arrays in place,
 *  undefined dropped. Numbers use JS's own shortest round-trip form, which the
 *  language specifies exactly, so every engine agrees. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in a canonical record");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`cannot canonicalise ${typeof value}`);
}

/** SHA-256 over the record with its own gameId removed — a hash cannot contain
 *  itself, and a peer must be able to recompute the id from what it received. */
export async function gameIdOf(genesis: Genesis): Promise<string> {
  const { gameId: _ignored, ...rest } = genesis;
  return toHex(await sha256(utf8(canonicalJson(rest))));
}

/** Stamp the id onto a copy. The result is what peers exchange and what every
 *  signature is bound to. */
export async function sealGenesis(genesis: Genesis): Promise<Genesis> {
  return { ...genesis, gameId: await gameIdOf(genesis) };
}

export type GenesisProblem =
  | "protocol"
  | "gameId"
  | "empires"
  | "members"
  | "duplicate-key"
  | "seats"
  | "rules"
  | "duplicate-banner";

/** Everything a peer checks before it agrees to play. Returns the problems it
 *  found; empty means the record is one this build can join.
 *
 *  The protocol check is the important one: a peer that joins a game whose
 *  rules it does not have does not fail, it desyncs quietly three hours in.
 *  The set is what keeps a game alive across the release that supersedes it —
 *  widened to every version this build plays, not narrowed to the one it
 *  composes. */
export async function inspectGenesis(genesis: Genesis): Promise<GenesisProblem[]> {
  const problems: GenesisProblem[] = [];

  if (!playsProtocol(genesis.protocol)) problems.push("protocol");

  if (genesis.gameId !== undefined && genesis.gameId !== (await gameIdOf(genesis))) {
    problems.push("gameId");
  }

  if (!Array.isArray(genesis.empires) || genesis.empires.length < 1) {
    problems.push("empires");
    return problems;
  }
  // Empire ids ride in single bytes of every signed move, and empire 0 means
  // neutral — but the binding constraint is narrower than that and this check
  // used to advertise the wrong one.
  //
  // `state.owner` is an `Int8Array`, so an id above 127 stores as a negative
  // number the moment it is written, and **that is a simulation bug rather than
  // a repaint**: every `owner > 0` test then reads the tile as neutral, so the
  // empire's territory is unowned to combat, upkeep, cascades and claiming;
  // `setOwner`'s decrement is skipped on the next write so `tilesOwned` only
  // ever grows; and `isProtected` and `checkVictory` both read that fictitious
  // count. `state.winner` is `i8` too, so such an empire cannot even be recorded
  // as having won.
  //
  // The real fix is widening the layer, which moves `LAYOUT_VERSION` and is its
  // own plan. This is the free half: refuse the record rather than let a game
  // reach the state where its rules and its board disagree inside one peer.
  if (genesis.empires.length > 127) problems.push("empires");

  // And a cap that bites long before that one: a game with more empires than
  // there are banners has empires nothing can draw distinguishably. Refused at
  // composition rather than rendered wrong — which is what the old modulo did,
  // silently, and on the main board it rendered them as nothing at all.
  if (genesis.empires.length > MAX_EMPIRES) problems.push("empires");

  // Two empires wearing one flag is an unreadable board. Checked here as well
  // as in `checkPlan`, for the same reason the seat cap is: a genesis record is
  // the one place a game can be born malformed.
  //
  // `null` is refused along with a duplicate, and deliberately: `canonicalJson`
  // drops `undefined` and keeps `null`, so a record spelling an absent banner
  // as `null` would hash differently from one that omits it while meaning
  // exactly the same thing.
  const flown = new Set<string>();
  for (const empire of genesis.empires) {
    const banner = (empire as { banner?: unknown }).banner;
    if (banner === undefined) continue;
    if (typeof banner !== "string" || !bannerById(banner) || flown.has(banner)) {
      problems.push("duplicate-banner");
      continue;
    }
    flown.add(banner);
  }

  // The abandonment window is the one rule a host could set to win outright: a
  // short enough window makes every opponent "absent" the first time it is the
  // only empire to have moved inside a second, and victory.ts hands it
  // WIN.LAST_ROSTER before anyone has played. Every peer would verify that
  // record and accept it, because nothing else here reads a single number in
  // `rules`. Checked here because the seat cap taught the lesson — a genesis
  // record is the one place a rule can be born unfair.
  //
  // Unconditional on version, and that is safe: no record that exists violates
  // it, and the worst a disagreement between two builds can produce is a peer
  // declining to join. A new check in inspectGenesis is safe across versions;
  // a new branch in validate() is not.
  const rules = genesis.rules ?? DEFAULT_RULES;
  if ((rules.abandonWindow ?? DEFAULT_RULES.abandonWindow) < MIN_ABANDON_WINDOW) {
    problems.push("rules");
  }
  // Negative windows are nonsense rather than unfair, and cheaper to refuse
  // than to reason about downstream.
  if ((rules.joinWindow ?? 0) < 0 || (rules.endStep ?? 0) < 0) problems.push("rules");

  // The seat cap is checked here as well as on every amendment, because a
  // genesis record is the one place an empire could be born oversized — and a
  // peer that only checked amendments would join the unfair game and then
  // faithfully enforce fairness for the rest of it.
  //
  // The floor and the ceiling now say different things. The ceiling is fairness:
  // no empire may be composed with more seats than every other empire is
  // allowed. The floor is no longer "at least one" — an empire with no seats is
  // a vacancy, which is a thing a record may legitimately contain — so what is
  // left of the floor is the two refusals below: not for a SimBot empire, and
  // not for every empire in the game.
  const seats = Math.min(rules.maxSeats ?? DEFAULT_RULES.maxSeats, SEAT_CEILING);

  const seen = new Set<string>();
  let claimed = 0;
  for (const empire of genesis.empires) {
    if (!Array.isArray(empire.members)) {
      problems.push("members");
      continue;
    }
    // A vacancy: an empire the map generator will place and nobody has claimed.
    // Territory rather than a player, and a legal thing for a record to contain
    // — but only for a human empire, because a SimBot empire with no seats is
    // an empire nothing will ever play, and only alongside at least one empire
    // that does have members, because a record of nothing but vacancies is a
    // game with no players in it.
    //
    // Deliberately encoded as the empty array and nothing else. That is already
    // an error to every build written before this one, so an old peer handed a
    // vacancies record *declines* rather than desyncing — which is the exact
    // outcome a protocol bump exists to produce, and why this change does not
    // need one. A flag in `rules` or a sentinel key would be read straight past
    // by that same peer, and the disagreement would surface three hours in.
    if (empire.members.length < 1) {
      if ((empire.control ?? CONTROL.HUMAN) !== CONTROL.HUMAN) problems.push("members");
      continue;
    }
    claimed++;
    if (empire.members.length > seats) problems.push("seats");
    for (const member of empire.members) {
      if (!member.key) continue; // an unkeyed seat is a SimBot's, and needs none
      if (seen.has(member.key)) problems.push("duplicate-key");
      seen.add(member.key);
    }
  }

  // Somebody has to be playing. A record of nothing but vacancies would pass
  // every check above and then end on the first victory pass with no winner.
  if (claimed < 1) problems.push("members");


  return [...new Set(problems)];
}
