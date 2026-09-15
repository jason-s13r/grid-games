// A state a stranger can check.
//
// `adopt()` proves a snapshot is internally consistent — its bytes hash to the
// number it claims. That is a content address and not a proof: the hash is FNV-1a
// over the snapshot, 32 bits, and multiplication by the prime is invertible mod
// 2^32, so bytes with any chosen hash take milliseconds to produce rather than a
// search. `restore()` checks a magic number and a layout version and reads every
// other field raw, so a handful of free bytes anywhere in a stat slot is enough
// to aim it.
//
// In a live mesh that costs one checkpoint interval: a peer that adopted a forged
// state disagrees with everybody's signed checkpoints within five seconds and
// rebuilds. It costs the whole game when there is nobody left to disagree — a
// game everyone left on Tuesday, restarted on Thursday from whatever was kept.
//
// So this file replaces "these bytes hash to this number" with "a majority of
// this game's seats signed that this step had this hash". The signatures were
// already being broadcast — CHECKPOINT, every five seconds, by every seat — and
// all that was missing was keeping the envelopes and putting them in the same
// parcel as the bytes.
//
// It is a **cold-start artifact** and the scope is deliberate. A live peer
// answers a snapshot request from *now*, which is almost never a snapshot step
// and therefore has no witnesses; answering from a stored step instead would mean
// shipping the moves between then and now, and the driver deletes each step's
// moves as it applies them. For a latecomer to a running game, the present state
// plus its re-sent pending moves is both the existing answer and the right one.

import { Roster, verifyAmendment, verifyCheckpoint, verifyDrop } from "@tessera/protocol";
import type { Genesis } from "@tessera/sim";
import type { SignedAmendment, SignedCheckpoint, SignedDrop } from "@tessera/protocol";

export interface ResumePoint {
  step: number;
  hash: number;
  /** base64url, exactly as the SNAPSHOT frame carries it. */
  data: string;
  amendments: SignedAmendment[];
  drops: SignedDrop[];
  /** (step, hash) signed by seats. The whole point of the file. */
  witnesses: SignedCheckpoint[];
}

/** A resume point with the bytes taken off.
 *
 *  `verifyResumePoint` never reads `data` — it rebuilds the roster, subtracts
 *  the verified drops and counts agreeing signatures — so the claim is the whole
 *  of its input, and saying so in the type is what lets an address book carry a
 *  proof of life in a couple of hundred bytes instead of a snapshot. The bytes
 *  answer a different question, and `Lockstep.resume` is the only thing that
 *  asks both. */
export type ResumeClaim = Omit<ResumePoint, "data">;

/** Reported rather than reduced to a boolean, because "endorsed by 2 of 4" is
 *  something a player should be shown before they commit to a state, and
 *  "endorsed by 2 of 4, one of whom is not in this game" is a different
 *  situation wearing the same number. */
export interface ResumeTally {
  ok: boolean;
  endorsed: number;
  needed: number;
  problems: string[];
}

const seatName = (seat: { empire: number; member: number }): string =>
  `${seat.empire}:${seat.member}`;

const isStep = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The roster as it stood at a resume point: the genesis, plus the amendments the
 *  point carries, each re-checked against the roster as it was when it was
 *  signed. In order, because an empire's quorum grows as it does — and stopping
 *  at the first that does not check out, since the records after it were endorsed
 *  against a roster this walk is no longer reproducing, so continuing would be
 *  guessing.
 *
 *  The driver's `catchUpRoster` does the same walk and also does driver work:
 *  adopting our own seat, firing `onSeated`, pushing to `applied`. So it cannot
 *  be called from here, and a test asserts the two agree instead — two
 *  implementations with a test that they match is cheaper and safer than
 *  refactoring the one piece of code that decides who may act. */
export async function rosterAt(
  genesis: Genesis,
  amendments: readonly SignedAmendment[],
): Promise<Roster> {
  const roster = Roster.fromGenesis(genesis);
  const gameId = genesis.gameId ?? "";
  for (const record of amendments) {
    if (roster.has(record.amendment.key)) continue;
    if (!(await verifyAmendment(roster, gameId, record))) break;
    const { empire, key, kind, step } = record.amendment;
    roster.amend(empire, key, kind, step);
  }
  return roster;
}

/** Whether a majority of the seats that could still sign asserted that this step
 *  had this hash.
 *
 *  It says **nothing** about the bytes in `data`. That is `adopt`'s question, and
 *  it is answered by restoring, hashing and rolling back. Both halves have to
 *  run, and they are separate functions because a client wants to show the tally
 *  before it commits to a state and a keeper wants to check a point it is only
 *  storing. `Lockstep.resume` is the only thing that runs both, in the only order
 *  that is safe.
 *
 *  It takes a `ResumeClaim` rather than a `ResumePoint` — a `ResumePoint` is one,
 *  so every existing caller is unchanged — because an address-book row carries
 *  the witnesses without the snapshot, and the question "is this game real" is
 *  answered by exactly this arithmetic over exactly those fields. */
export async function verifyResumePoint(
  genesis: Genesis,
  point: ResumeClaim,
): Promise<ResumeTally> {
  const problems: string[] = [];
  const none: ResumeTally = { ok: false, endorsed: 0, needed: 0, problems };
  if (!point || !Array.isArray(point.witnesses) || !isStep(point.step)) {
    problems.push("not a resume point");
    return none;
  }
  const gameId = genesis.gameId ?? "";
  if (!gameId) {
    problems.push("the genesis is unsealed, so nothing can be signed against it");
    return none;
  }

  const roster = await rosterAt(genesis, point.amendments ?? []);

  // Seats that were dropped cannot sign, and counting them in the electorate is
  // what would make a long game unresumable: three signatures needed from two
  // remaining players. Each drop is re-verified here, so a fabricated one cannot
  // shrink the electorate to a majority of one.
  const gone = new Set<string>();
  for (const record of point.drops ?? []) {
    if (!record?.drop || record.drop.atStep > point.step) continue;
    if (!(await verifyDrop(roster, gameId, record))) {
      problems.push(`a drop for ${seatName(record.drop)} lacks a quorum`);
      continue;
    }
    gone.add(seatName(record.drop));
  }

  const electorate = roster.all().filter((seat) => !gone.has(seatName(seat)));
  const needed = Math.floor(electorate.length / 2) + 1;
  if (electorate.length === 0) {
    problems.push("no seat is left to vouch for anything");
    return { ...none, needed };
  }

  const seated = new Set(electorate.map(seatName));
  const endorsed = new Set<string>();
  for (const signed of point.witnesses) {
    const checkpoint = signed?.checkpoint;
    if (!checkpoint) continue;
    // A witness for another step, or for a different state at this one, is not
    // evidence about these bytes. It is also not necessarily a forgery — a peer
    // that was desynced at this step signed honestly and was wrong.
    if (checkpoint.step !== point.step || checkpoint.hash !== point.hash) continue;
    const name = seatName(checkpoint);
    if (!seated.has(name) || endorsed.has(name)) continue;
    if (await verifyCheckpoint(roster, gameId, signed)) endorsed.add(name);
    else problems.push(`a witness from ${name} does not verify`);
  }

  if (endorsed.size < needed) {
    problems.push(`endorsed by ${endorsed.size} of ${electorate.length} seats`);
  }
  return { ok: endorsed.size >= needed, endorsed: endorsed.size, needed, problems };
}
