// A member is a public key. There is no account, no login and nobody to ask —
// so the key has to survive a page reload, and a broken store has to fail
// closed rather than throw on load.

import { beforeAll, describe, expect, it } from "vitest";
import { Identity, fingerprint, verify, forgetPayload } from "../identity.js";

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

  it("a backup code carries the same member to another device", async () => {
    const code = await alice.toBackup();
    expect(code).toMatch(/^T1[A-Za-z0-9_-]{128}$/);
    const there = await Identity.fromBackup(code);
    expect(there?.key).toBe(alice.key);
    // And it signs as that member.
    const payload = forgetPayload(alice.key, 1);
    expect(await verify(alice.key, await there!.sign(payload), payload)).toBe(true);
  });

  it("reads a backup code out of a link", async () => {
    const code = await alice.toBackup();
    const there = await Identity.fromBackup(`https://tessera.qot.nz/#restore=${code}`);
    expect(there?.key).toBe(alice.key);
  });

  it("refuses a code that is not one, or whose halves do not match", async () => {
    const bob = await Identity.generate();
    const a = await alice.toBackup();
    const b = await bob.toBackup();
    // Alice's private scalar with Bob's public point.
    const mixed = a.slice(0, 2 + 43) + b.slice(2 + 43);
    await expect(Identity.fromBackup("hello")).resolves.toBeNull();
    await expect(Identity.fromBackup(a.slice(0, 60))).resolves.toBeNull();
    await expect(Identity.fromBackup(mixed)).resolves.toBeNull();
  });
});
