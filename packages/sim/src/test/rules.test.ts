// The rules, checked rather than reasoned about.
//
// Every number here is a design decision that Phase C's consensus depends on
// reproducing exactly: two peers that disagree about what a gold coin does
// disagree about the state hash, and the game stops.

import { beforeAll, describe, expect, it } from "vitest";
import { Sim, makeGenesis, CLAIM } from "../sim.js";
import { MOVE, MEMBER, CONTROL, TERRAIN, ITEM, WIN } from "../types.js";
import { idx } from "../geometry.js";
import { DEFAULT_RULES, STAT, STEPS_PER_SECOND } from "../constants.js";
import { arena, at, claimNow, held, humans, own, ownerAt, popAt } from "./testkit.js";
import { DIFFICULTY, simbot } from "../specs.js";
import type { Difficulty } from "../specs.js";

describe("surround multiplier", () => {
  it("one adjacent tile places 999", () => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 6, 5);
    expect(popAt(sim, 6, 5)).toBe(999);
  });

  it("four-side surround places 999 x 4", () => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 4, 1);
    own(sim, 5, 6, 1);
    own(sim, 4, 5, 1);
    own(sim, 6, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 5, 5);
    expect(popAt(sim, 5, 5)).toBe(3996);
  });
});

describe("coin claim radii", () => {
  // A coin's share is floor(999 / tiles), and each tile of the shape then takes
  // the surround multiplier it earns inside that shape. `beside` is the tile one
  // step from the centre: single strength for bronze, whose arms have nothing
  // behind them, and quadruple for the two larger coins, where it is interior.
  //
  // `centre` is the click plus the coin. The clicked tile is claimed normally
  // first — 999 here — and the coin spreads on top of it, so landing on a coin
  // is never worse than landing on bare ground. It used to be: the coin
  // consumed the claim, and a full bank on bronze put 203 on the tile you
  // clicked instead of 999.
  const cases = [
    { coin: "bronze", item: ITEM.BRONZE, tiles: 5, beside: 199, centre: 1795 },
    { coin: "silver", item: ITEM.SILVER, tiles: 13, beside: 304, centre: 1303 },
    { coin: "gold", item: ITEM.GOLD, tiles: 25, beside: 156, centre: 1155 },
  ] as const;

  describe.each(cases)("$coin", ({ item, tiles, beside, centre }) => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 10, 12, 1);
      sim.state.item[at(sim, 11, 12)] = item;
      sim.state.itemCount = 1;
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      claimNow(sim, 1, 0, 11, 12);
    });

    // The claim covers the ball, and the seed tile at (10,12) sits inside it.
    it(`claims ${tiles} tiles`, () => expect(held(sim, 1)).toBe(tiles));

    it(`puts ${beside} on the tile beside the coin`, () =>
      expect(popAt(sim, 11, 13)).toBe(beside));

    it("lands the click on the coin tile as well as the coin", () =>
      expect(popAt(sim, 11, 12)).toBe(centre));

    // The point of the whole change: a coin is a reward, so clicking one can
    // never be worse than clicking bare ground with the same population.
    it("is never a worse place to spend than an empty tile", () =>
      expect(popAt(sim, 11, 12)).toBeGreaterThanOrEqual(999));
  });
});

// A coin divides the population that triggered it across its whole shape, so a
// large coin triggered by a small claim divided to nothing per tile — and
// place() refuses an amount of zero. A gold coin sitting in open ground took
// none of it: not the tiles around it, not even the tile it was on.
describe("a coin triggered with almost nothing", () => {
  let sim: Sim;

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    own(sim, 10, 12, 1);
    sim.state.item[at(sim, 11, 12)] = ITEM.GOLD;
    sim.state.itemCount = 1;
    // Twenty population across twenty-five tiles is less than one each.
    sim.state.empires[0]!.members[0]!.popTimer = 20;
    claimNow(sim, 1, 0, 11, 12);
  });

  it("still claims its whole shape", () => expect(held(sim, 1)).toBe(25));

  it("puts a population on every tile of it", () => {
    // One each, times whatever surround the tile earns inside the shape: four
    // for an interior tile, one on the rim.
    expect(popAt(sim, 11, 13)).toBe(4);
    expect(popAt(sim, 11, 15)).toBe(1);
  });

  it("and does not leave the coin tile empty", () => {
    expect(popAt(sim, 11, 12)).toBe(24); // 20 from the click, 1 x4 from the coin
    expect(ownerAt(sim, 11, 12)).toBe(1);
  });
});

