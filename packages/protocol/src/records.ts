// The signed records. Everything a peer can say that another peer must believe
// is defined here, and each has exactly one byte encoding.
//
// Three properties every record carries, and each is load-bearing:
//
//   * A domain tag, so a signature over a move can never be replayed as a
//     signature over a chat message.
//   * The game id, so a move signed in one game cannot be replayed into
//     another — including a game an attacker generated for the purpose.
//   * Fixed-width, little-endian, range-checked fields. A field wider than its
//     slot would truncate, and two different moves that encode to the same
//     bytes share a signature. Out of range is therefore rejected before the
//     encoder is ever reached, on both sides.

import { MOVE } from "@tessera/sim";
import type { MemberKind, Move, MoveType } from "@tessera/sim";
import { Writer, concat, utf8 } from "./bytes.js";
import { Identity, verify } from "./identity.js";
import type { MemberKey } from "./identity.js";
import type { Roster } from "./roster.js";

const TAG_MOVE = "tessera/move/1";
const TAG_MESSAGE = "tessera/message/1";
const TAG_CHECKPOINT = "tessera/checkpoint/1";
const TAG_AMENDMENT = "tessera/amendment/1";
const TAG_HELLO = "tessera/hello/1";
const TAG_READY = "tessera/ready/1";
const TAG_DROP = "tessera/drop/1";

export const NONCE_BYTES = 16;

const u8 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xff;
const u16 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffff;
const u32 = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function preamble(tag: string, gameId: string): Uint8Array {
  const id = utf8(gameId);
  if (!u16(id.length)) throw new Error("game id is absurd");
  const header = new Writer(2).u16(id.length).finish();
  return concat(utf8(tag), header, id);
}

// --- moves -------------------------------------------------------------------

export interface SignedMove {
  move: Move;
  /** Base64url, IEEE-P1363 r||s. Attribution comes from the roster seat named
   *  by (empire, member), never from a key carried alongside. */
  sig: string;
}

const MOVE_TYPES: ReadonlySet<number> = new Set(Object.values(MOVE));

export function moveInRange(move: Move): boolean {
  return (
    u32(move.step) &&
    u32(move.seq) &&
    u8(move.empire) &&
    move.empire >= 1 && // 0 is neutral; nobody signs as neutral
    u8(move.member) &&
    u8(move.type) &&
    MOVE_TYPES.has(move.type) &&
    u16(move.x) &&
    u16(move.y)
  );
}

export function encodeMove(gameId: string, move: Move): Uint8Array {
  if (!moveInRange(move)) throw new Error("move field out of range");
  const record = new Writer(16)
    .u32(move.step)
    .u32(move.seq)
    .u8(move.empire)
    .u8(move.member)
    .u8(move.type)
    .u8(0) // reserved, so the record stays 4-byte aligned if it ever grows
    .u16(move.x)
    .u16(move.y)
    .finish();
  return concat(preamble(TAG_MOVE, gameId), record);
}

export async function signMove(
  identity: Identity,
  gameId: string,
  move: Move,
): Promise<SignedMove> {
  return { move, sig: await identity.sign(encodeMove(gameId, move)) };
}

/** True only if the move is well formed, the seat exists, and the signature is
 *  that seat's. It says nothing about whether the *rules* allow the move —
 *  that is the simulation's job, and it runs identically on every peer. */
export async function verifyMove(
  roster: Roster,
  gameId: string,
  signed: SignedMove,
): Promise<boolean> {
  if (!signed || !signed.move || typeof signed.sig !== "string") return false;
  if (!moveInRange(signed.move)) return false;

  const key = roster.keyOf(signed.move.empire, signed.move.member);
  if (!key) return false;

  return verify(key, signed.sig, encodeMove(gameId, signed.move));
}

// --- chat --------------------------------------------------------------------

export const CHANNEL = { PUBLIC: 0, TEAM: 1 } as const;
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/** Ordered, signed and attributable — but never hashed into state. That is the
 *  whole reason chat is safe: a message that arrives late, out of order, or not
 *  at all cannot cause a desync. `body` is plaintext on PUBLIC and base64url
 *  AES-GCM ciphertext on TEAM. */
export interface Message {
  step: number;
  seq: number;
  empire: number;
  member: number;
  channel: Channel;
  body: string;
}

export interface SignedMessage {
  message: Message;
  sig: string;
}

