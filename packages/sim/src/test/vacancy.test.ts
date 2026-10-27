// An empire nobody has claimed, and somebody arriving into it.
//
// There has only ever been one way into a running game: being *invited*, by a
// quorum of an existing empire's seats. That is the right mechanism for a
// substitute and the wrong one for a stranger, and it makes a multi-day game
// announced on a board on Monday a game nobody can join — the address book
// becomes a list of things you may watch.
//
// A vacancy is the other door. It is **territory, not a player**: the map
// generator gives it a capital and separation from the shared seed, before
// anybody knows who will sit there, which is exactly what makes arriving into
// one fair. A claimant takes the ground the map gave that empire, not the best
// ground still going.
//
// Three properties carry the whole design and each has a section below.
//
//   1. A vacancy cannot win, lose, be abandoned, or end a game. Left in those
//      counts it holds its capital forever, so `LAST_EMPIRE` can never fire —
//      and worse, `silentFor` reports it silent from step zero and hands
//      `WIN.LAST_ROSTER` to whoever is awake on the first pass.
//   2. Its pocket is closed until it is claimed, and the pocket is what makes
//      an arrival survivable. Without it a claimant appears on a single tile
//      inside whatever a camper built while they were absent.
//   3. Grace is the *empire's* clock, not the game's. Three minutes from step
//      zero is not a shorter grace to somebody arriving on day three; it is
//      none at all.

import { describe, expect, it } from "vitest";
import { CLAIM, HEARTBEAT, Sim, makeGenesis } from "../sim.js";
import { CONTROL, MEMBER, MOVE, PHASE, WIN } from "../types.js";
import type { Empire, EmpireSpec, Move, Rules } from "../types.js";
import { humans, simbot } from "../specs.js";
import { isProtected, arrivedAt } from "../rules.js";
import { isVacant, rebuildShields } from "../state.js";
import { ballSize, idx } from "../geometry.js";
import { minutes, hours } from "../constants.js";
import { arena, own } from "./testkit.js";

/** An empire the generator will place and nobody has taken. The empty members
 *  array is the whole encoding, deliberately: it was already an error to every
 *  build written before vacancies, so an older peer handed this record declines
 *  rather than desyncing. */
const vacancy = (): EmpireSpec => ({ control: CONTROL.HUMAN, members: [] });

/** The move a claim produces. To the simulation a claim and an amendment are
 *  the same event — append a member to an empire — and that is the property the
 *  design rests on: the sim addresses members by index and knows nothing about
 *  keys, so it has nowhere to hold an authorisation concept and no business
 *  holding one. Who was allowed to send this is the net layer's question. */
const seat = (step: number, empire: number): Move => ({
  step,
  empire,
  member: 0,
  seq: 1,
  type: MOVE.ROSTER_AMEND,
  x: MEMBER.HUMAN,
  y: 0,
});

/** A real generated world, because the shield and the grant are about where the
 *  map generator put the capitals. */
const world = (empires: EmpireSpec[], rules: Partial<Rules> = {}): Sim =>
  new Sim(
    makeGenesis({
      seed: 99,
      startedAt: 1_700_000_000_000,
      map: { width: 64, height: 48 },
      empires,
      rules: { coinIntervalMin: 1 << 28, coinIntervalMax: 1 << 28, ...rules },
    }),
  );

