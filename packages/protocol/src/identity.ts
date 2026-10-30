// Member identity: an ECDSA P-256 keypair, and the public key *is* the member.
//
// P-256 rather than Ed25519 purely because Ed25519 support in browser Web
// Crypto is still patchy; P-256 is available everywhere the game runs, Node
// included, with no library. Signatures are IEEE-P1363 r||s, a flat 64 bytes.
//
// Signatures are randomised: two peers signing the same move produce different
// bytes. That is harmless here and worth stating plainly, because it is exactly
// the kind of thing that looks like a desync. Signatures are never hashed into
// simulation state — only moves are, and a move is the same on every peer.

import { fromBase64Url, toBase64Url, toHex, utf8 } from "./bytes.js";

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** The same curve, read as an agreement key rather than a signing one.
 *
 *  Web Crypto fixes the algorithm at generation: an ECDSA key can sign and
 *  nothing else. But a P-256 point is a P-256 point, so the keypair can be
 *  exported and read back in as ECDH — which is what lets two teammates derive
 *  a shared secret from the very keys the roster already names them by, with no
 *  second keypair to distribute, persist, or lose.
 *
 *  Using one keypair for two algorithms is worth a moment's thought. It is safe
 *  here because the two uses are cryptographically separated: ECDSA signs
 *  domain-tagged payloads, and every derived secret goes through HKDF with its
 *  own tag, so neither can be made to produce something the other would accept. */
const AGREE_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const;

/** Base64url of the 65-byte uncompressed point. This string is the member id
 *  everywhere: in the genesis roster, in an amendment, in the UI. */
export type MemberKey = string;

export const SIGNATURE_BYTES = 64;

/** The start of every backup code, and its format's version. */
const BACKUP_TAG = "T1";

/** What a member signs to have its name taken out of the records. The time
 *  keeps an old request from being replayed later. */
export const forgetPayload = (key: MemberKey, at: number): Uint8Array =>
  utf8(`tessera/forget/1|${key}|${at}`);
const PUBLIC_KEY_BYTES = 65;

/** Imported verifying keys, cached by their string form. Bounded by the roster,
 *  and importKey is far from free when it runs once per move on a mesh. */
const verifiers = new Map<MemberKey, CryptoKey | null>();

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error("Web Crypto is unavailable — a secure context is required");
  }
  return webcrypto.subtle;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A member's own keypair. The private key never leaves this object except
 *  through export(), which exists so a browser can persist a seat across a
 *  reload — losing it means losing the seat, since the roster names the key. */
export class Identity {
  /** Derived once and kept: the export-and-reimport below is not cheap, and a
   *  chat message would otherwise pay for it on every line. */
  private agreeing?: Promise<CryptoKey>;

  private constructor(
    readonly key: MemberKey,
    private readonly privateKey: CryptoKey,
  ) {}

  static async generate(): Promise<Identity> {
    const pair = await subtle().generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
    return Identity.fromPair(pair);
  }

  /** Restore from export(). Returns null on anything malformed: the usual
   *  caller is reading localStorage, where corruption is routine. */
  static async restore(stored: string): Promise<Identity | null> {
    try {
      const jwk = JSON.parse(stored) as JsonWebKey;
      const privateKey = await subtle().importKey("jwk", jwk, KEY_ALGORITHM, true, ["sign"]);
      const publicJwk: JsonWebKey = { ...jwk, d: undefined, key_ops: ["verify"] };
      delete publicJwk.d;
      const publicKey = await subtle().importKey("jwk", publicJwk, KEY_ALGORITHM, true, [
        "verify",
      ]);
      const raw = new Uint8Array(await subtle().exportKey("raw", publicKey));
      return new Identity(toBase64Url(raw), privateKey);
    } catch {
      return null;
    }
  }

  private static async fromPair(pair: CryptoKeyPair): Promise<Identity> {
    const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
    return new Identity(toBase64Url(raw), pair.privateKey);
  }

  /** This keypair as a backup code: the private scalar and the public point,
   *  96 bytes in base64url behind a version tag. Whoever holds it plays as
   *  this member, so it is shown to its owner and nobody else. */
  async toBackup(): Promise<string> {
    const jwk = await subtle().exportKey("jwk", this.privateKey);
    const parts = [jwk.d, jwk.x, jwk.y].map((part) => fromBase64Url(part ?? ""));
    if (parts.some((part) => !part || part.length !== 32)) throw new Error("unexpected key shape");
    const bytes = new Uint8Array(96);
    parts.forEach((part, i) => bytes.set(part!, i * 32));
    return BACKUP_TAG + toBase64Url(bytes);
  }

