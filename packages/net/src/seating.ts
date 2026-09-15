// The one order seats appear in, live and on replay.
//
// Two records can put a member into an empire: an amendment, which a quorum of
// that empire's existing seats endorsed, and a claim, which somebody signed for
// themselves because the empire had no seats to ask. They verify by completely
// different rules and they produce the same move, and *that* is the thing this
// file exists to keep straight.
//
// Why it has to be one merged order rather than two arrays each in its own:
// `roster.amend` assigns member indices by appending. If the live driver and
// `verifyArchive` disagree about whether the claim or the amendment landed first
// on a step, they assign different indices to the same keys, and from there
// every move that seat signed fails `keyOf` attribution — reported, eventually,
// as a hash mismatch, which is about the least useful description of that bug
// available. So the comparator is written once and both sides call it.

import { MEMBER } from "@tessera/sim";
import type { MemberKind, Move } from "@tessera/sim";
import { amendmentMove, claimMove } from "@tessera/protocol";
import type { MemberKey, SignedAmendment, SignedClaim } from "@tessera/protocol";

/** A record that seats somebody. */
export type Seating = SignedAmendment | SignedClaim;

export function isClaim(record: Seating): record is SignedClaim {
  return "claim" in record;
}

/** The three fields both kinds carry, plus the kind of seat it creates. A
 *  claimant is always HUMAN: a bot claiming a vacancy is a bot playing a seat
 *  nobody chose to give it. */
export function seatingOf(record: Seating): {
  empire: number;
  key: MemberKey;
  step: number;
  kind: MemberKind;
} {
  if (isClaim(record)) {
    const { empire, key, step } = record.claim;
    return { empire, key, step, kind: MEMBER.HUMAN };
  }
  const { empire, key, step, kind } = record.amendment;
  return { empire, key, step, kind };
}

/** Step first, because a seating is booked onto a step; key within a step,
 *  because that is the only field two records landing together are guaranteed to
 *  differ on — the same reason `seatArrivals` has always sorted by it.
 *
 *  Total and identical on every machine, which is the whole requirement. */
export function seatingOrder(a: Seating, b: Seating): number {
  const left = seatingOf(a);
  const right = seatingOf(b);
  if (left.step !== right.step) return left.step - right.step;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** Every seating in a game, in that order. Used by the archive verifier, which
 *  holds the two kinds in two arrays and has to rebuild the single sequence the
 *  driver applied. */
export function mergeSeatings(
  amendments: readonly SignedAmendment[] = [],
  claims: readonly SignedClaim[] = [],
): Seating[] {
  return [...amendments, ...claims].sort(seatingOrder);
}

/** The simulation move a seating produces. To the simulation the two are the
 *  same event — append a member to an empire — and that is deliberate: the sim
 *  addresses members by index and knows nothing about keys, so it has no way to
 *  hold an authorisation concept and no business holding one. */
export function seatingMove(record: Seating, seq: number): Move {
  return isClaim(record) ? claimMove(record.claim, seq) : amendmentMove(record.amendment, seq, 0);
}
