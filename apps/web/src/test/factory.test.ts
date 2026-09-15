// Backend 3, which is a request shape with no server behind it.
//
// Nothing in this series builds a managed factory, so what is worth testing is
// not "does it work against a service" — there is none — but the two things that
// are true regardless of who eventually writes one. A factory is told what we
// intend to run and decides nothing about it; and every way a service can be
// unhelpful produces a sentence a player can act on rather than a silence.
//
// The second is most of the file, and deliberately. This is the only outbound
// POST in the client, it is cross-origin by construction, and a CORS refusal is
// indistinguishable from a service being down — so "it did not work" is the one
// answer that must never be all the player is given.

import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, durationRules, hours } from "@tessera/sim";
import { askForRoom, FACTORY_CAP } from "../net/factory";

const FACTORY = "https://hosts.example";

const plan = { width: 160, height: 112, simbots: [], duration: durationRules(hours(3)) };

const answering = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      statusText: status === 503 ? "Service Unavailable" : "",
    })) as unknown as typeof fetch;

describe("what the tab asks for", () => {
  it("posts the protocol and the plan to /rooms", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const http: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ refs: ["wss://host.example/blue-fox"] }));
    };

    await askForRoom(FACTORY, plan, http);
    expect(seen[0]!.url).toBe("https://hosts.example/rooms");
    expect(seen[0]!.init?.method).toBe("POST");

    const body = JSON.parse(String(seen[0]!.init?.body)) as { protocol: number; plan: typeof plan };
    // The protocol is the one field the service can act on usefully: an instance
    // that cannot play this version is one it should decline to start.
    expect(body.protocol).toBe(PROTOCOL_VERSION);
    expect(body.plan.width).toBe(160);
    // And no roster. Nobody has arrived yet, and the record that finally gets
    // sealed is composed by this tab afterwards — the plan here is a hint about
    // what is coming, and nothing signs it.
    expect(body.plan).not.toHaveProperty("empires");
  });

  it("does not care whether the URL had a trailing slash", async () => {
    const seen: string[] = [];
    const http: typeof fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ refs: ["wss://host.example/blue-fox"] }));
    };
    await askForRoom("https://hosts.example/", plan, http);
    expect(seen[0]).toBe("https://hosts.example/rooms");
  });
});

describe("what comes back", () => {
  it("parses the doors, in the order the service listed them", async () => {
    const room = await askForRoom(
      FACTORY,
      plan,
      answering({ refs: ["wss://host.example/blue-fox", "tsr-abc234"] }),
    );
    expect(room.refs).toEqual([
      { kind: "socket", url: "wss://host.example", room: "blue-fox" },
      { kind: "rtc", code: "tsr-abc234" },
    ]);
  });

  it("keeps a door it could not read, rather than pretending it was not offered", async () => {
    const room = await askForRoom(
      FACTORY,
      plan,
      answering({ refs: ["wss://host.example/blue-fox", "quic://something/newer"] }),
    );
    expect(room.refs).toHaveLength(1);
    expect(room.unreadable).toEqual(["quic://something/newer"]);
  });

  it("carries a resume URL through without acting on it", async () => {
    // Nothing in the create flow resumes — a room made a second ago has nothing
    // to resume — and dropping the field silently is how a seam stops being one.
    const room = await askForRoom(
      FACTORY,
      plan,
      answering({ refs: ["tsr-abc234"], resume: "https://host.example/room/blue-fox/resume" }),
    );
    expect(room.resume).toBe("https://host.example/room/blue-fox/resume");
  });
});

describe("every way a service can be unhelpful says so", () => {
  const fails = async (http: typeof fetch): Promise<string> => {
    try {
      await askForRoom(FACTORY, plan, http);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected that to fail");
  };

  it("says which URL it could not reach, and that CORS looks the same as down", async () => {
    const refused: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const message = await fails(refused);
    expect(message).toContain("https://hosts.example/rooms");
    expect(message).toContain("not allow this page to post to it");
  });

  it("quotes the status a service refused with", async () => {
    expect(await fails(answering({ error: "busy" }, 503))).toContain("503");
  });

  it("says a body that is not a room is not a room", async () => {
    expect(await fails(answering({ ok: true }))).toContain("not a room");
    expect(await fails(answering("<html>hello</html>"))).toContain("not JSON");
  });

  it("refuses to buffer a service that answers forever", async () => {
    const flood = answering(JSON.stringify({ refs: ["x".repeat(FACTORY_CAP)] }));
    expect(await fails(flood)).toContain("more than a room's worth");
  });

  it("distinguishes no rooms from rooms this build cannot open", async () => {
    expect(await fails(answering({ refs: [] }))).toContain("no rooms");
    // The difference matters: one of these is fixed by updating.
    expect(await fails(answering({ refs: ["quic://something/newer"] }))).toContain("newer build");
  });
});
