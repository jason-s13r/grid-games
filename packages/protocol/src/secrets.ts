// Team chat: readable by your empire, ciphertext to everybody else.
//
// The mesh broadcasts everything, so privacy here has to be cryptographic
// rather than a matter of who a message is addressed to. An opponent, an
// observer, and an archive peer all receive every team message and store it;
// what separates a teammate from them is only whether the bytes can be opened.
//
// The construction is deliberately the boring one. A random content key per
// message encrypts the text; that key is then wrapped once per teammate, using
// a secret derived by ECDH between the sender's keypair and that teammate's —
// the same keypairs the roster already names everyone by. Nobody has to be
// online to receive a key, nothing has to be stored, no extra record type
// exists, and a member who joins by amendment can be written to immediately.
//
// It is fanout rather than a group key, which is the honest trade. N teammates
// costs N-1 wraps of 60 bytes; at the size a team actually is, that is nothing,
// and it avoids a group key agreement that P-256 cannot do without a live
// participant to distribute it. The cost is that there is no single team key to
// publish at the end of a game, so the plan's optional post-game reveal is not
// something this construction can offer.
//
// What it does NOT do is hide who is talking. A team message is signed and
// attributable like every other record, so an opponent sees that empire 2's
// second seat said something 200 steps in. Only the words are private.

import { concat, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.js";
import { agreementPublicKey, randomBytes } from "./identity.js";
import type { Identity, MemberKey } from "./identity.js";

const VERSION = 1;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** AES-GCM adds a 16-byte tag, so a wrapped 32-byte key is 48 on the wire. */
const WRAPPED_BYTES = KEY_BYTES + 16;
const HEADER_BYTES = 2; // version, wrap count
const WRAP_BYTES = 1 + NONCE_BYTES + WRAPPED_BYTES; // member, nonce, wrapped key

/** A member index is one byte on the wire, which is also more seats than any
 *  empire will ever have. */
const MAX_MEMBER = 255;

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error("Web Crypto is unavailable — a secure context is required");
  }
  return webcrypto.subtle;
}

/** The wrapping key shared by two members.
 *
 *  The raw ECDH output is never used directly: it goes through HKDF with a tag
 *  naming this use, the game, and the empire. Two members on two empires in two
 *  games therefore share four unrelated keys, and a secret derived here can
 *  never coincide with one derived for anything else. */
async function wrappingKey(
  mine: Identity,
  theirs: MemberKey,
  gameId: string,
  empire: number,
): Promise<CryptoKey | null> {
  const publicKey = await agreementPublicKey(theirs);
  if (!publicKey) return null;

  const bits = await subtle().deriveBits(
    { name: "ECDH", public: publicKey },
    await mine.agreementKey(),
    256,
  );
  const material = await subtle().importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8(gameId),
      info: utf8(`tessera/team/1:${empire}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Teammate {
  /** Seat index within the empire. It travels with the wrap so a reader can
   *  find its own without trial-decrypting every one of them. */
  member: number;
  key: MemberKey;
}

/** Encrypt for an empire. Returns base64url for the message body, or null when
 *  the recipients cannot be worked with — a malformed key in the roster, or
 *  more seats than the format holds.
 *
 *  Pass every member of the empire except the sender. Passing nobody is legal
 *  and produces a message only the sender could ever have read, which is the
 *  right answer for a team of one. */
export async function sealTeamBody(
  identity: Identity,
  gameId: string,
  empire: number,
  recipients: readonly Teammate[],
  text: string,
): Promise<string | null> {
  if (recipients.some((who) => who.member < 0 || who.member > MAX_MEMBER)) return null;
  if (recipients.length > MAX_MEMBER) return null;

  const contentKey = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const content = await subtle().importKey("raw", contentKey as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, content, utf8(text)),
  );

  const wraps: Uint8Array[] = [];
  for (const who of recipients) {
    const key = await wrappingKey(identity, who.key, gameId, empire);
    if (!key) return null;
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrapped = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: wrapNonce as BufferSource },
        key,
        contentKey as BufferSource,
      ),
    );
    wraps.push(concat(new Uint8Array([who.member]), wrapNonce, wrapped));
  }

  return toBase64Url(
    concat(new Uint8Array([VERSION, wraps.length]), nonce, ...wraps, ciphertext),
  );
}

/** Decrypt a team message addressed to `member`, or null.
 *
 *  Null covers everything: another empire's traffic, a seat with no wrap in it,
 *  a truncated body, a forged one. They are all the same to a reader, and none
 *  of them is an error — receiving mail you cannot open is the normal case. */
export async function openTeamBody(
  identity: Identity,
  gameId: string,
  empire: number,
  sender: MemberKey,
  member: number,
  body: string,
): Promise<string | null> {
  const bytes = fromBase64Url(body);
  if (!bytes || bytes.length < HEADER_BYTES + NONCE_BYTES) return null;
  if (bytes[0] !== VERSION) return null;

  const count = bytes[1]!;
  const start = HEADER_BYTES + NONCE_BYTES;
  const end = start + count * WRAP_BYTES;
  if (bytes.length < end) return null;

  const nonce = bytes.subarray(HEADER_BYTES, start);
  let wrapped: Uint8Array | undefined;
  let wrapNonce: Uint8Array | undefined;
  for (let i = 0; i < count; i++) {
    const at = start + i * WRAP_BYTES;
    if (bytes[at] !== member) continue;
    wrapNonce = bytes.subarray(at + 1, at + 1 + NONCE_BYTES);
    wrapped = bytes.subarray(at + 1 + NONCE_BYTES, at + WRAP_BYTES);
    break;
  }
  if (!wrapped || !wrapNonce) return null;

  try {
    const key = await wrappingKey(identity, sender, gameId, empire);
    if (!key) return null;
    const contentKey = await subtle().decrypt(
      { name: "AES-GCM", iv: wrapNonce as BufferSource },
      key,
      wrapped as BufferSource,
    );
    const content = await subtle().importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
    const text = await subtle().decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      content,
      bytes.subarray(end) as BufferSource,
    );
    return fromUtf8(new Uint8Array(text));
  } catch {
    // A tag that does not verify is indistinguishable from a message that was
    // never for us, and both mean the same thing to the reader.
    return null;
  }
}
