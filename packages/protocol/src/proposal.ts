// Composing a game together: the world everybody signs, and the record it
// composes into.
//
// Every phase of Tessera except one is a signed record verified by whoever
// reads it. The exception was composition: one peer read its own UI state,
// sealed a genesis and broadcast it, and everybody else's only available
// response was refusal. This file removes the exception. It does not add a
// vote — a vote binds the outvoted, and nothing here has ever bound a key that
// did not sign.
//
// **The signed object is the world, and it names nobody.** That inversion is
// the whole design. Signing the plan — members and all — deadlocks: every
// arrival changes the member list, which changes the hash, which voids every
// signature already collected, and in a room where people drift in over an
// hour settling is precisely what attracts the next joiner. So the roster is
// *derived from who signed*, a new player consenting invalidates nothing, and
// the negotiation can run asynchronously across a whole join window.

import {
  CONTROL,
  DEFAULT_MAP,
  DEFAULT_RULES,
  MEMBER,
  PROTOCOL_VERSION,
  makeGenesis,
  simbot,
} from "@tessera/sim";
import type { BotProfile, EmpireSpec, Genesis, MapConfig, Rules } from "@tessera/sim";
import { toHex, utf8 } from "./bytes.js";
import { canonicalJson } from "./genesis.js";
import { sha256 } from "./identity.js";
import { verifyConsent } from "./records.js";
import type { SignedConsent } from "./records.js";

/** A world, with nobody in it.
 *
 *  Three fields carry a resolution rule rather than a value, and each of them
 *  is load-bearing:
 *
 *  **`map` and `rules` are fully resolved before hashing.** `makeGenesis`
 *  merges `DEFAULT_MAP` and `DEFAULT_RULES`, so a proposal carrying
 *  `{width, height}` produces a genesis carrying nine map fields and
 *  `proposalOf` could not know which two were signed. Resolving first makes
 *  that merge a no-op on this path, and closes a hole the old design never had
 *  to think about: two builds with different defaults would otherwise derive
 *  different worlds from one signed object.
 *
 *  **`simbots` holds resolved profiles, never preset names.** Same argument,
 *  and it is the one the body of the plan missed: `simbot("hard")` resolves to
 *  `DIFFICULTY.hard` on its way into the record, so a genesis shows a profile
 *  and never the word that produced it. A proposal naming `"hard"` would be
 *  unrecoverable and every consent over it would fail. Callers resolve with
 *  `DIFFICULTY[level]` before proposing.
 *
 *  **`protocol` is part of the world.** Which rule set a game runs under is
 *  exactly the kind of thing a signature should cover, and recomposition needs
 *  it anyway: stamping `PROTOCOL_VERSION` would make a record composed under
 *  one version unverifiable by the next, which is the opposite of what 0001's
 *  supported set exists to do. */
export interface Proposal {
  protocol: number;
  seed: number;
  /** A future wall-clock instant. Every peer derives its step number from this,
   *  so an agreed start time means everyone begins on the same step rather than
   *  whenever their GENESIS frame happened to land — and the deadline for
   *  consenting becomes a fact of the record instead of a convention in a UI. */
  startedAt: number;
  map: MapConfig;
  rules: Rules;
  /** One entry per SimBot empire. Resolved profiles; see above. */
  simbots: readonly BotProfile[];
  /** Empires the map places with nobody in them, for somebody to arrive into
   *  once the game is running (0010). */
  vacancies: number;
}

/** The hash a consent signs.
 *
 *  `canonicalJson` is the same function `gameIdOf` uses, for the same reason:
 *  two peers must derive byte-identical bytes or they derive different ids and
 *  never meet. It throws on a non-finite number, and a proposal now arrives
 *  from strangers — so every caller hashing an untrusted object wraps this and
 *  reads a throw as a refusal. */
export async function proposalId(proposal: Proposal): Promise<string> {
  return toHex(await sha256(utf8(canonicalJson(proposal))));
}

/** Resolve a partial world into one that can be hashed. The proposer's half of
 *  the resolution rule above, in one place so that three composers cannot each
 *  get it subtly differently. */
