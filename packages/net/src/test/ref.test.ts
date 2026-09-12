// The parse table, and the one property that holds over it.
//
// A ref is the only place a player's typing becomes a network decision, so the
// interesting half of this file is the refusals: every one of them has to name
// what a valid reference looks like, because the alternative is a join box that
// says "invalid" and leaves somebody guessing which of the two forms they got
// wrong.

import { describe, expect, it } from "vitest";
import { formatRef, isRoomName, parseRef } from "../ref.js";

const ACCEPTED = [
  "tsr-abc234",
  "nightwatch",
  "a",
  "A-_0",
  "x".repeat(64),
  "wss://h/tessera/r",
  "wss://h:8443/r",
  "ws://localhost:9000/dev/r",
  "wss://[::1]:8443/tessera/r",
];

describe("parseRef", () => {
  it("reads a bare name as a peer id, verbatim", () => {
    expect(parseRef("tsr-abc234")).toEqual({ kind: "rtc", code: "tsr-abc234" });
    // The prefix is a minting convention, not a wire format: an observer run
    // with `--as nightwatch` is dialled at exactly that.
    expect(parseRef("nightwatch")).toEqual({ kind: "rtc", code: "nightwatch" });
  });

  it("trims, because a pasted code brings whitespace with it", () => {
    expect(parseRef("  tsr-abc234\n")).toEqual({ kind: "rtc", code: "tsr-abc234" });
  });

  it("splits a room link into a server and the last path segment", () => {
    expect(parseRef("wss://relay.example/tessera/abc234")).toEqual({
      kind: "socket",
      url: "wss://relay.example/tessera",
      room: "abc234",
    });
    expect(parseRef("wss://relay.example/abc234")).toEqual({
      kind: "socket",
      url: "wss://relay.example",
      room: "abc234",
    });
  });

  it("keeps a port, and brackets an IPv6 host — which is why this is not a split", () => {
    expect(parseRef("wss://relay.example:8443/t/r")).toEqual({
      kind: "socket",
      url: "wss://relay.example:8443/t",
      room: "r",
    });
    expect(parseRef("wss://[::1]:8443/t/r")).toEqual({
      kind: "socket",
      url: "wss://[::1]:8443/t",
      room: "r",
    });
  });

  it("allows ws:// for a relay on localhost", () => {
    // Useless against a real player — a page on https cannot open a plaintext
    // socket, and the browser blocks it before any of our code runs — and
    // exactly right for `pnpm dev` against a room bus on this machine.
    expect(parseRef("ws://localhost:9000/dev/r").kind).toBe("socket");
  });

  it("ignores a trailing slash", () => {
    expect(parseRef("wss://h/tessera/r/")).toEqual({
      kind: "socket",
      url: "wss://h/tessera",
      room: "r",
    });
  });

  it("names the alternative in every refusal", () => {
    const refusals: Array<[string, RegExp]> = [
      ["", /nothing to join/],
      ["   ", /nothing to join/],
      ["hello there", /is not a room/],
      ["tsr-abc!234", /is not a room/],
      ["x".repeat(65), /is not a room/],
      ["http://h/r", /is not a room/],
      ["./archives/abc", /is not a room/],
      ["wss://h", /names a server but no room/],
      ["wss://h/", /names a server but no room/],
      ["wss://h/r?x=1", /no query or fragment/],
      ["wss://h/r#f", /no query or fragment/],
      ["wss://h/a b", /is not a room name/],
    ];
    for (const [input, message] of refusals) {
      expect(() => parseRef(input), input || "(empty)").toThrow(message);
    }
  });

  it("resolves a path traversal rather than refusing it", () => {
    // 0003's verification table expects `wss://h/../r` to be refused. It is
    // not, and the reason is the parser it also asks for: `new URL` resolves
    // `/../r` to `/r` before this code sees a pathname, so the ref is an
    // ordinary one naming room `r`. Nothing traversable survives — a room name
    // is checked against the charset, so `..` can never *be* the room — and
    // refusing it would mean re-implementing path resolution to reject a string
    // that is already harmless.
    expect(parseRef("wss://h/../r")).toEqual({ kind: "socket", url: "wss://h", room: "r" });
    expect(() => parseRef("wss://h/a/..")).toThrow(/names a server but no room/);
  });

  it("refuses `tsr-` with nothing after it as a room nobody minted", () => {
    // It parses as a name — the charset allows it — and it is still not a room
    // any broker handed out. The charset is the parser's job and the emptiness
    // is the minter's, so this is documented rather than enforced here.
    expect(parseRef("tsr-")).toEqual({ kind: "rtc", code: "tsr-" });
  });
});

describe("formatRef", () => {
  it("is stable under reparsing, for everything that parses", () => {
    // Not `format(parse(s)) === s`: parsing normalises scheme and host case
    // through `URL`, so `WSS://Relay.Example/t/r` comes back lowercased. The
    // property that matters is that printing a ref and typing it back in
    // reaches the same room.
    for (const input of ACCEPTED) {
      const once = formatRef(parseRef(input));
      expect(formatRef(parseRef(once)), input).toBe(once);
      expect(parseRef(once), input).toEqual(parseRef(input));
    }
  });

  it("normalises rather than round-trips exactly", () => {
    expect(formatRef(parseRef("WSS://Relay.Example/T/r"))).toBe("wss://relay.example/T/r");
  });
});

describe("isRoomName", () => {
  it("is the one charset both transports share", () => {
    // What lets a listing row offer the same room as `tsr-abc234` and as
    // `wss://relay.example/tessera/abc234` without a mapping table.
    expect(isRoomName("abc234")).toBe(true);
    expect(isRoomName("a b")).toBe(false);
    expect(isRoomName("")).toBe(false);
  });
});