export function messageInRange(message: Message): boolean {
  return (
    u32(message.step) &&
    u32(message.seq) &&
    u8(message.empire) &&
    message.empire >= 1 &&
    u8(message.member) &&
    u8(message.channel) &&
    typeof message.body === "string" &&
    message.body.length <= 2048
  );
}

export function encodeMessage(gameId: string, message: Message): Uint8Array {
  if (!messageInRange(message)) throw new Error("message field out of range");
  const body = utf8(message.body);
  // Length-prefixed, so a body ending in bytes that look like a field cannot be
  // reinterpreted as one.
  const record = new Writer(16 + body.length)
    .u32(message.step)
    .u32(message.seq)
    .u8(message.empire)
    .u8(message.member)
    .u8(message.channel)
    .u8(0)
    .u32(body.length)
    .raw(body)
    .finish();
  return concat(preamble(TAG_MESSAGE, gameId), record);
}

export async function signMessage(
  identity: Identity,
  gameId: string,
  message: Message,
): Promise<SignedMessage> {
  return { message, sig: await identity.sign(encodeMessage(gameId, message)) };
}

export async function verifyMessage(
  roster: Roster,
  gameId: string,
  signed: SignedMessage,
): Promise<boolean> {
  if (!signed || !signed.message || typeof signed.sig !== "string") return false;
  if (!messageInRange(signed.message)) return false;

  const key = roster.keyOf(signed.message.empire, signed.message.member);
  if (!key) return false;

  return verify(key, signed.sig, encodeMessage(gameId, signed.message));
}

// --- checkpoints -------------------------------------------------------------

/** "At step S my state hashed to H." Signed, because an unsigned hash claim
 *  lets any peer accuse any other of desyncing. */
export interface Checkpoint {
  step: number;
  hash: number;
  empire: number;
  member: number;
}

export interface SignedCheckpoint {
  checkpoint: Checkpoint;
  sig: string;
}

export function encodeCheckpoint(gameId: string, checkpoint: Checkpoint): Uint8Array {
  if (
    !u32(checkpoint.step) ||
    !u32(checkpoint.hash) ||
    !u8(checkpoint.empire) ||
    !u8(checkpoint.member)
  ) {
    throw new Error("checkpoint field out of range");
  }
  const record = new Writer(12)
    .u32(checkpoint.step)
    .u32(checkpoint.hash)
    .u8(checkpoint.empire)
    .u8(checkpoint.member)
    .u16(0)
    .finish();
  return concat(preamble(TAG_CHECKPOINT, gameId), record);
}

export async function signCheckpoint(
  identity: Identity,
  gameId: string,
  checkpoint: Checkpoint,
): Promise<SignedCheckpoint> {
  return { checkpoint, sig: await identity.sign(encodeCheckpoint(gameId, checkpoint)) };
}

export async function verifyCheckpoint(
  roster: Roster,
  gameId: string,
  signed: SignedCheckpoint,
): Promise<boolean> {
  if (!signed || !signed.checkpoint || typeof signed.sig !== "string") return false;
  const key = roster.keyOf(signed.checkpoint.empire, signed.checkpoint.member);
  if (!key) return false;
  try {
    return await verify(key, signed.sig, encodeCheckpoint(gameId, signed.checkpoint));
  } catch {
    return false;
  }
}


// --- readiness ---------------------------------------------------------------

/** "I have submitted every move I will ever submit for a step at or before
 *  `upTo`." This is what lets the lockstep pipeline advance without a PASS
 *  message per seat per step: one cumulative assertion replaces twelve a
 *  second.
 *
 *  It is signed for the same reason a checkpoint is. An unsigned readiness
 *  claim would let any peer assert on another's behalf that it has nothing
 *  more to say, and every peer would then advance past a step whose real input
 *  had not arrived — a desync manufactured by a third party. Signed, asserting
 *  readiness through `upTo` and then submitting a move at or before it is
 *  equivocation, provable against the signer. */
export interface Ready {
  upTo: number;
  empire: number;
  member: number;
}

export interface SignedReady {
  ready: Ready;
  sig: string;
}

export function encodeReady(gameId: string, ready: Ready): Uint8Array {
  if (!u32(ready.upTo) || !u8(ready.empire) || ready.empire < 1 || !u8(ready.member)) {
    throw new Error("ready field out of range");
  }
  const record = new Writer(8).u32(ready.upTo).u8(ready.empire).u8(ready.member).u16(0).finish();
  return concat(preamble(TAG_READY, gameId), record);
}