describe("a vacancy is territory, not a player", () => {
  it("is placed and holds its capital, like any other empire", () => {
    const sim = world([humans(1), vacancy()]);
    const held = sim.state.empires[1]!;
    expect(isVacant(held)).toBe(true);
    // `placeCapitals` never looked at members, so a vacancy gets a capital and
    // its separation from the others for free.
    expect(sim.state.owner[held.capital]).toBe(held.id);
  });

  it("does not stop the last claimed empire from winning", () => {
    // The fatal version of getting this wrong: a vacancy holds its capital
    // forever, so `alive.length` never falls to one and the game runs to its
    // timeout with a winner decided by tiles instead of by conquest.
    const sim = arena([humans(1), humans(1), vacancy()], 3);
    const victim = sim.state.empires[1]!;
    sim.state.owner[victim.capital] = 1;
    sim.advance([]);
    expect(sim.state.phase).toBe(PHASE.ENDED);
    expect(sim.state.winner).toBe(1);
    expect(sim.state.winReason).toBe(WIN.LAST_EMPIRE);
  });

  it("is not counted absent, so nobody wins by being the only one awake", () => {
    // `silentFor` on an empire with no members is `state.step` — silent since
    // the beginning. Counted in `present`, a two-human game with one vacancy
    // would hand LAST_ROSTER to whichever human beat first.
    const sim = arena([humans(1), humans(1), vacancy()], 3, { abandonWindow: minutes(5) });
    sim.state.step = minutes(6);
    // Both humans awake, written directly: a heartbeat move only lands on the
    // step it is submitted for, and two `advance` calls would make the second
    // empire briefly absent for a reason that has nothing to do with vacancies.
    for (const e of [0, 1]) sim.state.empires[e]!.members[0]!.lastBeat = minutes(6);
    sim.advance([]);
    expect(sim.state.phase).toBe(PHASE.PLAYING);
  });

  it("does not win a timeout it is leading", () => {
    const sim = arena([humans(1), vacancy()], 3, { endStep: 10 });
    // The vacancy is given more ground than the player, which under a naive
    // `leader` would make an empire with nobody in it the winner of the game.
    own(sim, 5, 5, 2, 50);
    own(sim, 6, 5, 2, 50);
    sim.state.step = 10;
    sim.advance([]);
    expect(sim.state.phase).toBe(PHASE.ENDED);
    expect(sim.state.winner).toBe(1);
  });

  it("ends a game with no winner if every claimed empire is gone", () => {
    const sim = arena([humans(1), vacancy()], 3);
    sim.state.owner[sim.state.empires[0]!.capital] = 0;
    sim.advance([]);
    expect(sim.state.phase).toBe(PHASE.ENDED);
    expect(sim.state.winner).toBe(0);
  });

  it("lets a game with vacancies in it play normally to its end", () => {
    const sim = world([humans(1), simbot("easy"), vacancy(), vacancy()], {
      endStep: minutes(2),
      vacancyRadius: 4,
    });
    sim.fastForward(minutes(2) + 1);
    expect(sim.state.phase).toBe(PHASE.ENDED);
    // Whatever the result, it was not decided by an empire nobody was playing.
    expect([1, 2]).toContain(sim.state.winner);
  });
});

