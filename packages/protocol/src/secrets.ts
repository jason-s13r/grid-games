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

/** The leading byte selects a **scheme**, not a generation.
 *
 *  It is worth being exact about why, because "bump the version to 2" is the
 *  obvious reading and it would silently break the property the comment on
 *  `wrappingKey` exists to defend. A team key binds the empire; a direct key
 *  cannot, because a DM has two empires or one. If a single `VERSION` constant
 *  moved to 2, **every team message would start sealing under the pair
 *  derivation too** — the empire binding would be gone, a team message between
 *  two people would be identical in key material to a DM between the same two,
 *  and nothing in the suite would have noticed.
 *
 *  So both values coexist forever, and the byte says which construction sealed
 *  the envelope. Which in turn means the layout constants are functions of it
 *  rather than constants. */
const SCHEME = { TEAM: 1, DIRECT: 2 } as const;
type Scheme = (typeof SCHEME)[keyof typeof SCHEME];

const NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** AES-GCM adds a 16-byte tag, so a wrapped 32-byte key is 48 on the wire. */
const WRAPPED_BYTES = KEY_BYTES + 16;
const HEADER_BYTES = 2; // scheme, wrap count

/** Bytes per wrap.
 *
 *  A team wrap carries the member index so a reader can find its own without
 *  trial-decrypting every one. A direct wrap carries no index **and that is the
 *  point**: the wire then shows that a seat spoke privately and not to whom.
 *  There is exactly one candidate key either way — ECDH is symmetric, so
 *  against a given sender a reader can derive precisely one wrapping key — so
 *  "trial decryption" is one derivation and two AES-GCM attempts, not a search. */
const wrapBytes = (scheme: Scheme): number =>
  (scheme === SCHEME.TEAM ? 1 : 0) + NONCE_BYTES + WRAPPED_BYTES;

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

/** What a derived key is bound to.
 *
 *  A team key names the game and **the empire**: two members on two empires in
 *  two games therefore share four unrelated keys, and a secret derived here can
 *  never coincide with one derived for anything else.
 *
 *  A direct key cannot use that binding — a DM has two empires, or one — so it
 *  names the game and **both member keys in lexicographic order**, which both
 *  ends compute identically without agreeing on anything first. The ordering is
 *  the whole trick: ECDH is symmetric, so the two parties derive the same bits,
 *  and sorting makes them derive the same *label* over those bits too. */
const infoFor = (scheme: Scheme, empire: number, pair: readonly string[]): string =>
  scheme === SCHEME.TEAM
    ? `tessera/team/1:${empire}`
    : `tessera/direct/1:${[...pair].sort().join(":")}`;

/** Derived keys, by what they are derived from.
 *
 *  A DM has no empire to filter on, so **every peer attempts every DM in the
 *  game**, including ones between two opponents — where a team message costs
 *  ECDH only to the empire it is addressed to. That lands on the serial
 *  verification lane, which exists precisely so frames from one peer cannot
 *  overtake each other, and a burst of DMs from one sender would queue
 *  derivations ahead of that sender's next READY.
 *
 *  A derivation is a pure function of the pair, the game and the scheme, and a
 *  driver holds one game — so memoising turns N derivations per counterpart
 *  into one, and a DM costs one AES-GCM attempt after that. `agreementPublicKey`
 *  already caches its imports for exactly this class of reason. */
const derived = new Map<string, Promise<CryptoKey | null>>();

async function wrappingKey(
  mine: Identity,
  theirs: MemberKey,
  gameId: string,
  empire: number,
  scheme: Scheme = SCHEME.TEAM,
): Promise<CryptoKey | null> {
  const info = infoFor(scheme, empire, [mine.key, theirs]);
  const slot = `${mine.key}\u0000${theirs}\u0000${gameId}\u0000${info}`;
  const held = derived.get(slot);
  if (held) return held;

  const deriving = derive(mine, theirs, gameId, info);
  derived.set(slot, deriving);
  // A failed derivation is a malformed key and will fail again; a thrown one
  // must not be cached, or a transient crypto error poisons the pair forever.
  deriving.catch(() => derived.delete(slot));
  return deriving;
}