export async function signReady(
  identity: Identity,
  gameId: string,
  ready: Ready,
): Promise<SignedReady> {
  return { ready, sig: await identity.sign(encodeReady(gameId, ready)) };
}

export async function verifyReady(
  roster: Roster,
  gameId: string,
  signed: SignedReady,
): Promise<boolean> {
  if (!signed?.ready || typeof signed.sig !== "string") return false;
  const key = roster.keyOf(signed.ready.empire, signed.ready.member);
  if (!key) return false;
  try {
    return await verify(key, signed.sig, encodeReady(gameId, signed.ready));
  } catch {
    return false;
  }
}


// --- dropping a stalled seat -------------------------------------------------

/** A peer that stops answering freezes the game, and the fix cannot be a local
 *  timeout: two peers whose stopwatches disagree would stop waiting on
 *  different steps and diverge on the spot. So dropping is a decision, taken by
 *  a quorum, over one exact record.
 *
 *  `atStep` is inside the record, not inferred by the receiver. Everyone who
 *  accepts this record stops waiting for the seat on precisely that step,
 *  whether they learned about it a second or a minute after it was proposed.
 *
 *  A seat may be endorsed for exactly one drop record ever. Two records naming
 *  different steps therefore cannot both reach a majority, which is what stops
 *  a race between two proposals from splitting the mesh. */
export interface Drop {
  empire: number;
  member: number;
  atStep: number;
}

export interface SignedDrop {
  drop: Drop;
  /** Endorsers come from any empire: a stall costs everyone, not just the
   *  stalled seat's teammates. */
  signatures: Array<{ empire: number; member: number; sig: string }>;
}

export function encodeDrop(gameId: string, drop: Drop): Uint8Array {
  if (!u8(drop.empire) || drop.empire < 1 || !u8(drop.member) || !u32(drop.atStep)) {
    throw new Error("drop field out of range");
  }
  const record = new Writer(8).u32(drop.atStep).u8(drop.empire).u8(drop.member).u16(0).finish();
  return concat(preamble(TAG_DROP, gameId), record);
}

export async function endorseDrop(
  identity: Identity,
  gameId: string,
  drop: Drop,
  by: { empire: number; member: number },
): Promise<{ empire: number; member: number; sig: string }> {
  return { ...by, sig: await identity.sign(encodeDrop(gameId, drop)) };
}

/** Merge what two peers have each collected. Endorsements are a set, so
 *  gossiping partial tallies converges without anyone coordinating. */
export function mergeDrop(a: SignedDrop, b: SignedDrop): SignedDrop {
  const seen = new Map<string, { empire: number; member: number; sig: string }>();
  for (const signature of [...a.signatures, ...b.signatures]) {
    seen.set(`${signature.empire}:${signature.member}`, signature);
  }
  return { drop: a.drop, signatures: [...seen.values()] };
}

/** A strict majority of the keyed seats other than the one being dropped. The
 *  seat cannot vote on its own removal, and it cannot block it either. */
export async function verifyDrop(
  roster: Roster,
  gameId: string,
  signed: SignedDrop,
): Promise<boolean> {
  if (!signed?.drop || !Array.isArray(signed.signatures)) return false;
  if (!roster.keyOf(signed.drop.empire, signed.drop.member)) return false;

  let payload: Uint8Array;
  try {
    payload = encodeDrop(gameId, signed.drop);
  } catch {
    return false;
  }

  const target = `${signed.drop.empire}:${signed.drop.member}`;
  const electorate = roster.all().filter(
    (seat) => `${seat.empire}:${seat.member}` !== target,
  ).length;
  if (electorate === 0) return false;

  const endorsed = new Set<string>();
  for (const { empire, member, sig } of signed.signatures) {
    const slot = `${empire}:${member}`;
    if (slot === target || endorsed.has(slot)) continue;
    const key = roster.keyOf(empire, member);
    if (!key) continue;
    if (await verify(key, sig, payload)) endorsed.add(slot);
  }

  return endorsed.size > electorate / 2;
}

// --- roster amendments -------------------------------------------------------

/** Adding a substitute mid-game. Not one member's decision: a quorum of the
 *  empire's existing seats must sign the same record, or one compromised key
 *  could invite an accomplice into the team. */
