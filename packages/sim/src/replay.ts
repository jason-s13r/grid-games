#!/usr/bin/env node
// Headless determinism and rules harness.
//
// Given (genesis, move log) it runs the simulation and prints the final state
// hash. Two peers, or Node and a browser, must agree on that number for the
// same inputs — everything in Phase C rests on it.

import { Sim, makeGenesis, CLAIM } from "./sim.js";
import type { Move, EmpireSpec } from "./types.js";
import { MOVE, MEMBER, CONTROL, TERRAIN, ITEM } from "./types.js";
import { hex } from "./hash.js";
import { hashState } from "./state.js";
import { idx } from "./geometry.js";
import { STEPS_PER_SECOND } from "./constants.js";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const eq = (label: string, actual: unknown, expected: unknown): void =>
  ok(label, actual === expected, `expected ${expected}, got ${actual}`);

// --- fixtures ----------------------------------------------------------------

const humans = (n: number): EmpireSpec => ({
  control: CONTROL.HUMAN,
  members: Array.from({ length: n }, () => ({ kind: MEMBER.HUMAN })),
});
const simbot = (): EmpireSpec => ({
  control: CONTROL.SIMBOT,
  members: [{ kind: MEMBER.BOT }],
});

/** A blank arena: no terrain features, no spawns, so a test controls the board
 *  completely.
 *
 *  Every empire keeps an owned capital parked in row 0, well clear of the
 *  working area. Without one, elimination fires on the first advance and the
 *  game ends before the test does anything. */
function arena(empires: EmpireSpec[], seed = 1): Sim {
  const sim = new Sim(
    makeGenesis({
      seed,
      empires,
      map: { width: 24, height: 24, mountains: 0, lakes: 0, rivers: 0, walls: 0 },
      rules: { coinIntervalMin: 1 << 28, coinIntervalMax: 1 << 28, noobSteps: 0, noobTiles: 0 },
    }),
  );
  const s = sim.state;
  s.terrain.fill(TERRAIN.PLAIN);
  s.owner.fill(0);
  s.pop.fill(0);
  s.item.fill(ITEM.NONE);
  s.itemCount = 0;
  for (const e of s.empires) {
    e.tilesOwned = 0;
    e.popTotal = 0;
    e.alive = 1;
    const capital = idx(e.id * 2, 0, s.width);
    e.capital = capital;
    s.owner[capital] = e.id;
    s.pop[capital] = 1;
    e.tilesOwned = 1;
    e.popTotal = 1;
  }
  return sim;
}

/** Tiles an empire holds, ignoring the parked capital. */
function held(sim: Sim, empire: number): number {
  let n = 0;
  for (let i = 0; i < sim.state.owner.length; i++) {
    if (sim.state.owner[i] === empire && i !== sim.state.empires[empire - 1]!.capital) n++;
  }
  return n;
}

function own(sim: Sim, x: number, y: number, empire: number, pop = 1): void {
  const i = idx(x, y, sim.state.width);
  sim.state.owner[i] = empire;
  sim.state.pop[i] = pop;
  const e = sim.state.empires[empire - 1]!;
  e.tilesOwned++;
  e.popTotal += pop;
}

const at = (sim: Sim, x: number, y: number): number => idx(x, y, sim.state.width);
const popAt = (sim: Sim, x: number, y: number): number => sim.state.pop[at(sim, x, y)]!;
const ownerAt = (sim: Sim, x: number, y: number): number => sim.state.owner[at(sim, x, y)]!;

function claimNow(sim: Sim, empire: number, member: number, x: number, y: number): boolean {
  const move = CLAIM(sim.state.step, empire, member, 0, x, y);
  const valid = sim.validate(move);
  if (valid) sim.advance([move]);
  return valid;
}

// --- tests -------------------------------------------------------------------

function testMultiplier(): void {
  console.log("\nsurround multiplier");

  const one = arena([humans(1), humans(1)]);
  own(one, 5, 5, 1);
  one.state.empires[0]!.members[0]!.popTimer = 999;
  claimNow(one, 1, 0, 6, 5);
  eq("one adjacent tile places 999", popAt(one, 6, 5), 999);

  const four = arena([humans(1), humans(1)]);
  own(four, 5, 4, 1);
  own(four, 5, 6, 1);
  own(four, 4, 5, 1);
  own(four, 6, 5, 1);
  four.state.empires[0]!.members[0]!.popTimer = 999;
  claimNow(four, 1, 0, 5, 5);
  eq("four-side surround places 999 x 4", popAt(four, 5, 5), 3996);
}

