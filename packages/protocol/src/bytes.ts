// Byte plumbing shared by every signed record.
//
// One rule governs this whole package: a signature is verified over bytes
// rebuilt here from parsed fields, never over the bytes that arrived. Verifying
// received bytes directly would let a sender append data that the signature
// covers but the parser never looks at — the classic smuggling bug. Every
// encode function below is therefore used identically by signer and verifier.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Base64url without padding — the form that survives a JSON field, a URL and a
 *  room code unmangled. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a large array into String.fromCharCode overflows the
  // call stack somewhere north of 100k arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns null rather than throwing: every caller is parsing something a peer
 *  sent, and malformed input is an expected condition, not an exception. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Constant time in the length-equal case. Nothing here is a secret today, but
  // the team key lands in this package later and habits are cheaper than fixes.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Fixed-layout little-endian writer. Every record in this package declares its
 *  exact size up front, so a short or long write is a build-time mistake rather
 *  than a silently different payload on one peer. */
export class Writer {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
  }

  u8(value: number): this {
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
    return this;
  }

  u16(value: number): this {
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
    return this;
  }

  finish(): Uint8Array {
    if (this.offset !== this.buffer.length) {
      throw new Error(`record is ${this.offset} bytes, declared ${this.buffer.length}`);
    }
    return this.buffer;
  }
}
