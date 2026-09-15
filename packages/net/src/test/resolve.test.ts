// A game id, and the three things that can be true about it.
//
// Somebody is in the room and it answers. Nobody is in the room, but a majority
// of its own seats signed for a state a keeper still holds. Or it is gone, and
// the useful part of that answer is *why* — a door that did not answer and a
// resume point one signature short are both "gone" and they are not the same
// news.
//
// The middle case is the one the address book exists for. A game everybody left
// on Tuesday has no peer to dial, and before resume points it had nothing else
// either: the row would point at a dead ref and a client would report a dead
// game. What makes the difference safe is that the point is checked here, before
// anything adopts it, against the roster in the genesis the board supplied —
// which was itself re-derived before the row was returned.

import { describe, expect, it } from "vitest";
import { CONTROL, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Identity, sealGenesis, signCheckpoint } from "@tessera/protocol";
import { Directory } from "../directory.js";
import type { Listing } from "../directory.js";
import { resolve } from "../resolve.js";
import type { ResumePoint } from "../resume.js";

const BOARD = "https://board.example/games";
const POINT = "https://keeper.example/room/abc234/resume";
const STEP = 480;
const HASH = 0x2ad0f19b;

interface Game {
  genesis: Genesis;
  seats: Array<{ identity: Identity; empire: number; member: number }>;
}

async function game(count: number): Promise<Game> {
  const seats: Game["seats"] = [];
  const empires = [];
  for (let index = 0; index < count; index++) {
    const identity = await Identity.generate();
    seats.push({ identity, empire: index + 1, member: 0 });
    empires.push({
      control: CONTROL.HUMAN,
      members: [{ kind: MEMBER.HUMAN, key: identity.key }],
    });
  }
  const genesis = await sealGenesis(
    makeGenesis({ seed: 5, startedAt: 1_700_000_000_000, map: { width: 32, height: 32 }, empires }),
  );
  return { genesis, seats };
}

/** A point with real signatures from `endorsing` of the seats. The bytes are a
 *  placeholder on purpose: `verifyResumePoint` never reads them, and the half
 *  that does is `Lockstep.resume`, which is the caller's. */
async function point(g: Game, endorsing: number, step = STEP): Promise<ResumePoint> {
  const witnesses = [];
  for (const seat of g.seats.slice(0, endorsing)) {
    witnesses.push(
      await signCheckpoint(seat.identity, g.genesis.gameId!, {
        step,
        hash: HASH,
        empire: seat.empire,
        member: seat.member,
      }),
    );
  }
  return { step, hash: HASH, data: "AAAA", amendments: [], drops: [], witnesses };
}

/** A board and a keeper behind one fetch, because that is how a client sees
 *  them: two strangers with URLs. */
function world(rows: Listing[], points: Record<string, ResumePoint | number>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.startsWith(BOARD)) {
      const id = url.startsWith(`${BOARD}/`) ? decodeURIComponent(url.slice(BOARD.length + 1)) : "";
      const body = id ? rows.filter((one) => one.gameId === id) : rows;
      return new Response(JSON.stringify({ games: body }), { status: 200 });
    }
    const held = points[url];
    if (held === undefined) return new Response("no", { status: 404 });
    if (typeof held === "number") return new Response("no", { status: held });
    return new Response(JSON.stringify(held), { status: 200 });
  };
}

const row = (g: Game, over: Partial<Listing> = {}): Listing => ({
  gameId: g.genesis.gameId!,
  genesis: g.genesis,
  refs: ["tsr-abc234"],
  ...over,
});

const never = async (): Promise<boolean> => false;

