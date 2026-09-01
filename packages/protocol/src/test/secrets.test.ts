// Team chat has to be private against everyone the mesh delivers it to, which
// is everyone. These check that from both sides: a teammate reads it, and every
// other shape of recipient — an opponent, an observer, the wrong seat, a
// tampered body — gets nothing.

import { beforeAll, describe, expect, it } from "vitest";
import { Identity, openTeamBody, sealTeamBody } from "../index.js";
import type { Teammate } from "../index.js";
import { fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
let teammates: Teammate[];
let sealed: string;

const TEXT = "push their capital at 3:20, I have 900 banked";

beforeAll(async () => {
  f = await fixture();
  // Alice is seat 0 of empire 1; Bob and Carol are seats 1 and 2 beside her.
  teammates = [
    { member: 1, key: f.bob.key },
    { member: 2, key: f.carol.key },
  ];
  sealed = (await sealTeamBody(f.alice, f.gameId, 1, teammates, TEXT))!;
});

const open = (who: Identity, member: number, sender = f.alice.key, body = sealed) =>
  openTeamBody(who, f.gameId, 1, sender, member, body);

describe("a team message", () => {
  it("is not the text it carries", () => {
    expect(sealed).toBeTruthy();
    expect(sealed).not.toContain("capital");
  });

  it("opens for a teammate", async () => {
    await expect(open(f.bob, 1)).resolves.toBe(TEXT);
  });

  it("opens for every teammate it was sealed for", async () => {
    await expect(open(f.carol, 2)).resolves.toBe(TEXT);
  });

  // The sender is not in its own recipient list, so it cannot re-read what it
  // sent. The UI shows what was typed rather than what came back.
  it("does not open for the sender", async () => {
    await expect(open(f.alice, 0)).resolves.toBeNull();
  });

  it("is silent about a body that is not one of ours", async () => {
    await expect(open(f.bob, 1, f.alice.key, "not base64url!!")).resolves.toBeNull();
    await expect(open(f.bob, 1, f.alice.key, "")).resolves.toBeNull();
  });
});

describe("everyone else", () => {
  it("an opponent holding the ciphertext cannot read it", async () => {
    await expect(open(f.mallory, 1)).resolves.toBeNull();
  });

  // The interesting near-miss: the right key, the wrong seat. Each wrap names
  // the seat it belongs to, so Bob reading Carol's slot finds a tag that will
  // not verify.
  it("a teammate reading someone else's wrap gets nothing", async () => {
    await expect(open(f.bob, 2)).resolves.toBeNull();
  });

  it("a seat with no wrap in the message gets nothing", async () => {
    await expect(open(f.bob, 9)).resolves.toBeNull();
  });

  it("naming the wrong sender gets nothing", async () => {
    await expect(open(f.bob, 1, f.carol.key)).resolves.toBeNull();
  });
});

describe("the key is bound to where it was derived", () => {
  it("a message does not open under another game id", async () => {
    await expect(
      openTeamBody(f.bob, f.otherGame.gameId!, 1, f.alice.key, 1, sealed),
    ).resolves.toBeNull();
  });

  it("or under another empire", async () => {
    await expect(openTeamBody(f.bob, f.gameId, 2, f.alice.key, 1, sealed)).resolves.toBeNull();
  });
});

describe("tampering", () => {
  const flip = (body: string, at: number): string => {
    const bytes = [...atob(body.replace(/-/g, "+").replace(/_/g, "/"))].map((c) =>
      c.charCodeAt(0),
    );
    bytes[at % bytes.length] ^= 0x01;
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  it("a flipped bit anywhere in the ciphertext is caught", async () => {
    await expect(open(f.bob, 1, f.alice.key, flip(sealed, -3 + 1e6))).resolves.toBeNull();
  });

  it("a flipped bit in a wrapped key is caught", async () => {
    await expect(open(f.bob, 1, f.alice.key, flip(sealed, 20))).resolves.toBeNull();
  });
});

describe("a team of one", () => {
  // Legal, and it has to be: an empire whose other seats have not joined yet
  // still has a chat box, and typing into it must not throw.
  it("seals with no recipients at all", async () => {
    const body = await sealTeamBody(f.alice, f.gameId, 1, [], "talking to myself");
    expect(body).toBeTruthy();
    await expect(open(f.bob, 1, f.alice.key, body!)).resolves.toBeNull();
  });
});

describe("size", () => {
  // The wire refuses a body over 2048 characters, and encryption is what makes
  // a long message longer. A full-length line to four teammates has to fit.
  it("a maximum-length message to four teammates still fits the wire", async () => {
    const crowd: Teammate[] = [1, 2, 3, 4].map((member) => ({ member, key: f.bob.key }));
    const body = await sealTeamBody(f.alice, f.gameId, 1, crowd, "x".repeat(280));
    expect(body!.length).toBeLessThan(2048);
  });
});
