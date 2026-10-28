// What counts as a game link.

import { describe, expect, it } from "vitest";
import { roomIdFrom } from "../net/room";

describe("roomIdFrom", () => {
  it("reads a full link", () => {
    expect(roomIdFrom("https://tessera.qot.nz/g/abc234def5")).toBe("abc234def5");
  });

  it("reads a path, with or without a trailing slash", () => {
    expect(roomIdFrom("/g/abc234def5")).toBe("abc234def5");
    expect(roomIdFrom("/g/abc234def5/")).toBe("abc234def5");
  });

  it("reads a bare code, trimmed", () => {
    expect(roomIdFrom("  abc234def5 ")).toBe("abc234def5");
  });

  it("refuses what is not a code", () => {
    expect(roomIdFrom("")).toBeNull();
    expect(roomIdFrom("not a code")).toBeNull();
  });
});
