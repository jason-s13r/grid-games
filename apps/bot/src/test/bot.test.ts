import { describe, expect, it } from "vitest";
import { Sim, STEPS_PER_SECOND, humans, makeGenesis, simbot } from "@tessera/sim";
import { Bot, dutyCycle, hoursWindow } from "../bot";
import { parseLink } from "../link";

describe("parseLink", () => {
  it("finds the room and its socket", () => {
    expect(parseLink("https://tessera.qot.nz/g/abc123")).toEqual({
      socket: "wss://tessera.qot.nz/game/abc123/ws",
      roomId: "abc123",
    });
    expect(parseLink("http://localhost:8787/g/abcd/")).toMatchObject({ socket: "ws://localhost:8787/game/abcd/ws" });
  });

  it("reads an invite", () => {
    const invite = { invite: { room: "abc123" }, sig: "x" };
    const text = Buffer.from(JSON.stringify(invite)).toString("base64url");
    expect(parseLink(`https://tessera.qot.nz/g/abc123?invite=${text}`)).toMatchObject({ invite });
  });

  it("refuses what is not a game link", () => {
    expect(typeof parseLink("abc123")).toBe("string");
    expect(typeof parseLink("https://tessera.qot.nz/elsewhere")).toBe("string");
  });
});

describe("schedules", () => {
  it("wraps midnight", () => {
    const night = hoursWindow("22-07") as (now: number) => boolean;
    const at = (hour: number): number => new Date(2026, 0, 1, hour).getTime();
    expect(night(at(23))).toBe(true);
    expect(night(at(3))).toBe(true);
    expect(night(at(12))).toBe(false);
    expect(typeof hoursWindow("late")).toBe("string");
  });

  it("runs a duty cycle", () => {
    const duty = dutyCycle("20/40") as (now: number) => boolean;
    expect(duty(10 * 60_000)).toBe(true);
    expect(duty(30 * 60_000)).toBe(false);
  });
});

describe("Bot", () => {
  const sim = (): Sim => new Sim(makeGenesis({ seed: 7, empires: [humans(1), simbot(), simbot()] }));
  const run = (bot: Bot, game: Sim, steps: number): number[] => {
    const at: number[] = [];
    for (let i = 0; i < steps; i++) {
      const move = bot.turn(game.state, { empire: 1, member: 0 });
      if (move) {
        at.push(game.step);
        game.advance([{ ...move, step: game.step }]);
      } else game.advance([]);
    }
    return at;
  };

  it("plays its seat, no faster than the game's floor for bots", () => {
    const game = sim();
    const at = run(new Bot({ mode: "expand", interval: 1 }), game, STEPS_PER_SECOND * 60);
    expect(at.length).toBeGreaterThan(3);
    const floor = game.state.genesis.rules.botActionInterval;
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(floor);
  });

  it("banks while resting", () => {
    const game = sim();
    expect(run(new Bot({ mode: "expand", awake: () => false }), game, STEPS_PER_SECOND * 30)).toEqual([]);
  });

  it("plays nothing for a seat that is not on the board", () => {
    const game = sim();
    expect(new Bot().turn(game.state, { empire: 1, member: 3 })).toBeNull();
  });
});
