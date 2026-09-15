// Backend 2's guard: may this tab be the one to seal the record?
//
// The mechanism it is guarding was never absent. `Lobby.host` checks the plan
// and nothing about the phase, and `adopt` accepts whichever GENESIS frame
// arrives while the lobby is not playing — so any peer in a room has always been
// able to seal a game and broadcast it. What kept that from mattering is that
// only one peer had a button. This plan gives a second peer the button, and the
// guard is what stops the obvious way of using it wrongly: composing a second
// game into a room that already has one.
//
// The property under all of it is that **not knowing is a no**. A host that did
// not answer, answered 404, or answered something that is not a status might be
// running a game; treating any of those as "empty" would produce exactly the
// split this exists to prevent. So every failure below asserts the same thing,
// and that is not repetition — each is a different way for a room to go quiet.

import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "@tessera/net";
import { mayCompose, roomStatus, statusUrl } from "../net/compose";

const SOCKET: ConnectionRef = { kind: "socket", url: "wss://host.example", room: "blue-fox" };

const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const empty = { gameId: "", step: 0, peers: 1, ended: false };

describe("where a room reports its state", () => {
  it("is the ws origin with the scheme swapped, because one port carries both", () => {
    expect(statusUrl(SOCKET)).toBe("https://host.example/room/blue-fox");
  });

  it("keeps a path prefix, for a host behind a proxy", () => {
    expect(statusUrl({ kind: "socket", url: "wss://edge.example/tessera", room: "blue-fox" })).toBe(
      "https://edge.example/tessera/room/blue-fox",
    );
  });

  it("is nowhere at all for a WebRTC room", () => {
    // The room is another tab. There is nothing in front of it to ask, and the
    // code came from a person who already knew what was behind it.
    expect(statusUrl({ kind: "rtc", code: "tsr-abc234" })).toBeUndefined();
  });
});

describe("what the room said", () => {
  it("reads an empty room", async () => {
    expect(await roomStatus(SOCKET, answering(empty))).toEqual(empty);
  });

  it("reads a room with a game in it", async () => {
    const status = await roomStatus(SOCKET, answering({ ...empty, gameId: "abc123", step: 900 }));
    expect(status?.gameId).toBe("abc123");
    expect(status?.step).toBe(900);
  });

  it("knows nothing when the host has never heard of the room", async () => {
    expect(
      await roomStatus(SOCKET, answering({ error: "no game is running here" }, 404)),
    ).toBeUndefined();
  });

  it("knows nothing when nothing answers", async () => {
    const refused: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await roomStatus(SOCKET, refused)).toBeUndefined();
  });

  it("knows nothing when the answer is not the shape it claims to be", async () => {
    expect(await roomStatus(SOCKET, answering({ gameId: 7 }))).toBeUndefined();
    expect(await roomStatus(SOCKET, answering("not json at all"))).toBeUndefined();
  });

  it("knows nothing about a WebRTC room without asking anybody", async () => {
    let asked = false;
    const watching: typeof fetch = async () => {
      asked = true;
      return new Response("{}", { status: 200 });
    };
    expect(await roomStatus({ kind: "rtc", code: "tsr-abc234" }, watching)).toBeUndefined();
    expect(asked).toBe(false);
  });
});

describe("whether this tab may compose", () => {
  it("may, in a room that says it has no game", () => {
    expect(mayCompose(empty)).toBe(true);
  });

  it("may not, in a room that has already sealed one", () => {
    // The empty string rather than an absent field: that is what 0006 answers
    // before a record exists, and a check against `undefined` would call every
    // running game composable.
    expect(mayCompose({ ...empty, gameId: "abc123" })).toBe(false);
  });

  it("may not, in a room whose game is over", () => {
    expect(mayCompose({ ...empty, ended: true })).toBe(false);
  });

  it("may not when nobody said anything", () => {
    // The whole rule in one assertion. A host that did not answer might be
    // running a game, and a second record in a room that has one splits it with
    // no error anywhere.
    expect(mayCompose(undefined)).toBe(false);
  });
});
