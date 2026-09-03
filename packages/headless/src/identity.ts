// A key that survives a restart.
//
// The keypair is the seat: the roster names public keys and nothing else, so a
// peer that loses its key loses its place and there is nobody to appeal to. In
// a browser that means localStorage; here it means a file, and a file with the
// permissions to match — a private key readable by every account on the box is
// a seat anyone on the box can play.
//
// Generated on first run rather than demanded up front, because the common case
// is somebody starting an observer for the first time and having nothing to
// give it.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Identity } from "@tessera/protocol";

/** Load the key at `path`, minting one if there is nothing there yet. */
export async function identityAt(path: string): Promise<Identity> {
  const stored = await readFile(path, "utf8").catch(() => null);
  if (stored) {
    const restored = await Identity.restore(stored.trim());
    if (restored) return restored;
    // A corrupt file is not something to quietly replace. Overwriting it would
    // silently abandon whatever seat that key held.
    throw new Error(`${path} is not a usable identity — move it aside to mint a new one`);
  }

  const fresh = await Identity.generate();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await fresh.export(), { mode: 0o600 });
  await chmod(path, 0o600);
  return fresh;
}
