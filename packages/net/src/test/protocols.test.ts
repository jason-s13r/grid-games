// Who gets greeted, and who gets dropped.
//
// The temptation is to read this as compatibility negotiation. It is not. A
// game is stamped at version N and every peer in it plays N, for the game's
// whole life — what a multi-version build gains is not the ability to talk
// across versions, it is the ability to *be* the version a game it already
// agreed to is on.
//
// So the one scenario that earns `canPlay` its place is the rejoin: a player
// goes away, the release ships, their client updates, and they dial back into
// the game they are still in. Without the supported set on the hello the host
// sees a stranger's version number and drops them before the genesis that
// would have settled it. Two builds meeting in an *empty* lobby dropping each
// other is the correct answer, not a gap.

import { describe, expect, it } from "vitest";
import { FRAME } from "@tessera/protocol";
import type { HelloFrame } from "@tessera/protocol";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS } from "@tessera/sim";
import { canPlay, explain } from "../lobby.js";
import type { Genesis } from "@tessera/sim";

const hello = (protocol: number, supported?: number[]): HelloFrame => ({
  t: FRAME.HELLO,
  protocol,
  ...(supported ? { supported } : {}),
  gameId: "",
  nonce: "n",
});

describe("canPlay", () => {
  it("greets a peer that plays the version at stake", () => {
    expect(canPlay(hello(4, [4, 3]), 4)).toBe(true);
    expect(canPlay(hello(4, [4, 3]), 3)).toBe(true);
  });

  it("drops a peer whose set does not reach the stake", () => {
    expect(canPlay(hello(3, [3]), 4)).toBe(false);
    expect(canPlay(hello(9, [9, 8]), 4)).toBe(false);
  });

  it("reads a hello with no set as a build that plays what it stamps", () => {
    // The old-build case: the field did not exist, so its absence means one
    // version, and this is the branch most likely to rot unnoticed.
    expect(canPlay(hello(3), 3)).toBe(true);
    expect(canPlay(hello(3), 4)).toBe(false);
  });

  it("lets a returning player on the newer build rejoin the older game", () => {
    // The whole reason the field is on the frame. Their build composes 4, the
    // room is running 3, and the stake is the room's.
    expect(canPlay(hello(3, [4, 3]), 3)).toBe(true);
  });

  it("still drops two builds that share no version", () => {
    expect(canPlay(hello(5, [5]), 3)).toBe(false);
  });
});

describe("the refusal a player reads", () => {
  const at = (protocol: number) => ({ protocol }) as Genesis;

  it("says nothing when the protocol was not the problem", () => {
    expect(explain(at(PROTOCOL_VERSION), ["seats"])).toBe("");
  });

  it("names both versions, so neither side is a guess", () => {
    const said = explain(at(99), ["protocol"]);
    expect(said).toContain("v99");
    expect(said).toContain(`v${PROTOCOL_VERSION}`);
  });

  it("tells a behind client to update", () => {
    expect(explain(at(PROTOCOL_VERSION + 1), ["protocol"])).toContain("update");
  });

  it("tells a client whose game has aged out that it has", () => {
    const oldest = SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1]!;
    expect(explain(at(oldest - 1), ["protocol"])).toContain("no longer plays");
  });
});