function testCoins(): void {
  console.log("\ncoin claim radii");

  const cases: Array<[string, number, number, number]> = [
    ["bronze claims 5 tiles", ITEM.BRONZE, 5, 199],
    ["silver claims 13 tiles", ITEM.SILVER, 13, 76],
    ["gold claims 25 tiles", ITEM.GOLD, 25, 39],
  ];

  for (const [label, item, tiles, perTile] of cases) {
    const sim = arena([humans(1), humans(1)]);
    own(sim, 10, 12, 1);
    sim.state.item[at(sim, 11, 12)] = item;
    sim.state.itemCount = 1;
    sim.state.empires[0]!.members[0]!.popTimer = 999;

    claimNow(sim, 1, 0, 11, 12);

    // The claim covers the ball, and the seed tile at (10,12) sits inside it.
    eq(label, held(sim, 1), tiles);
    eq(`  ${label.split(" ")[0]} spreads floor(999/${tiles}) per tile`, popAt(sim, 11, 13), perTile);
    const remainder = 999 - perTile * tiles;
    eq(`  ${label.split(" ")[0]} remainder lands on the coin tile`, popAt(sim, 11, 12), perTile + remainder);
  }
}

function testCascade(): void {
  console.log("\ncoin cascade");

  const sim = arena([humans(1), humans(1)]);
  own(sim, 10, 12, 1);
  sim.state.item[at(sim, 11, 12)] = ITEM.BRONZE;
  sim.state.item[at(sim, 12, 12)] = ITEM.GOLD; // inside the bronze radius
  sim.state.itemCount = 2;
  sim.state.empires[0]!.members[0]!.popTimer = 999;

  claimNow(sim, 1, 0, 11, 12);

  const owned = held(sim, 1);
  ok("a coin inside the radius triggers a chain", owned > 5, `owned ${owned}`);
  eq("chained gold covers its own full radius", ownerAt(sim, 15, 12), 1);
  ok(
    "cascade creates population rather than dividing it",
    popAt(sim, 12, 13) === 199,
    `expected each gold tile to get the bronze's 199/tile, got ${popAt(sim, 12, 13)}`,
  );

  // A bot cannot chain: its coin fires, but triggered coins do not re-trigger.
  const bot = arena([{ control: CONTROL.HUMAN, members: [{ kind: MEMBER.BOT }] }, humans(1)]);
  own(bot, 10, 12, 1);
  bot.state.item[at(bot, 11, 12)] = ITEM.BRONZE;
  bot.state.item[at(bot, 12, 12)] = ITEM.GOLD;
  bot.state.itemCount = 2;
  bot.state.empires[0]!.members[0]!.popTimer = 999;
  claimNow(bot, 1, 0, 11, 12);
  eq("a bot's cascade does not chain", ownerAt(bot, 15, 12), 0);
}

function testTerrain(): void {
  console.log("\nterrain and crossings");

  const sim = arena([humans(1), humans(1)]);
  own(sim, 5, 5, 1);
  sim.state.empires[0]!.members[0]!.popTimer = 999;

  sim.state.terrain[at(sim, 6, 5)] = TERRAIN.MOUNTAIN;
  ok("mountains are impassable", !sim.validate(CLAIM(0, 1, 0, 0, 6, 5)));

  sim.state.terrain[at(sim, 6, 5)] = TERRAIN.LAKE;
  ok("lakes are impassable", !sim.validate(CLAIM(0, 1, 0, 0, 6, 5)));

  sim.state.terrain[at(sim, 6, 5)] = TERRAIN.RIVER;
  ok("rivers block until bridged", !sim.validate(CLAIM(0, 1, 0, 0, 6, 5)));

  const empire = sim.state.empires[0]!;
  ok(
    "a bridge cannot be bought without diamonds",
    !sim.validate({ step: 0, empire: 1, member: 0, seq: 0, type: MOVE.BUY_BRIDGE, x: 0, y: 0 }),
  );

  empire.diamonds = 3;
  sim.advance([{ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.BUY_BRIDGE, x: 0, y: 0 }]);
  eq("buying a bridge spends diamonds", empire.diamonds, 0);
  eq("buying a bridge yields one bridge", empire.bridges, 1);

  sim.advance([{ step: sim.step, empire: 1, member: 0, seq: 0, type: MOVE.PLACE_BRIDGE, x: 6, y: 5 }]);
  eq("a placed bridge converts the tile", sim.state.terrain[at(sim, 6, 5)], TERRAIN.RIVER_BRIDGED);
  ok("a bridged river is passable", sim.validate(CLAIM(sim.step, 1, 0, 0, 6, 5)));
}