  /** Read a backup code back, or a link with one in it (`#restore=…`). Null if
   *  it is not one, or if its two halves do not belong together, which a
   *  signature made with the one and checked with the other finds out. */
  static async fromBackup(text: string): Promise<Identity | null> {
    const code = (/restore=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? text).trim();
    if (!code.startsWith(BACKUP_TAG)) return null;
    const bytes = fromBase64Url(code.slice(BACKUP_TAG.length));
    if (!bytes || bytes.length !== 96) return null;
    const part = (i: number) => toBase64Url(bytes.slice(i * 32, i * 32 + 32));
    const jwk = { kty: "EC", crv: "P-256", d: part(0), x: part(1), y: part(2), ext: true, key_ops: ["sign"] };
    const identity = await Identity.restore(JSON.stringify(jwk));
    if (!identity) return null;
    const probe = utf8("tessera/backup-check");
    return (await verify(identity.key, await identity.sign(probe), probe)) ? identity : null;
  }

  /** JWK as a string, ready for localStorage. */
  async export(): Promise<string> {
    return JSON.stringify(await subtle().exportKey("jwk", this.privateKey));
  }

  /** This keypair as an agreement key. The JWK's `alg` and `key_ops` name
   *  ECDSA, and an import that contradicts the algorithm it is asked for is
   *  rejected — so they are dropped rather than overridden. */
  async agreementKey(): Promise<CryptoKey> {
    if (!this.agreeing) {
      const jwk = (await subtle().exportKey("jwk", this.privateKey)) as JsonWebKey & {
        alg?: string;
      };
      delete jwk.alg;
      delete jwk.key_ops;
      this.agreeing = subtle().importKey("jwk", jwk, AGREE_ALGORITHM, false, ["deriveBits"]);
    }
    return this.agreeing;
  }

  async sign(payload: Uint8Array): Promise<string> {
    const signature = await subtle().sign(
      SIGN_ALGORITHM,
      this.privateKey,
      payload as BufferSource,
    );
    return toBase64Url(new Uint8Array(signature));
  }
}

/** Someone else's public key, read as an agreement key. Cached like the
 *  verifiers above and for the same reason. */
const agreers = new Map<MemberKey, CryptoKey | null>();

export async function agreementPublicKey(key: MemberKey): Promise<CryptoKey | null> {
  const cached = agreers.get(key);
  if (cached !== undefined) return cached;

  let imported: CryptoKey | null = null;
  try {
    const raw = fromBase64Url(key);
    if (raw && raw.length === PUBLIC_KEY_BYTES) {
      imported = await subtle().importKey("raw", raw as BufferSource, AGREE_ALGORITHM, false, []);
    }
  } catch {
    imported = null;
  }
  agreers.set(key, imported);
  return imported;
}

/** Never throws. Every call is checking something a peer sent, and a bad key,
 *  a truncated signature and a genuine forgery all mean the same thing here. */
export async function verify(
  key: MemberKey,
  signature: string,
  payload: Uint8Array,
): Promise<boolean> {
  const bytes = fromBase64Url(signature);
  if (!bytes || bytes.length !== SIGNATURE_BYTES) return false;

  const verifier = await importVerifier(key);
  if (!verifier) return false;

  try {
    return await subtle().verify(
      SIGN_ALGORITHM,
      verifier,
      bytes as BufferSource,
      payload as BufferSource,
    );
  } catch {
    return false;
  }
}

async function importVerifier(key: MemberKey): Promise<CryptoKey | null> {
  const cached = verifiers.get(key);
  if (cached !== undefined) return cached;

  const raw = fromBase64Url(key);
  let imported: CryptoKey | null = null;
  if (raw && raw.length === PUBLIC_KEY_BYTES && raw[0] === 0x04) {
    try {
      imported = await subtle().importKey("raw", raw as BufferSource, KEY_ALGORITHM, true, [
        "verify",
      ]);
    } catch {
      imported = null;
    }
  }
  // Negative results are cached too, so a peer spamming garbage keys cannot
  // make every other peer re-run importKey on each one.
  verifiers.set(key, imported);
  return imported;
}

/** Eight hex characters of the key's digest — enough to tell teammates apart in
 *  the UI, short enough to say out loud. Never used for authorisation. */
export async function fingerprint(key: MemberKey): Promise<string> {
  const raw = fromBase64Url(key);
  if (!raw) return "????????";
  return toHex(await sha256(raw)).slice(0, 8);
}
