// The keypair this browser plays under.
//
// The keypair *is* the seat: the roster names public keys, so losing the key
// loses the seat, and there is no recovery because there is nobody to recover
// it from. It is therefore persisted — and because it is persisted in this
// origin's local storage, a private window is a different player, which is the
// honest behaviour rather than a limitation.
//
// A headless peer keeps the same thing in a file. Only the cupboard differs.

import { Identity } from "@tessera/protocol";

const IDENTITY_STORE = "tessera.identity";

export async function myIdentity(): Promise<Identity> {
  const stored = localStorage.getItem(IDENTITY_STORE);
  if (stored) {
    const restored = await Identity.restore(stored);
    if (restored) return restored;
  }
  const fresh = await Identity.generate();
  try {
    localStorage.setItem(IDENTITY_STORE, await fresh.export());
  } catch {
    // A blocked store costs persistence across reloads, not the ability to play.
  }
  return fresh;
}
