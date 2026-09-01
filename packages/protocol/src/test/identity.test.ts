// A member is a public key. There is no account, no login and nobody to ask —
// so the key has to survive a page reload, and a broken store has to fail
// closed rather than throw on load.

import { beforeAll, describe, expect, it } from "vitest";
import { Identity, fingerprint } from "../identity.js";

let alice: Identity;
beforeAll(async () => {
  alice = await Identity.generate();
});

describe("identity", () => {
  it("a public key is a 65-byte point", () => {
    expect((alice.key.length * 3) >> 2).toBe(65);
  });

  it("a keypair round-trips through storage", async () => {
    const restored = await Identity.restore(await alice.export());
    expect(restored?.key).toBe(alice.key);
  });

  it("a corrupt store restores to nothing", async () => {
    await expect(Identity.restore("{")).resolves.toBeNull();
  });

  it("a fingerprint is eight hex characters", async () => {
    await expect(fingerprint(alice.key)).resolves.toHaveLength(8);
  });
});