async function derive(
  mine: Identity,
  theirs: MemberKey,
  gameId: string,
  info: string,
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
      info: utf8(info),
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
    concat(new Uint8Array([SCHEME.TEAM, wraps.length]), nonce, ...wraps, ciphertext),
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
  return unseal(identity, gameId, empire, sender, body, SCHEME.TEAM, member);
}

/** Encrypt for one person.
 *
 *  **Always exactly two wraps**, the recipient's and the sender's, and neither
 *  carries an index. Two things fall out of that, and the second is why it is
 *  worth the extra 60 bytes:
 *
 *  - The sender can read its own half of the conversation. The recipient list
 *    excludes the sender everywhere else in this file, and live the UI papers
 *    over it by showing what was typed — but on reload, on resume and in every
 *    archive, a two-person conversation with every other line blank reads as
 *    broken rather than as private.
 *  - The envelope shape is **constant**. Every v2 envelope is the same length
 *    for the same plaintext whoever it is for, which is a stronger
 *    indistinguishability property than one wrap gives.
 *
 *  The sender's own wrap derives under the same pair rule with both keys being
 *  theirs, so it needs no special case anywhere. */
export async function sealDirectBody(
  identity: Identity,
  gameId: string,
  recipient: MemberKey,
  text: string,
): Promise<string | null> {
  const contentKey = randomBytes(KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const content = await subtle().importKey("raw", contentKey as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, content, utf8(text)),
  );

  const wraps: Uint8Array[] = [];
  // Ordered, so the envelope does not leak which wrap is whose by position.
  for (const who of [recipient, identity.key].sort()) {
    const key = await wrappingKey(identity, who, gameId, 0, SCHEME.DIRECT);
    if (!key) return null;
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrapped = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: wrapNonce as BufferSource },
        key,
        contentKey as BufferSource,
      ),
    );
    wraps.push(concat(wrapNonce, wrapped));
  }

  return toBase64Url(
    concat(new Uint8Array([SCHEME.DIRECT, wraps.length]), nonce, ...wraps, ciphertext),
  );
}

/** Decrypt a direct message, or null.
 *
 *  `counterpart` is the other end of the conversation: the sender's key when
 *  reading somebody else's, and the recipient's when reading our own back out of
 *  an archive. There is one candidate key, so both wraps are tried against it
 *  and whichever verifies is ours. */
export async function openDirectBody(
  identity: Identity,
  gameId: string,
  counterpart: MemberKey,
  body: string,
): Promise<string | null> {
  return unseal(identity, gameId, 0, counterpart, body, SCHEME.DIRECT);
}

/** One dispatcher, two entry points.
 *
 *  `member` selects a wrap by index for a team envelope and is ignored for a
 *  direct one, where every wrap is tried — which costs one extra AES-GCM
 *  attempt and buys not naming the recipient on the wire. */
async function unseal(
  identity: Identity,
  gameId: string,
  empire: number,
  counterpart: MemberKey,
  body: string,
  scheme: Scheme,
  member?: number,
): Promise<string | null> {
  const bytes = fromBase64Url(body);
  if (!bytes || bytes.length < HEADER_BYTES + NONCE_BYTES) return null;
  if (bytes[0] !== scheme) return null;

  const width = wrapBytes(scheme);
  const count = bytes[1]!;
  const start = HEADER_BYTES + NONCE_BYTES;
  const end = start + count * width;
  if (bytes.length < end) return null;

  const nonce = bytes.subarray(HEADER_BYTES, start);
  const candidates: Array<{ nonce: Uint8Array; wrapped: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * width;
    const skip = scheme === SCHEME.TEAM ? 1 : 0;
    if (scheme === SCHEME.TEAM && bytes[at] !== member) continue;
    candidates.push({
      nonce: bytes.subarray(at + skip, at + skip + NONCE_BYTES),
      wrapped: bytes.subarray(at + skip + NONCE_BYTES, at + width),
    });
  }
  if (candidates.length === 0) return null;

  const key = await wrappingKey(identity, counterpart, gameId, empire, scheme);
  if (!key) return null;

  for (const candidate of candidates) {
    try {
      const contentKey = await subtle().decrypt(
        { name: "AES-GCM", iv: candidate.nonce as BufferSource },
        key,
        candidate.wrapped as BufferSource,
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
      // never for us, and both mean the same thing to the reader. Try the next.
    }
  }
  return null;
}
