// The genesis record is the root of trust, and its hash is the game id.
//
// Two peers must derive byte-identical bytes from the same record or they
// derive different game ids and never meet — so serialisation is canonical
// (keys sorted, no whitespace) rather than whatever JSON.stringify felt like
// given the insertion order of the object it was handed.

import { PROTOCOL_VERSION } from "@tessera/sim";
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
  | "seats";

/** Everything a peer checks before it agrees to play. Returns the problems it
 *  found; empty means the record is one this build can join.
 *
 *  The protocol check is the important one: a peer that joins across a major
 *  boundary does not fail, it desyncs quietly three hours in. */
export async function inspectGenesis(genesis: Genesis): Promise<GenesisProblem[]> {
  const problems: GenesisProblem[] = [];

  if (genesis.protocol !== PROTOCOL_VERSION) problems.push("protocol");

  if (genesis.gameId !== undefined && genesis.gameId !== (await gameIdOf(genesis))) {
    problems.push("gameId");
  }

  if (!Array.isArray(genesis.empires) || genesis.empires.length < 1) {
    problems.push("empires");
    return problems;
  }
  // Empire and member ids ride in single bytes of every signed move, and empire
  // 0 means neutral, so the roster has to fit 1..255.
  if (genesis.empires.length > 255) problems.push("empires");

  const seen = new Set<string>();
  for (const empire of genesis.empires) {
    if (!Array.isArray(empire.members) || empire.members.length < 1) {
      problems.push("members");
      continue;
    }
    if (empire.members.length > 255) problems.push("seats");
    for (const member of empire.members) {
      if (!member.key) continue; // an unkeyed seat is a SimBot's, and needs none
      if (seen.has(member.key)) problems.push("duplicate-key");
      seen.add(member.key);
    }
  }

  return [...new Set(problems)];
}
