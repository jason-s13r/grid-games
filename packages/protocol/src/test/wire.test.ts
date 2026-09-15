// The wire, and the handshake that opens it.
//
// A peer can send whatever it likes, so the decoder's job is to be unsurprising:
// anything malformed becomes null and is never heard, and nothing a stranger
// sends can throw on the receiving side.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim } from "@tessera/sim";
import {
  proveHello,
  signApplication,
  signClaim,
  signMove,
  verifyHello,
  verifyMove,
} from "../records.js";
import type { SignedMove } from "../records.js";
import { randomBytes } from "../identity.js";
import { FRAME, decodeFrame, encodeFrame } from "../wire.js";
import { claim, fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
let signed: SignedMove;

beforeAll(async () => {
  f = await fixture();
  signed = await signMove(f.alice, f.gameId, claim(120, 1, 0, 3, 10, 12));
});

describe("handshake", () => {
  let mine: Uint8Array;
  let theirs: Uint8Array;
  let proof: string;

  beforeAll(async () => {
    mine = randomBytes(16);
    theirs = randomBytes(16);
    proof = await proveHello(f.alice, f.gameId, theirs, mine);
  });

  it("a fresh proof verifies", async () => {
    await expect(verifyHello(f.alice.key, f.gameId, theirs, mine, proof)).resolves.toBe(true);
  });

  it("does not replay with the nonces swapped", async () => {
    await expect(verifyHello(f.alice.key, f.gameId, mine, theirs, proof)).resolves.toBe(false);
  });

  it("does not carry to another game", async () => {
    await expect(
      verifyHello(f.alice.key, f.otherGame.gameId!, theirs, mine, proof),
    ).resolves.toBe(false);
  });

  it("does not carry to another key", async () => {
    await expect(verifyHello(f.bob.key, f.gameId, theirs, mine, proof)).resolves.toBe(false);
  });
});

describe("framing", () => {
  it("a move frame round-trips", () => {
    expect(decodeFrame(encodeFrame({ t: FRAME.MOVE, signed }))?.t).toBe(FRAME.MOVE);
  });

  it("the payload survives intact", () => {
    const back = decodeFrame(encodeFrame({ t: FRAME.MOVE, signed }));
    expect(back?.t === FRAME.MOVE ? back.signed.sig : "").toBe(signed.sig);
  });

  it("a genesis frame round-trips", () => {
    expect(decodeFrame(encodeFrame({ t: FRAME.GENESIS, genesis: f.genesis }))?.t).toBe(
      FRAME.GENESIS,
    );
  });

  it.each([
    ["malformed json", "{"],
    ["an unknown frame type", '{"t":"attack"}'],
    ["a frame missing its payload", '{"t":"move"}'],
    ["a non-object", '"move"'],
    ["a hello without a nonce", '{"t":"hello","protocol":1,"gameId":"a"}'],
    ["a negative snapshot step", '{"t":"snapshot?","step":-1}'],
    [
      "a hello whose supported set is not an array",
      '{"t":"hello","protocol":3,"gameId":"a","nonce":"n","supported":3}',
    ],
    [
      "a hello whose supported set holds something else",
      '{"t":"hello","protocol":3,"gameId":"a","nonce":"n","supported":[3,"4"]}',
    ],
  ])("%s decodes to nothing", (_label, text) => {
    expect(decodeFrame(text)).toBeNull();
  });

  it("a hello carries its supported set across", () => {
    const back = decodeFrame(
      encodeFrame({
        t: FRAME.HELLO,
        protocol: 3,
        supported: [4, 3],
        gameId: f.gameId,
        nonce: "n",
      }),
    );
    expect(back?.t === FRAME.HELLO ? back.supported : null).toEqual([4, 3]);
  });

  it("a hello from a build that predates the field still decodes", () => {
    // The old-build case, and the one most likely to rot unnoticed: absent is
    // not malformed, and canPlay reads it as [protocol].
    const back = decodeFrame('{"t":"hello","protocol":3,"gameId":"a","nonce":"n"}');
    expect(back?.t).toBe(FRAME.HELLO);
    expect(back?.t === FRAME.HELLO ? back.supported : "set").toBeUndefined();
  });
});

// Signing, framing, parsing, verification, and then the simulation deciding.
// The last step is the point: a signature says who sent a move, never that the
// move is legal — that judgement belongs to the rules, on every peer alike.
describe("a claim on the wire", () => {
  it("round-trips, carrying one signature rather than a tally", async () => {
    const signed = await signClaim(f.mallory, f.gameId, { empire: 3, step: 240 });
    const back = decodeFrame(encodeFrame({ t: FRAME.CLAIM, signed }));
    expect(back?.t).toBe(FRAME.CLAIM);
  });

  it("is null rather than a throw when there is nothing to verify", () => {
    // Field-level checking belongs to `verifyClaim`, which has to re-derive the
    // payload anyway. All this layer asks is whether there is a record here at
    // all — and it answers with null, never an exception, because a malformed
    // frame arrives from a stranger and must not be able to stop a driver.
    expect(decodeFrame('{"t":"claim"}')).toBeNull();
    expect(decodeFrame('{"t":"claim","signed":"not an object"}')).toBeNull();
    expect(decodeFrame('{"t":"claim","signed":{}}')?.t).toBe(FRAME.CLAIM);
  });
});

describe("an application on the wire", () => {
  it("round-trips", async () => {
    const signed = await signApplication(f.mallory, f.gameId, { empire: 1, step: 240 });
    expect(decodeFrame(encodeFrame({ t: FRAME.APPLICATION, signed }))?.t).toBe(FRAME.APPLICATION);
  });

  it("is null rather than a throw when there is nothing to verify", () => {
    expect(decodeFrame('{"t":"application"}')).toBeNull();
    expect(decodeFrame('{"t":"application","signed":7}')).toBeNull();
  });

  it("is simply not heard by a build that does not know the frame", () => {
    // The additive-frame rule, from the other side. `decodeFrame` answers null
    // for an unrecognised `t`, and both carriers drop a null frame without
    // complaint — so an older peer never sees this, never counts it as a
    // violation, and behaves exactly as it does today.
    expect(decodeFrame('{"t":"something-from-next-year","signed":{}}')).toBeNull();
  });
});

describe("wire to simulation", () => {
  it("a move survives the whole path, and the sim is what judges it", async () => {
    const live = new Sim(f.genesis);
    const target = live.state.empires[0]!.capital + 1;
    const play = claim(
      live.step,
      1,
      0,
      0,
      target % live.state.width,
      Math.floor(target / live.state.width),
    );

    const back = decodeFrame(
      encodeFrame({ t: FRAME.MOVE, signed: await signMove(f.alice, f.gameId, play) }),
    );
    expect(back?.t).toBe(FRAME.MOVE);
    await expect(
      verifyMove(f.roster, f.gameId, (back as { signed: SignedMove }).signed),
    ).resolves.toBe(true);
    expect(typeof live.validate((back as { signed: SignedMove }).signed.move)).toBe("boolean");
  });
});