function testProtection(): void {
  console.log("\nnoob protection");

  const sim = new Sim(
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

  const victim = sim.state.empires[1]!;
  const capital = victim.capital;
  const cx = capital % sim.state.width;
  const cy = Math.floor(capital / sim.state.width);

  // Attacker adjacent to the protected capital.
  sim.state.owner[idx(cx - 1, cy, sim.state.width)] = 1;
  sim.state.pop[idx(cx - 1, cy, sim.state.width)] = 1;
  sim.state.empires[0]!.tilesOwned++;
  sim.state.empires[0]!.members[0]!.popTimer = 999;

  const before = sim.state.pop[capital]!;
  ok("a protected capital rejects attacks", !sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy)));
  eq("a protected capital takes no damage", sim.state.pop[capital], before);

  // Protection lifts on the timer.
  sim.state.step = 100 * STEPS_PER_SECOND + 1;
  ok("protection lifts once the timer passes", sim.validate(CLAIM(sim.step, 1, 0, 0, cx, cy)));
}

function testTeamTimers(): void {
  console.log("\nteam empires");

  const sim = arena([humans(3), humans(1)]);
  own(sim, 5, 5, 1);
  own(sim, 8, 8, 1);

  for (let i = 0; i < 300; i++) sim.advance([]);

  const [a, b, c] = sim.state.empires[0]!.members;
  eq("member A accrues its own timer", a!.popTimer, 300);
  eq("member B accrues independently", b!.popTimer, 300);
  ok("three members hold three separate timers", a !== b && b !== c);

  // Two members of one empire act on the same step, on different fronts.
  a!.popTimer = 100;
  b!.popTimer = 100;
  const dirty = sim.advance([
    CLAIM(sim.step, 1, 0, 0, 6, 5),
    CLAIM(sim.step, 1, 1, 0, 9, 8),
  ]);
  ok("two members act on the same step", ownerAt(sim, 6, 5) === 1 && ownerAt(sim, 9, 8) === 1);
  ok("both fronts report dirty tiles", dirty.size >= 2);

  // A bot member accrues at half rate and caps lower.
  const team = arena([
    { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN }, { kind: MEMBER.BOT }] },
    humans(1),
  ]);
  own(team, 5, 5, 1);
  for (let i = 0; i < 200; i++) team.advance([]);
  const [human, nightshift] = team.state.empires[0]!.members;
  eq("a human member accrues at full rate", human!.popTimer, 200);
  eq("a bot member accrues at half rate", nightshift!.popTimer, 100);
}

function testVictory(): void {
  console.log("\nwin conditions");

  const capture = arena([humans(1), humans(1)]);
  const victim = capture.state.empires[1]!;
  victim.capital = at(capture, 12, 12);
  capture.state.owner[victim.capital] = 2;
  capture.state.pop[victim.capital] = 1;
  victim.tilesOwned = 1;
  own(capture, 11, 12, 1);
  capture.state.empires[0]!.members[0]!.popTimer = 999;

  claimNow(capture, 1, 0, 12, 12);
  ok("capturing a capital eliminates the empire", capture.state.empires[1]!.alive === 0);
  ok("last empire standing ends the game", capture.ended, `phase ${capture.state.phase}`);
  eq("the survivor wins", capture.state.winner, 1);

  // Abandonment must NOT fire early: being asleep is not being defeated.
  const quiet = arena([humans(1), humans(1)]);
  own(quiet, 5, 5, 1);
  own(quiet, 15, 15, 2);
  quiet.state.empires[0]!.members[0]!.lastBeat = 0;
  quiet.state.step = 60 * STEPS_PER_SECOND; // 1 minute of silence
  quiet.state.empires[0]!.members[0]!.lastBeat = quiet.state.step;
  quiet.advance([]);
  ok("a silent-but-recent roster does not lose", !quiet.ended);

  quiet.state.step = quiet.state.genesis.rules.abandonWindow + 10;
  quiet.state.empires[0]!.members[0]!.lastBeat = quiet.state.step;
  quiet.advance([]);
  ok("abandonment fires past the window", quiet.ended && quiet.state.winner === 1);
}

