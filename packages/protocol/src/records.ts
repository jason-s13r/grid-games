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

/** True when a quorum of *distinct existing* seats of that empire have signed,
 *  and the key being added is not already seated somewhere. */
export async function verifyAmendment(
  roster: Roster,
  gameId: string,
  signed: SignedAmendment,
): Promise<boolean> {
  if (!signed?.amendment || !Array.isArray(signed.signatures)) return false;
  if (roster.has(signed.amendment.key)) return false;

  let payload: Uint8Array;
  try {
    payload = encodeAmendment(gameId, signed.amendment);
  } catch {
    return false;
  }

  const endorsed = new Set<number>();
  for (const { member, sig } of signed.signatures) {
    if (endorsed.has(member)) continue;
    const key = roster.keyOf(signed.amendment.empire, member);
    if (!key) continue;
    if (await verify(key, sig, payload)) endorsed.add(member);
  }

  return endorsed.size >= roster.quorum(signed.amendment.empire);
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

/** Two validly signed moves sharing (empire, member, seq) are cryptographic
 *  proof of cheating: the member told different peers different things. Because
 *  the mesh gossips every move it sees, that is *detected* rather than merely
 *  suspected — and the proof is self-contained, so any peer can check it
 *  without trusting the peer that found it. */
export class EquivocationWatch {
  private readonly seen = new Map<string, SignedMove>();

  private static slot(move: Move): string {
    return `${move.empire}:${move.member}:${move.seq}`;
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
  if (a.move.seq !== b.move.seq) return false;
  if (sameMove(a.move, b.move)) return false; // the same move twice is not a crime
  return (
    (await verifyMove(roster, gameId, a)) && (await verifyMove(roster, gameId, b))
  );
}

export { MOVE };