describe("the pocket is closed until somebody arrives", () => {
  /** A board with one vacancy, one attacker, and the attacker parked next to
   *  the pocket with population to spend. */
  const besieged = (radius: number): { sim: Sim; cx: number; cy: number } => {
    const sim = arena([humans(1), vacancy()], 5, { vacancyRadius: radius });
    const held = sim.state.empires[1]!;
    const cx = held.capital % sim.state.width;
    const cy = Math.floor(held.capital / sim.state.width);
    sim.state.empires[0]!.members[0]!.popTimer = 999;
    return { sim, cx, cy };
  };

  it("refuses a claim on a neutral tile inside the ball", () => {
    const { sim, cx, cy } = besieged(4);
    // Owned ground right at the rim, so adjacency is satisfied and the only
    // thing left to refuse the move is the shield itself.
    own(sim, cx + 5, cy, 1, 9);
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx + 4, cy))).toBe(false);
  });

  it("refuses the same claim just outside it, for no other reason", () => {
    // The control. Without this the test above passes on a board where nothing
    // was reachable in the first place.
    const { sim, cx, cy } = besieged(4);
    own(sim, cx + 6, cy, 1, 9);
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx + 5, cy))).toBe(true);
  });

  it("refuses a march into it, and a march through it", () => {
    // One check closes all of these: every ownership change goes through
    // `place`, and `place` asks on its second line. A march asks twice — once
    // for the gap tile it steps over and once for the target — so a shield
    // blocks a march *through* a pocket as well as into one, which is a rule
    // nobody had to write.
    const { sim, cx, cy } = besieged(4);
    sim.state.empires[0]!.marchUnlocked = 1;
    own(sim, cx + 6, cy, 1, 9);
    expect(sim.validate({ ...CLAIM(sim.step, 1, 0, 0, cx + 4, cy), type: MOVE.MARCH })).toBe(false);
  });

  it("refuses a ladder and a bridge inside it", () => {
    // Terrain is not ownership: these two are the only moves that change the
    // ground without going through `place`. Left open, a camper could reshape
    // the pocket days before anyone arrived.
    const { sim, cx, cy } = besieged(4);
    const target = idx(cx + 2, cy, sim.state.width);
    sim.state.terrain[target] = 4; // WALL
    sim.state.empires[0]!.ladders = 1;
    own(sim, cx + 3, cy, 1, 9);
    expect(
      sim.validate({ ...CLAIM(sim.step, 1, 0, 0, cx + 2, cy), type: MOVE.PLACE_LADDER }),
    ).toBe(false);
  });

  it("opens the moment the empire is claimed", () => {
    const { sim, cx, cy } = besieged(4);
    own(sim, cx + 5, cy, 1, 9);
    expect(sim.validate(CLAIM(sim.step, 1, 0, 0, cx + 4, cy))).toBe(false);

    sim.advance([seat(sim.step, 2)]);
    // The claimant now holds that tile — the grant took it — so it is no longer
    // neutral, but it is no longer *shielded*, which is the thing being tested.
    expect(sim.state.shielded[idx(cx + 4, cy, sim.state.width)]).toBe(0);
  });

  it("stays closed while a second vacancy still covers it", () => {
    // Overlap falls out of the layer being a count rather than a flag: a tile
    // inside two balls is at 2, one claim brings it to 1, and it is still shut.
    const sim = arena([humans(1), vacancy(), vacancy()], 5, { vacancyRadius: 4 });
    const a = sim.state.empires[1]!;
    const b = sim.state.empires[2]!;
    // Park the two capitals on top of each other's balls.
    a.capital = idx(10, 10, sim.state.width);
    b.capital = idx(12, 10, sim.state.width);
    sim.state.owner[a.capital] = a.id;
    sim.state.owner[b.capital] = b.id;
    rebuildShields(sim.state);

    const between = idx(11, 10, sim.state.width);
    expect(sim.state.shielded[between]).toBe(2);
    sim.advance([seat(sim.step, 2)]);
    expect(sim.state.shielded[between]).toBe(1);
  });
});

describe("what a claimant arrives holding", () => {
  it("gets the seat at member 0, and it is a human seat", () => {
    const sim = world([humans(1), vacancy()], { vacancyRadius: 4 });
    sim.advance([seat(sim.step, 2)]);
    const claimed = sim.state.empires[1]!;
    expect(claimed.members).toHaveLength(1);
    expect(claimed.members[0]!.kind).toBe(MEMBER.HUMAN);
    expect(isVacant(claimed)).toBe(false);
  });

  it("arrives holding the pocket rather than one tile inside a wall", () => {
    // The real answer to the camper. Widening the radius alone does not close
    // that hole — the camper builds one tile further out — but arriving with a
    // border to push from turns their wall into a siege, which is a fair thing
    // to have built, rather than a kill.
    const sim = world([humans(1), vacancy()], { vacancyRadius: 4, vacancyGrant: 1 });
    const before = sim.state.empires[1]!.tilesOwned;
    sim.advance([seat(sim.step, 2)]);
    const after = sim.state.empires[1]!.tilesOwned;
    expect(after).toBeGreaterThan(before + 10);
    // And no more than the ball could possibly contain.
    expect(after).toBeLessThanOrEqual(ballSize(4));
  });

  it("is granted nothing a camper actually holds", () => {
    // Ground somebody took is theirs. The arrival gets somewhere to stand and a
    // border, never a free conquest.
    const sim = arena([humans(1), vacancy()], 5, { vacancyRadius: 4, vacancyGrant: 1 });
    const held = sim.state.empires[1]!;
    const cx = held.capital % sim.state.width;
    const cy = Math.floor(held.capital / sim.state.width);
    // A tile the camper already owns inside the ball. (`own` writes it directly,
    // which is what a camper would have reached before the shield went up.)
    own(sim, cx + 2, cy, 1, 7);
    sim.advance([seat(sim.step, 2)]);
    expect(sim.state.owner[idx(cx + 2, cy, sim.state.width)]).toBe(1);
    expect(sim.state.pop[idx(cx + 2, cy, sim.state.width)]).toBe(7);
  });

  it("is granted nothing at all when the rule says nothing", () => {
    const sim = world([humans(1), vacancy()], { vacancyRadius: 4, vacancyGrant: 0 });
    const before = sim.state.empires[1]!.tilesOwned;
    sim.advance([seat(sim.step, 2)]);
    expect(sim.state.empires[1]!.tilesOwned).toBe(before);
  });

  it("survives a camper's wall an hour later", () => {
    // The camper scenario, end to end and measured. An empire walls the rim,
    // the vacancy is claimed, and an hour of game time later the claimant is
    // still in the game.
    const sim = world([humans(1), vacancy()], {
      vacancyRadius: 4,
      vacancyGrant: 1,
      upkeepInterval: 1 << 28,
    });
    const held = sim.state.empires[1]!;
    const cx = held.capital % sim.state.width;
    const cy = Math.floor(held.capital / sim.state.width);
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== 6) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= sim.state.width || y >= sim.state.height) continue;
        const i = idx(x, y, sim.state.width);
        if (sim.state.owner[i] !== 0) continue;
        sim.state.owner[i] = 1;
        sim.state.pop[i] = 40;
        sim.state.empires[0]!.tilesOwned++;
        sim.state.empires[0]!.popTotal += 40;
      }
    }

    sim.advance([seat(sim.step, 2)]);
    sim.fastForward(sim.step + hours(1));
    expect(sim.state.owner[held.capital]).toBe(held.id);
    expect(sim.state.empires[1]!.alive).toBe(1);
  });
});

