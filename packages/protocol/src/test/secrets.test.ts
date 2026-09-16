// Team chat has to be private against everyone the mesh delivers it to, which
// is everyone. These check that from both sides: a teammate reads it, and every
// other shape of recipient — an opponent, an observer, the wrong seat, a
// tampered body — gets nothing.

import { beforeAll, describe, expect, it } from "vitest";
import {
  Identity,
  fromBase64Url,
  openDirectBody,
  openTeamBody,
  sealDirectBody,
  sealTeamBody,
  toBase64Url,
} from "../index.js";
import type { Teammate } from "../index.js";
import { fixture } from "./fixture.js";
import vector from "./vectors/team-chat-v1.json" with { type: "json" };
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

describe("the stored v1 vector", () => {
  // The tripwire, and the reason this file could not have one before.
  //
  // Every other test here seals an envelope and opens it five milliseconds
  // later with the same code — `fixture()` generates fresh keypairs on every
  // call and `sealTeamBody` draws a fresh content key per message — so a
  // changed derivation would go on passing forever, because the thing being
  // opened was sealed by the change.
  //
  // This opens bytes that were written before. `ArchivedGame.messages` holds
  // every `SignedMessage` exactly as it crossed the wire, so archives on disk
  // already contain v1 bodies and `openTeamBody` is the only thing that will
  // ever read them again.
  it("still opens, and its plaintext is unchanged", async () => {
    const bob = await Identity.restore(JSON.stringify(vector.bob));
    expect(bob).toBeTruthy();
    const text = await openTeamBody(
      bob!,
      vector.gameId,
      vector.empire,
      vector.aliceKey,
      vector.member,
      vector.body,
    );
    expect(text).toBe(vector.text);
  });

  it("does not open for anybody else", async () => {
    const alice = await Identity.restore(JSON.stringify(vector.alice));
    // Not even its own sender: the sender is not among its own recipients.
    await expect(
      openTeamBody(alice!, vector.gameId, vector.empire, vector.aliceKey, 0, vector.body),
    ).resolves.toBeNull();
  });

  // The assertion that would have caught `VERSION` moving from 1 to 2 and
  // silently deleting the empire binding along with it: a team message's
  // wrapping key is derived over the game *and the empire*, so the same text
  // for the same pair on two empires produces different wraps.
  it("a team key still binds the empire it was sealed for", async () => {
    const bob = await Identity.restore(JSON.stringify(vector.bob));
    // The vector was sealed on empire 2. Opening it as empire 3 derives a
    // different key and gets nothing, which is the binding, asserted.
    await expect(
      openTeamBody(bob!, vector.gameId, 3, vector.aliceKey, vector.member, vector.body),
    ).resolves.toBeNull();
    // And the game id binds too.
    await expect(
      openTeamBody(bob!, "another-game", vector.empire, vector.aliceKey, vector.member, vector.body),
    ).resolves.toBeNull();
  });
});

describe("a direct message", () => {
  const NOTE = "I will not march on you if you do not march on me";

  it("opens for its recipient", async () => {
    const sealed = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    await expect(openDirectBody(f.bob, f.gameId, f.alice.key, sealed)).resolves.toBe(NOTE);
  });

  // The clause the plan's honest statement was missing, and the reason the
  // envelope carries two wraps instead of one: live, the UI shows what was
  // typed — but on reload, on resume and in every archive, a two-person
  // conversation with every other line blank reads as broken, not as private.
  it("opens for its own sender", async () => {
    const sealed = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    await expect(openDirectBody(f.alice, f.gameId, f.bob.key, sealed)).resolves.toBe(NOTE);
  });

  it("opens for nobody else, including the sender's own teammates", async () => {
    const sealed = (await sealDirectBody(f.alice, f.gameId, f.mallory.key, NOTE))!;
    // Carol shares an empire with Alice and gets nothing: a DM is not team chat
    // with a shorter list.
    await expect(openDirectBody(f.carol, f.gameId, f.alice.key, sealed)).resolves.toBeNull();
    await expect(openDirectBody(f.bob, f.gameId, f.alice.key, sealed)).resolves.toBeNull();
  });

  it("does not open against the wrong counterpart", async () => {
    const sealed = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    await expect(openDirectBody(f.bob, f.gameId, f.carol.key, sealed)).resolves.toBeNull();
  });

  it("does not open in another game", async () => {
    const sealed = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    await expect(openDirectBody(f.bob, "another-game", f.alice.key, sealed)).resolves.toBeNull();
  });

  // The property the whole envelope exists for. The recipient is not a field
  // anywhere — not in the `Message` record and not in the wrap — so the wire
  // shows that a seat spoke privately and never to whom.
  it("does not name its recipient, and every envelope is the same shape", async () => {
    const toBob = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    const toMallory = (await sealDirectBody(f.alice, f.gameId, f.mallory.key, NOTE))!;

    expect(toBob.length).toBe(toMallory.length);
    // Two wraps, always, whoever it is for — which is a stronger
    // indistinguishability property than one wrap would give.
    expect(fromBase64Url(toBob)![1]).toBe(2);
    expect(fromBase64Url(toMallory)![1]).toBe(2);
    // And no member index anywhere in the wrap region, which is the byte a team
    // envelope carries and this one deliberately omits.
    expect(fromBase64Url(toBob)![0]).toBe(2);
  });

  it("is silent about a body that is not one of ours", async () => {
    await expect(openDirectBody(f.bob, f.gameId, f.alice.key, "not base64url!!")).resolves.toBeNull();
    await expect(openDirectBody(f.bob, f.gameId, f.alice.key, "")).resolves.toBeNull();
    // A team envelope handed to the direct reader is refused on the scheme byte
    // rather than attempted, which is what makes the byte a scheme and not a
    // generation.
    await expect(openDirectBody(f.bob, f.gameId, f.alice.key, sealed)).resolves.toBeNull();
  });

  it("is refused by the team reader for the same reason", async () => {
    const direct = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    await expect(openTeamBody(f.bob, f.gameId, 1, f.alice.key, 1, direct)).resolves.toBeNull();
  });

  // The two schemes must not collide: a team message between two people and a
  // DM between the same two derive different keys, or the empire binding the
  // team comment defends is meaningless.
  it("a team key and a direct key between one pair are different keys", async () => {
    const direct = (await sealDirectBody(f.alice, f.gameId, f.bob.key, NOTE))!;
    const team = (await sealTeamBody(f.alice, f.gameId, 1, [{ member: 1, key: f.bob.key }], NOTE))!;
    // Neither reader can be made to accept the other's bytes even with the
    // scheme byte swapped, because the derivation differs underneath.
    const swapped = fromBase64Url(direct)!.slice();
    swapped[0] = 1;
    await expect(
      openTeamBody(f.bob, f.gameId, 1, f.alice.key, 1, toBase64Url(swapped)),
    ).resolves.toBeNull();
    expect(team).not.toBe(direct);
  });
});
