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

import { fromBase64Url, toBase64Url, toHex } from "./bytes.js";

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** Base64url of the 65-byte uncompressed point. This string is the member id
 *  everywhere: in the genesis roster, in an amendment, in the UI. */
export type MemberKey = string;

export const SIGNATURE_BYTES = 64;
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

  /** JWK as a string, ready for localStorage. */
  async export(): Promise<string> {
    return JSON.stringify(await subtle().exportKey("jwk", this.privateKey));
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
