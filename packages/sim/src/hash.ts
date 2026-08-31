// FNV-1a over the canonical snapshot bytes.
//
// hash(state) = fnv1a(snapshot(state)), so one canonical serialisation drives
// both the consensus check and the content address of a checkpoint. Two peers
// agreeing on the hash agree on every byte of state, and a snapshot fetched
// from an untrusted peer can be verified before it is restored.

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const hex = (h: number): string => (h >>> 0).toString(16).padStart(8, "0");
