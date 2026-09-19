// The board URL is refused in the field, or it is refused nowhere useful.
//
// A board on http read from a page on https is blocked by the browser before a
// byte leaves, and what arrives is a `TypeError` with no message, from a fetch
// several screens away from the field that caused it. By then the reason is
// gone. So the rule lives at the point of entry, and this is the file that pins
// it — including the half that is easy to get wrong in the other direction: the
// same URL is perfectly good from `pnpm dev`, which serves this client over
// http, and a client that refused it everywhere would have broken local
// development to protect a deployment.

import { beforeEach, describe, expect, it } from "vitest";
import { parseRef } from "@tessera/net";
import {
  checkBoardUrl,
  checkFactoryUrl,
  checkRefForPage,
  resetSettings,
  saveSettings,
  settings,
} from "../net/settings";

describe("the board URL is checked on entry", () => {
  it("accepts an https board from an https page", () => {
    expect(checkBoardUrl("https://board.example/games", "https:")).toBe("");
  });

  it("accepts an http board from an http page", () => {
    // `pnpm dev` is http://localhost, and a board on the same LAN is the normal
    // case there. Refusing this would be protecting a deployment by breaking
    // development.
    expect(checkBoardUrl("http://192.168.1.10:8787/games", "http:")).toBe("");
  });

  it("refuses an http board from an https page, and says which side is the problem", () => {
    const problem = checkBoardUrl("http://board.example/games", "https:");
    expect(problem).toContain("this page is served over https");
    // The page is what cannot read it; the board is fine. A player told only
    // "could not read that board" would go and check the board.
    expect(problem).toContain("headless peer");
  });

  it("refuses a string that is not a URL", () => {
    expect(checkBoardUrl("board.example", "https:")).toContain("is not a URL");
  });

  it("refuses a URL that is not http", () => {
    // A room link and a board are different things and get typed into each
    // other's fields constantly.
    expect(checkBoardUrl("wss://relay.example/tessera/abc234", "https:")).toContain(
      "not wss",
    );
  });

  it("accepts an empty board, because that is the default", () => {
    // There is no board shipped with this client and no default URL, so empty
    // is the normal state rather than an unfinished one.
    expect(checkBoardUrl("", "https:")).toBe("");
    expect(checkBoardUrl("   ", "https:")).toBe("");
  });
});

describe("the settings store", () => {
  beforeEach(() => resetSettings());

  it("starts empty", () => {
    expect(settings()).toEqual({ board: "", factory: "", rankFrom: [], rankService: "" });
  });

  it("keeps what was written and leaves the rest alone", () => {
    saveSettings({ board: "https://board.example/games" });
    expect(settings().board).toBe("https://board.example/games");
    expect(settings().factory).toBe("");
  });

  it("hands out a copy, so a reader cannot edit what the next reader sees", () => {
    saveSettings({ rankFrom: ["https://host.example"] });
    settings().rankFrom.push("https://mine.example");
    expect(settings().rankFrom).toEqual(["https://host.example"]);
  });
});

describe("the join box refuses a room this page cannot open", () => {
  it("takes a room code, which no page protocol can object to", () => {
    // A WebRTC room is a data channel, not a socket the page opens by URL.
    expect(checkRefForPage(parseRef("tsr-abc234"), "https:")).toBe("");
  });

  it("takes a wss:// room from an https page", () => {
    expect(checkRefForPage(parseRef("wss://relay.example/tessera/abc234"), "https:")).toBe("");
  });

  it("refuses a ws:// room from an https page, and says the page is the problem", () => {
    // The ref is fine. 0003 accepts it and 0006 keeps it legal on purpose — a
    // LAN, a Tailscale address, a host on 127.0.0.1. It is this page that
    // cannot open it, and the browser's own report is a bare TypeError.
    const problem = checkRefForPage(parseRef("ws://192.168.1.10:8080/abc234"), "https:");
    expect(problem).toContain("can only open wss:// rooms");
    expect(problem).toContain("headless peer");
  });

  it("takes the same ws:// room from an http page, which is pnpm dev", () => {
    // This is why the rule is not in parseRef: the same client served from
    // http://localhost joins that room perfectly well.
    expect(checkRefForPage(parseRef("ws://192.168.1.10:8080/abc234"), "http:")).toBe("");
  });
});

describe("the host service URL is checked the same way, and says different things", () => {
  it("is fine while it is empty, which is the default and hides the option", () => {
    expect(checkFactoryUrl("")).toBe("");
  });

  it("takes an https service from an https page", () => {
    expect(checkFactoryUrl("https://hosts.example", "https:")).toBe("");
  });

  it("refuses an http service from an https page, and says posting is the problem", () => {
    // Not the same sentence as the board's, and that is the point of it being a
    // separate function: a board is read and a service is posted to, and the way
    // out of each is different. There is no headless anything that will use
    // somebody's factory on your behalf.
    const problem = checkFactoryUrl("http://hosts.example", "https:");
    expect(problem).toContain("can only post to an https:// host service");
    expect(problem).not.toContain("address book");
  });

  it("takes the same http service from an http page, which is pnpm dev", () => {
    expect(checkFactoryUrl("http://localhost:8787", "http:")).toBe("");
  });

  it("refuses a string that is not a URL, and shows what one looks like", () => {
    expect(checkFactoryUrl("hosts.example")).toContain("https://hosts.example");
  });

  it("refuses a scheme nothing here could post to", () => {
    expect(checkFactoryUrl("ftp://hosts.example")).toContain("not ftp");
  });
});