/** Protection turned back on. `arena` disables it — a shield nobody asked for
 *  is a refusal in the middle of a test about something else — and every field
 *  has to be named, because the bars are a conjunction and a zero in any one of
 *  them ends protection on its own. */
const GRACE: Partial<Rules> = {
  graceSteps: minutes(3),
  graceTiles: 40,
  graceCapitalPop: 60,
  gracePopTotal: 400,
};

describe("grace is the empire's clock, not the game's", () => {
  it("an empire with no members has arrived now, so it is always protected", () => {
    // The definition rather than a fallback for an empty minimum, and it is what
    // makes the derivation total: an unclaimed capital is protected for as long
    // as it is unclaimed, which is a second lock behind the shield that holds
    // even at radius zero.
    const sim = arena([humans(1), vacancy()], 3, { ...GRACE, vacancyRadius: 0 });
    sim.state.step = hours(9);
    const held = sim.state.empires[1]!;
    expect(arrivedAt(sim.state, held)).toBe(hours(9));
    expect(isProtected(sim.state, held)).toBe(true);
  });

  it("an empire claimed on day three gets its grace then", () => {
    const sim = arena([humans(1), vacancy()], 3, { ...GRACE, vacancyRadius: 0 });
    sim.state.step = hours(72);
    sim.advance([seat(sim.step, 2)]);
    const claimed = sim.state.empires[1]!;
    expect(arrivedAt(sim.state, claimed)).toBe(hours(72));
    expect(isProtected(sim.state, claimed)).toBe(true);

    sim.state.step = hours(72) + minutes(3);
    expect(isProtected(sim.state, claimed)).toBe(false);
  });

  it("a genesis-seated empire's grace is unchanged", () => {
    // The migration test, not a hope: no record written before this has an
    // empire whose members all joined after step zero, so `arrivedAt` is 0
    // everywhere and the old behaviour is reproduced exactly.
    const sim = arena([humans(1), humans(1)], 3, { ...GRACE, vacancyRadius: 0 });
    const held = sim.state.empires[1]!;
    expect(arrivedAt(sim.state, held)).toBe(0);
    sim.state.step = minutes(3) - 1;
    expect(isProtected(sim.state, held)).toBe(true);
    sim.state.step = minutes(3);
    expect(isProtected(sim.state, held)).toBe(false);
  });

  it("an empire that recruits on day six does not get its immunity back", () => {
    // Grace belongs to the empire, and the minimum across its members is what
    // says so. A team that could re-arm its capital by voting in a substitute
    // would have found a way to be permanently unkillable.
    const sim = arena([humans(1), humans(1)], 3, { ...GRACE, vacancyRadius: 0 });
    sim.state.step = hours(144);
    sim.advance([seat(sim.step, 2)]);
    const held = sim.state.empires[1]!;
    expect(held.members).toHaveLength(2);
    expect(arrivedAt(sim.state, held)).toBe(0);
    expect(isProtected(sim.state, held)).toBe(false);
  });
});

