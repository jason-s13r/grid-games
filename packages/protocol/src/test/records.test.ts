// What a signature is for.
//
// A signed move carries (empire, member) and the roster says which key sits
// there — so attribution is by seat, not by a key travelling in the message.
// Each record type is domain-separated and bound to one game id, which is what
// stops a signature meaning one thing here and another thing somewhere else.

import { beforeAll, describe, expect, it } from "vitest";
import type { Move } from "@tessera/sim";
import { toBase64Url } from "../bytes.js";
import {
  CHANNEL,
  encodeMessage,
  encodeMove,
  signMessage,
  signInvite,
  signMove,
  verifyMessage,
  verifyInvite,
  verifyMove,
} from "../records.js";
import type { SignedMove } from "../records.js";
import { claim, fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
let move: Move;
let signed: SignedMove;

const message = {
  step: 120,
  seq: 3,
  empire: 1,
  member: 0,
  channel: CHANNEL.PUBLIC,
  body: "hi",
};

beforeAll(async () => {
  f = await fixture();
  move = claim(120, 1, 0, 3, 10, 12);
  signed = await signMove(f.alice, f.gameId, move);
});

/** Every refusal below is the same shape: change one thing, expect false. */
const tampered = (patch: Partial<Move>): Promise<boolean> =>
  verifyMove(f.roster, f.gameId, { ...signed, move: { ...move, ...patch } });

describe("signed moves", () => {
  it("a member's own move verifies", async () => {
    await expect(verifyMove(f.roster, f.gameId, signed)).resolves.toBe(true);
  });

  it("a tampered coordinate is caught", async () => {
    await expect(tampered({ x: 11 })).resolves.toBe(false);
  });

  it("the step is not signed: the room decides it", async () => {
    await expect(tampered({ step: 121 })).resolves.toBe(true);
  });

  it("a tampered sequence number is caught", async () => {
    await expect(tampered({ seq: 4 })).resolves.toBe(false);
  });

  it("moving as a seat you do not hold is caught", async () => {
    await expect(tampered({ member: 1 })).resolves.toBe(false);
  });

  it("an out-of-range coordinate is refused, not truncated", async () => {
    await expect(tampered({ x: 65536 })).resolves.toBe(false);
  });

  it("nobody signs as neutral", async () => {
    await expect(tampered({ empire: 0 })).resolves.toBe(false);
  });

  it("an unknown move type is refused", async () => {
    await expect(tampered({ type: 99 as never })).resolves.toBe(false);
  });

  it("a non-roster key cannot act", async () => {
    const forged = await signMove(f.mallory, f.gameId, move);
    await expect(verifyMove(f.roster, f.gameId, forged)).resolves.toBe(false);
  });

  it("an empty seat cannot act", async () => {
    const bot = await signMove(f.alice, f.gameId, claim(120, 2, 0, 3, 1, 1));
    await expect(verifyMove(f.roster, f.gameId, bot)).resolves.toBe(false);
  });

  it("a move cannot be replayed into another game", async () => {
    await expect(verifyMove(f.roster, f.otherGame.gameId!, signed)).resolves.toBe(false);
  });

  it("a garbage signature verifies false rather than throwing", async () => {
    await expect(
      verifyMove(f.roster, f.gameId, { move, sig: "!!!not base64!!!" }),
    ).resolves.toBe(false);
  });
});

// Domain separation, checked from both directions: the signature does not carry
// across record types, and the payloads it is taken over are not equal either.
describe("domain separation", () => {
  it("a move signature is not a message signature", async () => {
    await expect(
      verifyMessage(f.roster, f.gameId, { message, sig: signed.sig }),
    ).resolves.toBe(false);
  });

  it("the two records encode differently", () => {
    expect(toBase64Url(encodeMove(f.gameId, move))).not.toBe(
      toBase64Url(encodeMessage(f.gameId, message)),
    );
  });
});

describe("chat", () => {
  it("a signed message verifies", async () => {
    const chat = await signMessage(f.bob, f.gameId, { ...message, member: 1, body: "on my way" });
    await expect(verifyMessage(f.roster, f.gameId, chat)).resolves.toBe(true);
  });

  it("an edited message is caught", async () => {
    const chat = await signMessage(f.bob, f.gameId, { ...message, member: 1, body: "on my way" });
    const edited = { ...chat, message: { ...chat.message, body: "on my way!" } };
    await expect(verifyMessage(f.roster, f.gameId, edited)).resolves.toBe(false);
  });

  it("an oversized body is refused", async () => {
    const chat = await signMessage(f.bob, f.gameId, { ...message, member: 1, body: "hi" });
    const huge = { ...chat, message: { ...chat.message, body: "x".repeat(4096) } };
    await expect(verifyMessage(f.roster, f.gameId, huge)).resolves.toBe(false);
  });
});

describe("invites", () => {
  const invite = () => ({ empire: 1, id: "abcdefghijklmnop", expires: 2_000_000_000, by: f.alice.key });

  it("verifies against the key it names", async () => {
    const signed = await signInvite(f.alice, f.gameId, invite());
    await expect(verifyInvite(f.gameId, signed)).resolves.toBe(true);
  });

  it("is refused when edited, retargeted or moved to another game", async () => {
    const signed = await signInvite(f.alice, f.gameId, invite());
    await expect(verifyInvite(f.gameId, { ...signed, invite: { ...signed.invite, empire: 2 } })).resolves.toBe(false);
    await expect(verifyInvite(f.gameId, { ...signed, invite: { ...signed.invite, by: f.bob.key } })).resolves.toBe(false);
    await expect(verifyInvite("another-game", signed)).resolves.toBe(false);
  });

  it("is a refusal, not a throw, for garbage", async () => {
    await expect(verifyInvite(f.gameId, { invite: null, sig: "x" } as never)).resolves.toBe(false);
  });
});