describe("resolving a game id", () => {
  it("dials the first door that answers", async () => {
    const g = await game(2);
    const directory = new Directory(BOARD, { fetch: world([row(g, { refs: ["tsr-dead", "wss://relay.example/t/live"] })], {}) });

    const knocked: string[] = [];
    const route = await resolve(directory, g.genesis.gameId!, {
      probe: async (ref) => {
        knocked.push(ref.kind);
        return ref.kind === "socket";
      },
    });

    expect(route.kind).toBe("dial");
    // In announced order, and no ranking between transports: a fallback ladder
    // is what 0003 refused, and every door leads to the same game anyway.
    expect(knocked).toEqual(["rtc", "socket"]);
    if (route.kind === "dial") expect(route.ref).toEqual({ kind: "socket", url: "wss://relay.example/t", room: "live" });
  });

  it("falls through to a resume point when nobody is home", async () => {
    const g = await game(3);
    const kept = await point(g, 2);
    const directory = new Directory(BOARD, {
      fetch: world([row(g, { resume: POINT })], { [POINT]: kept }),
    });

    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("resume");
    if (route.kind !== "resume") return;
    expect(route.tally).toMatchObject({ ok: true, endorsed: 2, needed: 2 });
    expect(route.point.step).toBe(STEP);
    // Handed over rather than adopted: only the caller has a driver, and the
    // bytes are still unchecked at this point.
    expect(route.point.data).toBe("AAAA");
  });

  it("reports the tally when the only point kept is short of a quorum", async () => {
    const g = await game(3);
    const directory = new Directory(BOARD, {
      fetch: world([row(g, { resume: POINT })], { [POINT]: await point(g, 1) }),
    });

    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("gone");
    if (route.kind !== "gone") return;
    // "gone" with a number a player can act on: one of the two seats that could
    // still sign said this happened, which is a different situation from a game
    // nobody kept anything for.
    expect(route.problems.join(" ")).toMatch(/has 1 of the 2 signatures it needs/);
  });

  it("prefers the furthest point when two keepers answer", async () => {
    const g = await game(3);
    // Both endorsed, both honest: a keeper that stopped two minutes earlier is
    // the normal case, not a broken one, and the later state is simply worth
    // more to whoever resumes it.
    const behind = await point(g, 2, STEP - 120);
    const ahead = await point(g, 2);
    const second = "https://other.example/room/x/resume";
    const directory = new Directory(BOARD, {
      fetch: world(
        [row(g, { resume: second }), row(g, { resume: POINT })],
        { [second]: behind, [POINT]: ahead },
      ),
    });

    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("resume");
    if (route.kind !== "resume") return;
    expect(route.point.step).toBe(STEP);
    expect(route.point.witnesses).toHaveLength(2);
  });

  it("says so when the board has never heard of the game", async () => {
    const g = await game(2);
    const directory = new Directory(BOARD, { fetch: world([], {}) });
    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("gone");
    if (route.kind !== "gone") return;
    expect(route.problems[0]).toMatch(/never|no board/i);
  });

  it("names the doors that did not answer, and the ones it could not read", async () => {
    const g = await game(2);
    const directory = new Directory(BOARD, {
      fetch: world([row(g, { refs: ["tsr-abc234", "quic://tomorrow/room"] })], {}),
    });

    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("gone");
    if (route.kind !== "gone") return;
    const said = route.problems.join("\n");
    expect(said).toMatch(/tsr-abc234 did not answer/);
    expect(said).toMatch(/quic:\/\/tomorrow\/room/);
  });

  it("treats a keeper with nothing kept yet as silence, not as a problem", async () => {
    const g = await game(2);
    const directory = new Directory(BOARD, {
      // 404 is what 0006's host peer answers before the first snapshot lands.
      fetch: world([row(g, { resume: POINT })], { [POINT]: 404 }),
    });
    const route = await resolve(directory, g.genesis.gameId!, { probe: never });
    expect(route.kind).toBe("gone");
    if (route.kind !== "gone") return;
    expect(route.problems.join(" ")).not.toMatch(/404/);
  });

  it("carries the listing through so the caller can pass expect to the lobby", async () => {
    const g = await game(2);
    const directory = new Directory(BOARD, { fetch: world([row(g)], {}) });
    const route = await resolve(directory, g.genesis.gameId!, { probe: async () => true });
    // The whole reason this returns a ref and not a connection: the caller
    // dials with `expect: listing.gameId`, and arriving somewhere else is a
    // refusal rather than a game.
    if (route.kind === "dial") expect(route.listing.gameId).toBe(g.genesis.gameId);
    else expect.unreachable("a door answered");
  });
});