export interface Amendment {
  empire: number;
  step: number;
  key: MemberKey;
  kind: MemberKind;
}

export interface SignedAmendment {
  amendment: Amendment;
  /** One entry per endorsing seat. Duplicates from a single seat count once. */
  signatures: Array<{ member: number; sig: string }>;
}

export function encodeAmendment(gameId: string, amendment: Amendment): Uint8Array {
  const key = utf8(amendment.key);
  if (!u8(amendment.empire) || amendment.empire < 1 || !u32(amendment.step) || !u8(amendment.kind)) {
    throw new Error("amendment field out of range");
  }
  if (!u16(key.length) || key.length === 0) throw new Error("amendment key is absurd");

  const record = new Writer(10 + key.length)
    .u32(amendment.step)
    .u8(amendment.empire)
    .u8(amendment.kind)
    .u32(key.length)
    .raw(key)
    .finish();
  return concat(preamble(TAG_AMENDMENT, gameId), record);
}

export async function endorseAmendment(
  identity: Identity,
  gameId: string,
  amendment: Amendment,
  member: number,
): Promise<{ member: number; sig: string }> {
  return { member, sig: await identity.sign(encodeAmendment(gameId, amendment)) };
}

/** Merge what two peers have each collected. Endorsements are a set, so
 *  gossiping partial tallies converges without anyone coordinating — the same
 *  property mergeDrop relies on, and for the same reason. Both records must
 *  name the same amendment; the caller keys them by one, so this trusts it. */
export function mergeAmendment(a: SignedAmendment, b: SignedAmendment): SignedAmendment {
  const seen = new Map<number, { member: number; sig: string }>();
  for (const signature of [...a.signatures, ...b.signatures]) {
    seen.set(signature.member, signature);
  }
  return { amendment: a.amendment, signatures: [...seen.values()] };
}

export interface Tally {
  /** Distinct existing seats of that empire whose signature checks out. */
  endorsed: number;
  /** How many of them it takes. Zero means the record can never pass — the
   *  empire is not there, or the key it names is already seated. */
  needed: number;
}

/** How far along an amendment is.
 *
 *  Separate from the yes/no answer because a peer has to act on a record that
 *  is not finished yet: one valid signature is what tells it a proposal is real
 *  rather than noise, and worth holding a step open for. Counting is the
 *  expensive part either way — one verification per signature — so the two
 *  questions share it. */
export async function tallyAmendment(
  roster: Roster,
  gameId: string,
  signed: SignedAmendment,
): Promise<Tally> {
  const nothing: Tally = { endorsed: 0, needed: 0 };
  if (!signed?.amendment || !Array.isArray(signed.signatures)) return nothing;
  // Already seated. Not a failure of the signatures — a second seat for one key
  // would give its holder two population timers, which is the whole point of
  // the rule against it.
  if (roster.has(signed.amendment.key)) return nothing;
  const needed = roster.quorum(signed.amendment.empire);
  if (roster.membersOf(signed.amendment.empire).length === 0) return nothing;

  let payload: Uint8Array;
  try {
    payload = encodeAmendment(gameId, signed.amendment);
  } catch {
    return nothing;
  }

  const endorsed = new Set<number>();
  for (const { member, sig } of signed.signatures) {
    if (endorsed.has(member)) continue;
    const key = roster.keyOf(signed.amendment.empire, member);
    if (!key) continue;
    if (await verify(key, sig, payload)) endorsed.add(member);
  }
  return { endorsed: endorsed.size, needed };
}

/** True when a quorum of *distinct existing* seats of that empire have signed,
 *  and the key being added is not already seated somewhere. */
export async function verifyAmendment(
  roster: Roster,
  gameId: string,
  signed: SignedAmendment,
): Promise<boolean> {
  const tally = await tallyAmendment(roster, gameId, signed);
  return tally.needed > 0 && tally.endorsed >= tally.needed;
}

/** The simulation move an accepted amendment produces. The sim reads the new
 *  member's kind out of `x`; the key itself never enters hashed state, because
 *  the sim addresses members by index and knows nothing about keys. */
export function amendmentMove(amendment: Amendment, seq: number, by: number): Move {
  return {
    step: amendment.step,
    empire: amendment.empire,
    member: by,
    seq,
    type: MOVE.ROSTER_AMEND,
    x: amendment.kind,
    y: 0,
  };
}