describe("coin cascade", () => {
  let sim: Sim;

  beforeAll(() => {
    sim = arena([humans(1), humans(1)]);
    own(sim, 10, 12, 1);
    sim.state.item[at(sim, 11, 12)] = ITEM.BRONZE;
    sim.state.item[at(sim, 12, 12)] = ITEM.GOLD; // inside the bronze radius
    sim.state.itemCount = 2;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(sim, 1, 0, 11, 12);
  });

  it("a coin inside the radius triggers a chain", () => {
    expect(held(sim, 1)).toBeGreaterThan(5);
  });

  it("chained gold covers its own full radius", () => {
    expect(ownerAt(sim, 15, 12)).toBe(1);
  });

  it("creates population rather than dividing it", () => {
    // Every tile of the chained gold gets the bronze's own 199 per tile, times
    // the surround it earns inside the gold's shape — interior, so four.
    expect(popAt(sim, 12, 13)).toBe(796);
  });

  // A coin does the same thing for a bot as for a person. It used to stop
  // chaining for a BOT seat, on the theory that cascade mastery should stay the
  // human skill expression — but that made a bot a discounted player rather
  // than an easier one, and difficulty now lives in how a bot plays.
  it("and does the same for a bot", () => {
    const bot = arena([
      { control: CONTROL.HUMAN, members: [{ kind: MEMBER.BOT }] },
      humans(1),
    ]);
    own(bot, 10, 12, 1);
    bot.state.item[at(bot, 11, 12)] = ITEM.BRONZE;
    bot.state.item[at(bot, 12, 12)] = ITEM.GOLD;
    bot.state.itemCount = 2;
    bot.state.empires[0]!.members[0]!.popTimer = 999;
    claimNow(bot, 1, 0, 11, 12);
    expect(ownerAt(bot, 15, 12)).toBe(1);
    expect(popAt(bot, 12, 13)).toBe(796);
  });
});

describe("terrain and crossings", () => {
  const blocked = (terrain: number): boolean => {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 5, 5, 1);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    sim.state.terrain[at(sim, 6, 5)] = terrain;
    return !sim.validate(CLAIM(0, 1, 0, 0, 6, 5));
  };

  it("mountains are impassable", () => expect(blocked(TERRAIN.MOUNTAIN)).toBe(true));
  it("lakes are impassable", () => expect(blocked(TERRAIN.LAKE)).toBe(true));
  it("rivers block until bridged", () => expect(blocked(TERRAIN.RIVER)).toBe(true));

  // Buying, placing and then crossing is one story, so these run in order
  // against one board rather than rebuilding the setup three times.
  describe("bridging a river", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 5, 5, 1);
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      sim.state.terrain[at(sim, 6, 5)] = TERRAIN.RIVER;
    });

    const buy = { empire: 1, member: 0, seq: 0, type: MOVE.BUY_BRIDGE, x: 0, y: 0 };

    it("cannot be bought without diamonds", () => {
      expect(sim.validate({ step: 0, ...buy })).toBe(false);
    });

    it("spends the diamonds it costs", () => {
      sim.state.empires[0]!.diamonds = 3;
      sim.advance([{ step: sim.step, ...buy }]);
      expect(sim.state.empires[0]!.diamonds).toBe(0);
    });

    it("yields one bridge", () => expect(sim.state.empires[0]!.bridges).toBe(1));

    it("converts the tile when placed", () => {
      sim.advance([
        { step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.PLACE_BRIDGE, x: 6, y: 5 },
      ]);
      expect(sim.state.terrain[at(sim, 6, 5)]).toBe(TERRAIN.RIVER_BRIDGED);
    });

    it("and the river is then passable", () => {
      expect(sim.validate(CLAIM(sim.step, 1, 0, 0, 6, 5))).toBe(true);
    });
  });
});