describe("protection ends when an empire is established", () => {
  /** An empire with nothing much, five steps into its own existence. */
  const young = (rules: Partial<Rules>): { sim: Sim; held: Empire } => {
    const sim = arena([humans(1), humans(1)], 3, { vacancyRadius: 0, ...rules });
    sim.state.step = 5;
    return { sim, held: sim.state.empires[1]! };
  };

  const bars = {
    graceSteps: minutes(3),
    graceTiles: 40,
    graceCapitalPop: 60,
    gracePopTotal: 400,
  };

  it("runs to the time ceiling with every strength bar uncrossed", () => {
    // Read the rule as a hard ceiling in time, lifted early by any one measure
    // of strength — and never as four conditions OR'd together, which could
    // only ever *shorten* protection. A claimant granted a pocket would trip
    // the tile bar on the step they arrive.
    const { sim, held } = young(bars);
    expect(isProtected(sim.state, held)).toBe(true);
    sim.state.step = minutes(3);
    expect(isProtected(sim.state, held)).toBe(false);
  });

  it("ends early on the tile bar", () => {
    const { sim, held } = young(bars);
    held.tilesOwned = 40;
    expect(isProtected(sim.state, held)).toBe(false);
  });

  it("ends early on the total-population bar", () => {
    const { sim, held } = young(bars);
    held.popTotal = 400;
    expect(isProtected(sim.state, held)).toBe(false);
  });

  it("ends early on the capital-population bar", () => {
    // The bar `tilesOwned` alone cannot express. Forty tiles of one population
    // each is not an established empire; one capital nobody can dislodge is.
    const { sim, held } = young(bars);
    sim.state.pop[held.capital] = 60;
    expect(isProtected(sim.state, held)).toBe(false);
  });

  it("falls back to the old names when a record carries only those", () => {
    // Every genesis written before vacancies has `noobSteps`/`noobTiles` and
    // neither grace field, and those games keep the protection they were
    // composed with.
    const sim = new Sim(
      makeGenesis({
        seed: 3,
        map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
        empires: [humans(1), humans(1)],
        rules: {
          noobSteps: minutes(1),
          noobTiles: 5,
          graceSteps: undefined,
          graceTiles: undefined,
          graceCapitalPop: undefined,
          gracePopTotal: undefined,
        } as Partial<Rules>,
      }),
    );
    const held = sim.state.empires[1]!;
    expect(isProtected(sim.state, held)).toBe(true);
    sim.state.step = minutes(1);
    expect(isProtected(sim.state, held)).toBe(false);
  });
});

describe("the shield layer is derived, never stored", () => {
  it("comes back from a snapshot that never carried it", () => {
    // The whole reason `LAYOUT_VERSION` does not move for this plan. Capitals
    // and member counts are in the snapshot, and those are the entire
    // derivation — so `restore` rebuilds the layer and the encoding is
    // untouched.
    const sim = world([humans(1), vacancy()], { vacancyRadius: 5 });
    const before = [...sim.state.shielded];
    const bytes = sim.snapshot();

    const other = world([humans(1), vacancy()], { vacancyRadius: 5 });
    other.state.shielded.fill(0);
    other.restore(bytes);
    expect([...other.state.shielded]).toEqual(before);
  });

  it("is gone from a restored state once the vacancy was claimed", () => {
    const sim = world([humans(1), vacancy()], { vacancyRadius: 5 });
    sim.advance([seat(sim.step, 2)]);
    const bytes = sim.snapshot();

    const other = world([humans(1), vacancy()], { vacancyRadius: 5 });
    other.restore(bytes);
    expect([...other.state.shielded].some((n) => n > 0)).toBe(false);
    expect(other.hash()).toBe(sim.hash());
  });
});
