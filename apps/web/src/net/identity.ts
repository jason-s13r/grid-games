// The keypair this browser plays under.
//
// The keypair *is* the seat: the roster names public keys, so losing the key
// loses the seat, and there is no recovery because there is nobody to recover
// it from. It is therefore persisted — and because it is persisted in this
// origin's local storage, a private window is a different player, which is the
// honest behaviour rather than a limitation.
//
// A headless peer keeps the same thing in a file. Only the cupboard differs.

import { Identity, cleanName } from "@tessera/protocol";

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

const NAME_STORE = "tessera.name";

/** What this browser would like to be called.
 *
 *  Beside the key and not inside it, because a name is not a credential — it is
 *  a label, cleaned by whoever reads it, and losing it costs nothing. Kept here
 *  rather than per game for the obvious reason: a name that had to be retyped
 *  at the start of every game would be typed once.
 *
 *  Cleaned on the way out as well as on the way in. Not for safety — the
 *  reader's pass is what does that — but so what we store is what we would
 *  render, and a name does not change shape between this tab and somebody
 *  else's. */
export function myName(): string {
  try {
    return cleanName(localStorage.getItem(NAME_STORE));
  } catch {
    return "";
  }
}

export function setMyName(name: string): string {
  const clean = cleanName(name);
  try {
    if (clean) localStorage.setItem(NAME_STORE, clean);
    else localStorage.removeItem(NAME_STORE);
  } catch {
    // A blocked store costs persistence, not the ability to be called something
    // for the length of this game.
  }
  return clean;
}