describe("noob protection", () => {
  let sim: Sim;
  let cx: number;
  let cy: number;
  let capital: number;

  beforeAll(() => {
    sim = new Sim(
      makeGenesis({
        seed: 7,
        empires: [humans(1), humans(1)],
        map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
        rules: {
          coinIntervalMin: 1 << 28,
          coinIntervalMax: 1 << 28,
          noobTiles: 40,
          noobSteps: 100 * STEPS_PER_SECOND,
        },
      }),
    );
    capital = sim.state.empires[1]!.capital;
    cx = capital % sim.state.width;
    cy = Math.floor(capital / sim.state.width);

    // Attacker adjacent to the protected capital.
    sim.state.owner[idx(cx - 1, cy, sim.state.width)] = 1;
    sim.state.pop[idx(cx - 1, cy, sim.state.width)] = 1;
    sim.state.empires[0]!.tilesOwned++;
    sim.state.empires[0]!.members[0]!.popTimer = 999;
  });

  it("a protected capital rejects attacks", () => {
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy))).toBe(false);
  });

  it("a protected capital takes no damage", () => {
    const before = sim.state.pop[capital]!;
    sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy));
    expect(sim.state.pop[capital]).toBe(before);
  });

  it("protection lifts once the timer passes", () => {
    sim.state.step = 100 * STEPS_PER_SECOND + 1;
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy))).toBe(true);
  });

  // The other half of "whichever lands first". An empire that grows quickly
  // stops being a beginner long before the clock says so, and the shield has
  // to come off on the tile count alone.
  describe("growing out of it", () => {
    let grown: Sim;
    let victim: number;

    beforeAll(() => {
      grown = arena([humans(1), humans(1)], 7, {
        noobTiles: 40,
        noobSteps: 100 * STEPS_PER_SECOND,
      });
      victim = grown.state.empires[1]!.capital;
      own(grown, 3, 0, 1); // adjacent to empire 2's parked capital
      grown.state.empires[0]!.members[0]!.popTimer = 999;
    });

    it("a young empire's capital is shielded", () => {
      expect(grown.state.empires[1]!.tilesOwned).toBeLessThan(40);
      expect(grown.validate(CLAIM(grown.step, 1, 0, 0, 4, 0))).toBe(false);
    });

    it("and the shield lifts at the tile threshold, with the clock untouched", () => {
      grown.state.empires[1]!.tilesOwned = 40;
      expect(grown.step).toBeLessThan(grown.state.genesis.rules.noobSteps);
      expect(grown.validate(CLAIM(grown.step, 1, 0, 0, 4, 0))).toBe(true);
    });

    it("and the capital can then actually be taken", () => {
      grown.advance([CLAIM(grown.step, 1, 0, 0, 4, 0)]);
      expect(grown.state.owner[victim]).toBe(1);
    });
  });
});