export function proposalFrom(init: {
  seed: number;
  startedAt: number;
  map?: Partial<MapConfig>;
  rules?: Partial<Rules>;
  simbots?: readonly BotProfile[];
  vacancies?: number;
  protocol?: number;
}): Proposal {
  return {
    protocol: init.protocol ?? PROTOCOL_VERSION,
    seed: init.seed >>> 0,
    startedAt: init.startedAt,
    map: { ...DEFAULT_MAP, ...init.map },
    rules: { ...DEFAULT_RULES, ...init.rules },
    simbots: [...(init.simbots ?? [])],
    vacancies: init.vacancies ?? 0,
  };
}

/** Consents in the order the composition uses them.
 *
 *  Key order is not tidiness — it is the map. `placeCapitals` positions
 *  capitals by empire index from the shared seed, so whoever decides the order
 *  of this list decides whose capital lands where. Leaving that to the sealer
 *  would quietly hand the doorman a larger power than "deciding who was late",
 *  and it is not in the table that argues sealing is clerical. Sorting removes
 *  it, costs nothing, and matches what `seatArrivals` already does for the same
 *  reason.
 *
 *  Duplicates are dropped rather than refused: two copies of one signature are
 *  one person who consented, and a sealer collecting from several peers will
 *  genuinely see both. */
