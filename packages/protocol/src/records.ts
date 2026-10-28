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
import type { Move } from "@tessera/sim";
import { Writer, concat, utf8 } from "./bytes.js";
import { Identity, verify } from "./identity.js";
import type { MemberKey } from "./identity.js";
import type { Roster } from "./roster.js";

const TAG_MOVE = "tessera/move/2";
const TAG_MESSAGE = "tessera/message/1";
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

/** The signed bytes of a move. **The step is not among them**: whoever orders
 *  the game (a game room) decides which step a move lands on, after it is
 *  signed. A player signs what they did; the order says when. `seq` is in, and
 *  only rises, so a signed move cannot be replayed into a second slot. */
export function encodeMove(gameId: string, move: Move): Uint8Array {
  if (!moveInRange(move)) throw new Error("move field out of range");
  const record = new Writer(12)
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

export const CHANNEL = { PUBLIC: 0, TEAM: 1, DIRECT: 2 } as const;
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/** Ordered, signed and attributable — but never hashed into state. That is the
 *  whole reason chat is safe: a message that arrives late, out of order, or not
 *  at all cannot cause a desync. `body` is plaintext on PUBLIC and base64url
 *  AES-GCM ciphertext on TEAM and DIRECT.
 *
 *  **The recipient of a DIRECT message is not a field here**, and that is the
 *  design rather than an omission: the envelope already carries it, wrapped, so
 *  the wire shows *that* a seat spoke privately and never to whom. `channel` is
 *  a `u8` and `messageInRange` accepts the whole range, so this record did not
 *  have to change at all — which is also why `ARCHIVE_FORMAT` did not: a
 *  `channel: 2` message verifies exactly like any other. */
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

// --- invites -----------------------------------------------------------------

const TAG_INVITE = "tessera/invite/1";

/** "Whoever holds this may join my empire." Signed by a seated member, so it
 *  can be checked by anybody who knows the roster: a room today, a peer in a
 *  game with no room tomorrow. */
export interface Invite {
  empire: number;
  /** Random, base64url. A room accepts each id once. */
  id: string;
  /** Seconds since the epoch after which it is refused. */
  expires: number;
  /** The inviting member's key. */
  by: MemberKey;
}

export interface SignedInvite {
  invite: Invite;
  sig: string;
}

export function encodeInvite(gameId: string, invite: Invite): Uint8Array {
  const id = utf8(invite.id);
  const by = utf8(invite.by);
  if (!(u8(invite.empire) && invite.empire >= 1 && u32(invite.expires))) {
    throw new Error("invite field out of range");
  }
  if (!u16(id.length) || !u16(by.length)) throw new Error("invite field out of range");
  const record = new Writer(9 + id.length + by.length)
    .u8(invite.empire)
    .u32(invite.expires)
    .u16(id.length)
    .raw(id)
    .u16(by.length)
    .raw(by)
    .finish();
  return concat(preamble(TAG_INVITE, gameId), record);
}

export async function signInvite(
  identity: Identity,
  gameId: string,
  invite: Invite,
): Promise<SignedInvite> {
  return { invite, sig: await identity.sign(encodeInvite(gameId, invite)) };
}

/** True when the invite is well formed and signed by the key it names. Whether
 *  that key may invite into that empire is the roster's question, asked by
 *  the caller. */
export async function verifyInvite(gameId: string, signed: SignedInvite): Promise<boolean> {
  try {
    if (!signed?.invite || typeof signed.sig !== "string") return false;
    const { empire, id, expires, by } = signed.invite;
    if (typeof id !== "string" || typeof by !== "string" || id.length > 64) return false;
    if (!Number.isInteger(empire) || !Number.isInteger(expires)) return false;
    return await verify(by, signed.sig, encodeInvite(gameId, signed.invite));
  } catch {
    return false;
  }
}
