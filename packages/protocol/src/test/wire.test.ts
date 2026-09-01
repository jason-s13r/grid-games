// The wire, and the handshake that opens it.
//
// A peer can send whatever it likes, so the decoder's job is to be unsurprising:
// anything malformed becomes null and is never heard, and nothing a stranger
// sends can throw on the receiving side.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim } from "@tessera/sim";
import { proveHello, signMove, verifyHello, verifyMove } from "../records.js";
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
  ])("%s decodes to nothing", (_label, text) => {
    expect(decodeFrame(text)).toBeNull();
  });
});

// Signing, framing, parsing, verification, and then the simulation deciding.
// The last step is the point: a signature says who sent a move, never that the
// move is legal — that judgement belongs to the rules, on every peer alike.
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