export function orderConsents(consents: readonly SignedConsent[]): SignedConsent[] {
  const byKey = new Map<string, SignedConsent>();
  for (const one of consents) if (!byKey.has(one.key)) byKey.set(one.key, one);
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The world plus who signed it, composed into the record they will play.
 *
 *  The composition order is part of the format, not a convenience: **signers in
 *  key order, then vacancies, then SimBots.** `proposalOf` is only able to
 *  recover `simbots` and `vacancies` from `empires` because the layout is
 *  fixed, and every consent in existence depends on that recovery.
 *
 *  One signer, one empire. Teams before step 0 are deliberately not here: a
 *  signer choosing an empire is a signer who must re-sign when somebody else
 *  takes it, which is the never-settling proposal in miniature. A team forms
 *  after step 0 by ROSTER_AMEND, which is the mechanism that already exists. */
export function composeGenesis(
  proposal: Proposal,
  consents: readonly SignedConsent[],
): Genesis {
  const signers = orderConsents(consents);
  const empires: EmpireSpec[] = signers.map((one) => ({
    control: CONTROL.HUMAN,
    members: [{ kind: MEMBER.HUMAN, key: one.key }],
  }));
  for (let i = 0; i < proposal.vacancies; i++) {
    empires.push({ control: CONTROL.HUMAN, members: [] });
  }
  for (const profile of proposal.simbots) empires.push(simbot(profile));

  return {
    ...makeGenesis({
      seed: proposal.seed,
      startedAt: proposal.startedAt,
      map: proposal.map,
      rules: proposal.rules,
      empires,
    }),
    // `makeGenesis` stamps the version this build composes. A record composed
    // under an earlier one must still recompose to itself, or every consent in
    // it stops verifying the day the number moves.
    protocol: proposal.protocol,
    consent: signers,
  };
}

/** The inverse. `undefined` for a record this function did not produce.
 *
 *  Exact rather than lenient, deliberately: everything it declines to recover
 *  is a record whose consents will not verify, and a lenient inverse would turn
 *  "this is not a composed game" into "these signatures are wrong". */
export function proposalOf(genesis: Genesis): Proposal | undefined {
  if (!genesis || !Array.isArray(genesis.empires)) return undefined;
  if (typeof genesis.seed !== "number" || typeof genesis.startedAt !== "number") return undefined;
  if (!genesis.map || !genesis.rules) return undefined;

  let at = 0;
  // Signers: one keyed human seat each, in key order. The order is checked
  // rather than assumed — a record whose roster was reshuffled recomposes to a
  // different map, and that is exactly the tamper this catches.
  let last: string | undefined;
  while (at < genesis.empires.length) {
    const empire = genesis.empires[at]!;
    if ((empire.control ?? CONTROL.HUMAN) !== CONTROL.HUMAN) break;
    if (!Array.isArray(empire.members) || empire.members.length !== 1) break;
    const member = empire.members[0]!;
    if ((member.kind ?? MEMBER.HUMAN) !== MEMBER.HUMAN || !member.key || member.bot) break;
    if (last !== undefined && !(last < member.key)) return undefined;
    last = member.key;
    at++;
  }

  let vacancies = 0;
  while (at < genesis.empires.length) {
    const empire = genesis.empires[at]!;
    if ((empire.control ?? CONTROL.HUMAN) !== CONTROL.HUMAN) break;
    if (!Array.isArray(empire.members) || empire.members.length !== 0) break;
    vacancies++;
    at++;
  }

  const simbots: BotProfile[] = [];
  while (at < genesis.empires.length) {
    const empire = genesis.empires[at]!;
    if (empire.control !== CONTROL.SIMBOT) return undefined;
    if (!Array.isArray(empire.members) || empire.members.length !== 1) return undefined;
    const member = empire.members[0]!;
    if (!member.bot) return undefined;
    simbots.push(member.bot);
    at++;
  }

  return {
    protocol: genesis.protocol,
    seed: genesis.seed,
    startedAt: genesis.startedAt,
    map: genesis.map,
    rules: genesis.rules,
    simbots,
    vacancies,
  };
}

/** What a reader can say about a record's consent list.
 *
 *  Three outcomes rather than two, and the distinction is the answer to the one
 *  real objection against shipping this without a protocol bump: an unverified
 *  consent list is worse than none, because it looks like proof. A verdict that
 *  separates *checked* from *absent* from *failed* cannot be mistaken for one. */
export type ConsentState = "checked" | "absent" | "failed";

export interface ConsentVerdict {
  state: ConsentState;
  /** How many keyed seats the record has, and how many of them signed this
   *  world. Equal on a `checked` record, by construction. */
  signed: number;
  seats: number;
}

/** Whether every signature in a record's consent list covers the world that
 *  record actually composes.
 *
 *  Verification is a **recomposition**, not a field-by-field audit, and the
 *  plan's original sketch — strip `gameId` and `consent`, rehash the residue —
 *  could not have worked: what remains still contains `empires`, which is
 *  derived from the consent set and is exactly the field the proposal was
 *  designed not to contain. Hashing the residue hashes the roster, and the
 *  deadlock the world/roster split exists to avoid comes back in the verifier
 *  instead of the proposer.
 *
 *  So the proposal is reconstructed, the whole record is rebuilt from it, and
 *  the two are compared. That single comparison subsumes the entire table of
 *  things a sealer must not be able to do: a changed rule, a seated non-signer,
 *  an invented player, a reordered roster, a quietly swapped bot profile, an
 *  extra vacancy — every one of them either fails a signature or fails the
 *  rebuild, and none of them needs its own branch. It is the discipline
 *  `SnapshotFrame` already uses: restore it, hash it, discard it if the number
 *  disagrees. */
export async function checkConsent(genesis: Genesis): Promise<ConsentVerdict> {
  const seats = keyedSeats(genesis);
  const consents = genesis.consent;
  // A record that claims nothing fails nothing. Every archive, fixture and test
  // that predates this file is in this branch, which is what keeps them green.
  if (consents === undefined) return { state: "absent", signed: 0, seats };
  const failed: ConsentVerdict = { state: "failed", signed: 0, seats };

  if (!Array.isArray(consents) || consents.length === 0) return failed;

  const proposal = proposalOf(genesis);
  if (!proposal) return failed;

  let id: string;
  try {
    id = await proposalId(proposal);
  } catch {
    // A non-finite number somewhere in the world. Unhashable is unsignable, so
    // nothing could have consented to it.
    return failed;
  }
  for (const one of consents) if (!(await verifyConsent(one, id))) return failed;

  let rebuilt: string;
  try {
    const { gameId: _stamp, ...rest } = genesis;
    rebuilt = canonicalJson(composeGenesis(proposal, consents));
    if (canonicalJson(rest) !== rebuilt) return failed;
  } catch {
    return failed;
  }

  return { state: "checked", signed: consents.length, seats };
}

/** Seats a record holds that belong to a key — which is to say, the seats a
 *  consent could be owed for. A SimBot seat has no key and is nobody's to
 *  agree to. */
function keyedSeats(genesis: Genesis): number {
  if (!Array.isArray(genesis?.empires)) return 0;
  let seats = 0;
  for (const empire of genesis.empires) {
    if (!Array.isArray(empire?.members)) continue;
    for (const member of empire.members) if (member?.key) seats++;
  }
  return seats;
}