function testDeterminism(): void {
  console.log("\ndeterminism");

  const spec = () => makeGenesis({ seed: 0xc0ffee, empires: [humans(1), simbot(), simbot(), simbot()] });

  const runA = new Sim(spec());
  const runB = new Sim(spec());
  for (let i = 0; i < 2000; i++) {
    runA.advance([]);
    runB.advance([]);
  }
  eq("two runs of one seed agree", hex(runA.hash()), hex(runB.hash()));
  ok("the game actually progressed", runA.state.empires.some((e) => e.tilesOwned > 1));

  // Snapshot round-trip.
  const buffer = runA.snapshot();
  const clone = new Sim(spec());
  clone.restore(buffer);
  eq("snapshot round-trips to the same hash", hex(clone.hash()), hex(runA.hash()));

  for (let i = 0; i < 200; i++) {
    runA.advance([]);
    clone.advance([]);
  }
  eq("a restored sim continues identically", hex(clone.hash()), hex(runA.hash()));

  // fastForward must equal stepping.
  const stepped = new Sim(spec());
  const jumped = new Sim(spec());
  for (let i = 0; i < 1500; i++) stepped.advance([]);
  jumped.fastForward(1500);
  eq("fastForward equals stepping", hex(jumped.hash()), hex(stepped.hash()));

  // Stats are part of hashed state, so they reproduce exactly.
  const sa = JSON.stringify(runA.summary());
  const rerun = new Sim(spec());
  for (let i = 0; i < 2200; i++) rerun.advance([]);
  eq("stats reproduce across runs", JSON.stringify(rerun.summary()), sa);
}

function testFastForwardCost(): void {
  console.log("\noffline catch-up");

  const genesis = makeGenesis({ seed: 99, empires: [humans(1), simbot()] });
  const sim = new Sim(genesis);
  const sixHours = 6 * 60 * 60 * STEPS_PER_SECOND;

  const started = Date.now();
  sim.fastForward(sixHours);
  const elapsed = Date.now() - started;

  eq("the clock advanced six hours", sim.step >= sixHours || sim.ended, true);
  ok(`six offline hours caught up in ${elapsed}ms`, elapsed < 10000, `${elapsed}ms`);
}

// --- entry -------------------------------------------------------------------

function selftest(): void {
  console.log("\x1b[1mTessera — Phase A verification\x1b[0m");
  testMultiplier();
  testCoins();
  testCascade();
  testTerrain();
  testProtection();
  testTeamTimers();
  testVictory();
  testDeterminism();
  testFastForwardCost();

  console.log(
    `\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${checks - failures}/${checks} checks passed\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function run(): void {
  const seed = Number(process.argv[3] ?? 0xc0ffee) >>> 0;
  const steps = Number(process.argv[4] ?? 3000);

  const sim = new Sim(
    makeGenesis({ seed, empires: [humans(1), simbot(), simbot(), simbot()] }),
  );
  sim.fastForward(steps);

  console.log(`seed      ${seed}`);
  console.log(`steps     ${sim.step}`);
  console.log(`hash      ${hex(sim.hash())}`);
  console.log(`phase     ${sim.ended ? `ended, winner ${sim.state.winner}` : "playing"}`);
  console.table(
    sim.summary().map((e) => ({
      empire: e.id,
      alive: e.alive,
      tiles: e.tilesOwned,
      peak: e.peakTiles,
      pop: e.popTotal,
      coins: e.coins.bronze + e.coins.silver + e.coins.gold,
      cascade: e.largestCascade.tiles,
    })),
  );
}

if (process.argv.includes("--selftest")) selftest();
else run();