describe("team empires", () => {
  describe("three members share territory and not timers", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(3), humans(1)]);
      own(sim, 5, 5, 1);
      own(sim, 8, 8, 1);
      for (let i = 0; i < 300; i++) sim.advance([]);
    });

    it("member A accrues its own timer", () => {
      expect(sim.state.empires[0]!.members[0]!.popTimer).toBe(300);
    });

    it("member B accrues independently", () => {
      expect(sim.state.empires[0]!.members[1]!.popTimer).toBe(300);
    });

    it("three members hold three separate timers", () => {
      const [a, b, c] = sim.state.empires[0]!.members;
      expect(new Set([a, b, c]).size).toBe(3);
    });

    // Two members of one empire acting on the same step, on different fronts,
    // is the whole point of a shared empire.
    it("two members act on the same step", () => {
      sim.state.empires[0]!.members[0]!.popTimer = 100;
      sim.state.empires[0]!.members[1]!.popTimer = 100;
      const dirty = sim.advance([
        CLAIM(sim.step, 1, 0, 0, 6, 5),
        CLAIM(sim.step, 1, 1, 0, 9, 8),
      ]);
      expect([ownerAt(sim, 6, 5), ownerAt(sim, 9, 8)]).toEqual([1, 1]);
      expect(dirty.size).toBeGreaterThanOrEqual(2);
    });
  });

  // A bot is not a discounted player. It grows at the rate everybody grows at,
  // and what makes one easy is the ceiling it grows to — which is a difficulty
  // setting rather than a penalty for being a program.
  describe("a bot seat grows like everyone else, up to its own ceiling", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([
        {
          control: CONTROL.HUMAN,
          members: [
            { kind: MEMBER.HUMAN },
            { kind: MEMBER.BOT, bot: { popMax: 60 } },
            { kind: MEMBER.BOT },
          ],
        },
        humans(1),
      ]);
      own(sim, 5, 5, 1);
      for (let i = 0; i < 200; i++) sim.advance([]);
    });

    it("a human member accrues at full rate", () => {
      expect(sim.state.empires[0]!.members[0]!.popTimer).toBe(200);
    });

    it("a bot with no profile does too", () => {
      expect(sim.state.empires[0]!.members[2]!.popTimer).toBe(200);
    });

    // The whole of what makes this seat easy: it filled in five seconds and
    // spent the next eleven pouring its growth away.
    it("and one dialled down stops at its cap", () => {
      expect(sim.state.empires[0]!.members[1]!.popTimer).toBe(60);
    });

    it("a cap above the game's own is clamped, not honoured", () => {
      const greedy = arena([
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.BOT, bot: { popMax: 5000 } }] },
        humans(1),
      ]);
      expect(greedy.state.empires[0]!.members[0]!.popMax).toBe(
        greedy.state.genesis.rules.popMax,
      );
    });
  });

  // An empire is a set of seats sharing territory with a population timer
  // each, so a side that can add seats freely out-accrues everyone else. Since
  // a headless bot is an ordinary peer holding an ordinary seat, adding one
  // costs nothing but a process — which is why the cap is a rule rather than a
  // manner of the lobby. An empire votes a substitute in; no quorum can vote
  // itself a bigger team than every other empire is allowed.
  describe("an empire cannot vote itself past the seat cap", () => {
    const amend = (sim: Sim, kind: number) => ({
      step: sim.step,
      empire: 1,
      member: 0,
      seq: 0,
      type: MOVE.ROSTER_AMEND,
      x: kind,
      y: 0,
    });

    it("seats a substitute while there is room", () => {
      const sim = arena([humans(1), humans(1)], 1, { maxSeats: 3 });
      sim.advance([amend(sim, MEMBER.HUMAN)]);
      expect(sim.state.empires[0]!.members).toHaveLength(2);
    });

    it("and refuses the one that would put it over", () => {
      const sim = arena([humans(3), humans(1)], 1, { maxSeats: 3 });
      const move = amend(sim, MEMBER.HUMAN);
      expect(sim.validate(move)).toBe(false);
      sim.advance([move]);
      expect(sim.state.empires[0]!.members).toHaveLength(3);
    });

    // The default is a team of three rotating shifts plus a seat to cover the
    // night, which is the game this is for.
    it("by default, four", () => {
      expect(DEFAULT_RULES.maxSeats).toBe(4);
    });
  });
});