// --- handshake ---------------------------------------------------------------

/** Mutual challenge-response: each side signs both nonces, so neither can
 *  replay a recorded proof. Possession of the key is all this establishes —
 *  which is enough, because every move is separately signed anyway. */
export function encodeHello(
  gameId: string,
  theirNonce: Uint8Array,
  ourNonce: Uint8Array,
): Uint8Array {
  if (theirNonce.length !== NONCE_BYTES || ourNonce.length !== NONCE_BYTES) {
    throw new Error("nonce must be 16 bytes");
  }
  return concat(preamble(TAG_HELLO, gameId), theirNonce, ourNonce);
}

export async function proveHello(
  identity: Identity,
  gameId: string,
  theirNonce: Uint8Array,
  ourNonce: Uint8Array,
): Promise<string> {
  return identity.sign(encodeHello(gameId, theirNonce, ourNonce));
}

export async function verifyHello(
  key: MemberKey,
  gameId: string,
  theirNonce: Uint8Array,
  ourNonce: Uint8Array,
  proof: string,
): Promise<boolean> {
  try {
    // Argument order mirrors the signer's point of view: what they were
    // challenged with comes first.
    return await verify(key, proof, encodeHello(gameId, theirNonce, ourNonce));
  } catch {
    return false;
  }
}

// --- equivocation ------------------------------------------------------------

/** Two validly signed moves sharing (empire, member, step, seq) are
 *  cryptographic proof of cheating: the member told different peers different
 *  things about one slot. Because the mesh gossips every move it sees, that is
 *  *detected* rather than merely suspected — and the proof is self-contained,
 *  so any peer can check it without trusting the peer that found it.
 *
 *  The step belongs in the slot. A seq counter lives in one Lockstep instance
 *  and restarts at zero when a player reloads, so a returning seat reuses the
 *  numbers it spent before the reload. Keyed on seq alone that reads as the
 *  member contradicting itself, and an honest rejoin is answered with an
 *  ejection. What the accusation has to mean is "two different moves for the
 *  same step", and the step has to be in the key to say so.
 *
 *  Nothing is lost by it. Ordering within a step is by (empire, member, seq),
 *  so a duplicated pair is exactly the ambiguity that could diverge two peers —
 *  and that pair is still caught. Reusing a seq at a *different* step decides
 *  nothing: both moves are gossiped, both are applied at their own steps, and
 *  every peer lands on the same state. */
export class EquivocationWatch {
  private readonly seen = new Map<string, SignedMove>();

  private static slot(move: Move): string {
    return `${move.empire}:${move.member}:${move.step}:${move.seq}`;
  }

  /** Returns the earlier conflicting move, or null. Feed it only moves whose
   *  signatures already verified — an unverified move would let anyone frame
   *  anyone. */
  record(signed: SignedMove): SignedMove | null {
    const slot = EquivocationWatch.slot(signed.move);
    const previous = this.seen.get(slot);
    if (!previous) {
      this.seen.set(slot, signed);
      return null;
    }
    return sameMove(previous.move, signed.move) ? null : previous;
  }

  forget(beforeStep: number): void {
    for (const [slot, signed] of this.seen) {
      if (signed.move.step < beforeStep) this.seen.delete(slot);
    }
  }
}

export function sameMove(a: Move, b: Move): boolean {
  return (
    a.step === b.step &&
    a.empire === b.empire &&
    a.member === b.member &&
    a.seq === b.seq &&
    a.type === b.type &&
    a.x === b.x &&
    a.y === b.y
  );
}

/** What a finder broadcasts. Both halves carry their own signatures, so a
 *  recipient verifies the accusation from scratch. */
export interface EquivocationProof {
  a: SignedMove;
  b: SignedMove;
}

export async function verifyEquivocation(
  roster: Roster,
  gameId: string,
  proof: EquivocationProof,
): Promise<boolean> {
  const { a, b } = proof;
  if (!a?.move || !b?.move) return false;
  if (a.move.empire !== b.move.empire) return false;
  if (a.move.member !== b.move.member) return false;
  if (a.move.step !== b.move.step) return false;
  if (a.move.seq !== b.move.seq) return false;
  if (sameMove(a.move, b.move)) return false; // the same move twice is not a crime
  return (
    (await verifyMove(roster, gameId, a)) && (await verifyMove(roster, gameId, b))
  );
}

export { MOVE };