describe("win conditions", () => {
  describe("capturing a capital", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      const victim = sim.state.empires[1]!;
      victim.capital = at(sim, 12, 12);
      sim.state.owner[victim.capital] = 2;
      sim.state.pop[victim.capital] = 1;
      victim.tilesOwned = 1;
      own(sim, 11, 12, 1);
      sim.state.empires[0]!.members[0]!.popTimer = 999;
      claimNow(sim, 1, 0, 12, 12);
    });

    it("eliminates the empire", () => expect(sim.state.empires[1]!.alive).toBe(0));
    it("ends the game", () => expect(sim.ended).toBe(true));
    it("and the survivor wins", () => expect(sim.state.winner).toBe(1));
  });

  // Being asleep is not being defeated. A short window would reward waiting
  // until an opponent's team is offline, which is the behaviour the whole
  // shift-rotation design exists to avoid.
  describe("abandonment", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)]);
      own(sim, 5, 5, 1);
      own(sim, 15, 15, 2);
    });

    it("does not fire on a minute of silence", () => {
      sim.state.step = 60 * STEPS_PER_SECOND;
      sim.state.empires[0]!.members[0]!.lastBeat = sim.state.step;
      sim.advance([]);
      expect(sim.ended).toBe(false);
    });

    it("fires past the window", () => {
      sim.state.step = sim.state.genesis.rules.abandonWindow + 10;
      sim.state.empires[0]!.members[0]!.lastBeat = sim.state.step;
      sim.advance([]);
      expect(sim.ended && sim.state.winner === 1).toBe(true);
    });
  });

  // The wall-clock model makes a timeout the natural end of a scheduled game:
  // nobody has to be present for the last step, so the result has to fall out
  // of the state rather than out of who was still watching.
  describe("a timeout ends on score", () => {
    const END = 50;
    let sim: Sim;
    let endedAt = -1;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)], 1, { endStep: END });
      own(sim, 5, 5, 1);
      own(sim, 6, 5, 1); // empire 1 leads on tiles
      own(sim, 15, 15, 2);
      while (!sim.ended && sim.step < END * 2) {
        sim.advance([]);
        if (sim.ended && endedAt < 0) endedAt = sim.step;
      }
    });

    it("runs to the step it was given", () => expect(endedAt).toBe(END + 1));
    it("nobody was eliminated", () => expect(sim.state.empires[1]!.alive).toBe(1));
    it("the leader on tiles wins", () => expect(sim.state.winner).toBe(1));
    it("and it says why", () => expect(sim.state.winReason).toBe(WIN.TIMEOUT));
  });

  // Two empires level on tiles is not a tie: the ordering has to be total, or
  // two peers reading the same state could name different winners.
  describe("a tied timeout breaks on population", () => {
    let sim: Sim;

    beforeAll(() => {
      sim = arena([humans(1), humans(1)], 1, { endStep: 20 });
      own(sim, 5, 5, 1, 10);
      own(sim, 15, 15, 2, 50); // level on tiles, ahead on population
      while (!sim.ended && sim.step < 60) sim.advance([]);
    });

    it("the empires were level on tiles", () => {
      expect(sim.state.empires[0]!.tilesOwned).toBe(sim.state.empires[1]!.tilesOwned);
    });

    it("and the bigger population takes it", () => expect(sim.state.winner).toBe(2));
  });
});

// Difficulty, which is now the whole of what makes one bot different from
// another: how high it banks, how long it waits, and what it spends its phases
// doing. None of it is a penalty — an easy bot and a hard one grow at exactly
// the same rate, and the easy one throws most of it away.
describe("bot difficulty is a scale", () => {
  const play = (level: Difficulty): { tiles: number; pop: number } => {
    const sim = arena([simbot(level), humans(1)], 5);
    own(sim, 6, 6, 1);
    // Five minutes, which is long enough for the slowest profile to have acted
    // several times over.
    for (let i = 0; i < STEPS_PER_SECOND * 300; i++) sim.advance([]);
    const empire = sim.state.empires[0]!;
    return { tiles: empire.tilesOwned, pop: empire.popTotal };
  };

  let easy: { tiles: number; pop: number };
  let hard: { tiles: number; pop: number };

  beforeAll(() => {
    easy = play("easy");
    hard = play("hard");
  });

  it("every profile actually plays", () => {
    expect(easy.tiles).toBeGreaterThan(1);
    expect(hard.tiles).toBeGreaterThan(1);
  });

  // The arithmetic behind it: easy banks 60 and waits 180 steps, so two thirds
  // of everything it grows is poured away, while hard banks all 720 it grew.
  it("an easy bot ends the same game much weaker than a hard one", () => {
    expect(hard.pop).toBeGreaterThan(easy.pop * 3);
  });

  it("and its tiles are thin enough to take back", () => {
    expect(easy.pop / easy.tiles).toBeLessThan(hard.pop / hard.tiles);
  });

  // A profile that asks to act faster than the rules allow does not get to.
  // An always-on seat must not out-reflex the people it plays against, and that
  // is a floor in the rules rather than an honour system.
  it("no profile may act faster than the rules allow", () => {
    const sim = arena([{ control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT, bot: { interval: 1 } }] }, humans(1)], 5);
    own(sim, 6, 6, 1);
    const floor = sim.state.genesis.rules.botActionInterval;
    for (let i = 0; i < floor * 4; i++) sim.advance([]);
    // Four intervals at the floor, so at most four claims however eager it is.
    expect(sim.state.empires[0]!.members[0]!.stats[STAT.MOVES]!).toBeLessThanOrEqual(4);
  });

  it("the presets stay inside what the game allows", () => {
    for (const profile of Object.values(DIFFICULTY)) {
      expect(profile.popMax!).toBeLessThanOrEqual(999);
      expect(profile.weights!).toHaveLength(4);
    }
  });
});
