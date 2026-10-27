// The genesis record is the root of trust, and its hash is the game id. If two
// peers can be made to compute different ids for the same record, or the same
// id for different ones, nothing built on top of it means anything.

import { beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL,
  DEFAULT_RULES,
  MEMBER,
  MIN_ABANDON_WINDOW,
  durationRules,
  hours,
  MAX_EMPIRES,
  makeGenesis,
} from "@tessera/sim";
import type { Genesis, Rules } from "@tessera/sim";
import { canonicalJson, gameIdOf, inspectGenesis, sealGenesis } from "../genesis.js";
import { fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});

describe("canonical records", () => {
  it("key order does not change the encoding", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalJson({ a: [2, { c: 3, d: 4 }] as unknown[], b: 1 }),
    );
  });

  it("undefined fields are dropped", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  // NaN and Infinity have no JSON spelling, so serialising one would silently
  // become null and two peers would hash different records as the same.
  it("a non-finite number is refused", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("genesis", () => {
  it("the game id is a sha-256 digest", () => expect(f.gameId).toHaveLength(64));

  it("sealing is idempotent", async () => {
    await expect(gameIdOf(f.genesis)).resolves.toBe(f.gameId);
  });

  it("any change moves the game id", async () => {
    await expect(gameIdOf({ ...f.genesis, seed: 8 })).resolves.not.toBe(f.gameId);
  });

  it("a well-formed genesis has no problems", async () => {
    await expect(inspectGenesis(f.genesis)).resolves.toEqual([]);
  });

  it("a tampered game id is caught", async () => {
    expect(await inspectGenesis({ ...f.genesis, seed: 8 })).toContain("gameId");
  });

  it("a mismatched protocol is refused", async () => {
    expect(await inspectGenesis({ ...f.base, protocol: 99 } as Genesis)).toContain("protocol");
  });

  // A host who sets abandonWindow low enough wins before anyone moves: every
  // opponent is "absent" the first time the composer is the only empire to
  // have played inside a second. Every peer would verify that record happily,
  // because nothing else here reads a number out of `rules`.
  describe("a rule set a host could win with", () => {
    const withRules = (rules: Partial<Rules>) =>
      ({
        ...f.genesis,
        rules: { ...f.genesis.rules, ...rules },
      }) as Genesis;

    it("refuses an abandonment window below the floor", async () => {
      expect(await inspectGenesis(withRules({ abandonWindow: 12 }))).toContain("rules");
    });

    it("accepts one exactly at the floor", async () => {
      const problems = await inspectGenesis(
        withRules({ abandonWindow: MIN_ABANDON_WINDOW }),
      );
      expect(problems).not.toContain("rules");
    });

    it("accepts a scaled window from a real duration", async () => {
      const problems = await inspectGenesis(withRules(durationRules(hours(240))));
      expect(problems).not.toContain("rules");
    });

    it("refuses a negative window", async () => {
      expect(await inspectGenesis(withRules({ joinWindow: -1 }))).toContain("rules");
      expect(await inspectGenesis(withRules({ endStep: -1 }))).toContain("rules");
    });

    it("says nothing about a record that names no windows at all", async () => {
      // Every genesis written before v4 is one of these. The check is
      // unconditional on version precisely because it can only ever refuse.
      expect(await inspectGenesis(f.genesis)).not.toContain("rules");
    });
  });

  // Attribution is by roster seat, so one key in two seats would make a move
  // ambiguous about which timer it spent.
  it("one key cannot hold two seats", async () => {
    const doubled = await sealGenesis(
      makeGenesis({
        seed: 1,
        empires: [
          {
            control: CONTROL.HUMAN,
            members: [
              { kind: MEMBER.HUMAN, key: f.alice.key },
              { kind: MEMBER.HUMAN, key: f.alice.key },
            ],
          },
        ],
      }),
    );
    expect(await inspectGenesis(doubled)).toContain("duplicate-key");
  });

  // The seat cap is checked here as well as on every amendment, because the
  // genesis record is the one place an empire could be born oversized. A peer
  // that only checked amendments would join the unfair game and then faithfully
  // enforce fairness for the rest of it.
  it("an empire born over the seat cap is refused", async () => {
    const crowded = await sealGenesis(
      makeGenesis({
        seed: 1,
        empires: [
          {
            control: CONTROL.HUMAN,
            members: Array.from({ length: DEFAULT_RULES.maxSeats + 1 }, (_, i) => ({
              kind: MEMBER.HUMAN,
              key: `k${i}`,
            })),
          },
        ],
      }),
    );
    expect(await inspectGenesis(crowded)).toContain("seats");
  });

  it("and one filled to it is not", async () => {
    const full = await sealGenesis(
      makeGenesis({
        seed: 1,
        empires: [
          {
            control: CONTROL.HUMAN,
            members: Array.from({ length: DEFAULT_RULES.maxSeats }, (_, i) => ({
              kind: MEMBER.HUMAN,
              key: `k${i}`,
            })),
          },
        ],
      }),
    );
    expect(await inspectGenesis(full)).toEqual([]);
  });
});

// An empire the map generator will place and nobody has claimed.
//
// The interesting thing about this record is not that it is accepted; it is
// *how* it says what it says. A vacancy is the empty members array and nothing
// else — no flag in `rules`, no sentinel key — and that choice is the whole
// reason vacancies need no protocol bump.
//
// An empty members array was already an error to every build written before
// them: `inspectGenesis` pushed "members" and the lobby declined the game. So
// an older peer handed one of these *refuses to play*, today, with no new code,
// which is exactly the outcome a version number exists to produce. A flag in
// `rules` would be read straight past by that same peer, and the disagreement
// would surface as a desync three hours in.
//
// So the tests below are as much about the encoding as about the check.
describe("a game with empires nobody has claimed", () => {
  const withEmpires = (empires: Genesis["empires"]): Genesis =>
    ({ ...f.base, empires }) as Genesis;

  const human = (key: string) => ({
    control: CONTROL.HUMAN,
    members: [{ kind: MEMBER.HUMAN, key }],
  });
  const vacancy = () => ({ control: CONTROL.HUMAN, members: [] });

  it("is accepted beside an empire somebody is playing", async () => {
    const genesis = withEmpires([human(f.alice.key), vacancy()]);
    await expect(inspectGenesis(await sealGenesis(genesis))).resolves.toEqual([]);
  });

  it("is expressed as an empty members array, which is what makes the bump unnecessary", async () => {
    // The property, asserted directly rather than inferred from the check
    // passing. If a later change moved vacancy into `rules`, this is the test
    // that would notice — and the failure would be the right one, because an
    // old peer reads an unknown rule and plays on.
    const genesis = withEmpires([human(f.alice.key), vacancy()]);
    expect(genesis.empires[1]!.members).toHaveLength(0);
    // And the other half: *which* empires are vacant is nowhere but in
    // `empires`. The rules carry the shield's radius and the grant — numbers
    // that describe a game, and that an older peer reading them as unknown
    // fields plays on happily, which is correct because with no vacancy in the
    // record neither number does anything. Two records that differ only by a
    // vacancy therefore have byte-identical rules, and that is what keeps the
    // refusal in the one field that was always an error.
    const without = withEmpires([human(f.alice.key)]);
    expect(canonicalJson(genesis.rules ?? {})).toBe(canonicalJson(without.rules ?? {}));
  });

  it("is refused for a SimBot empire, which nothing would ever play", async () => {
    const genesis = withEmpires([
      human(f.alice.key),
      { control: CONTROL.SIMBOT, members: [] },
    ]);
    expect(await inspectGenesis(await sealGenesis(genesis))).toContain("members");
  });

  it("is refused when nobody at all is seated", async () => {
    // Every check above passes on a record of nothing but vacancies, and then
    // the first victory pass ends it with no winner. Somebody has to be playing.
    const genesis = withEmpires([vacancy(), vacancy()]);
    expect(await inspectGenesis(await sealGenesis(genesis))).toContain("members");
  });

  it("still refuses a members field that is not a list", async () => {
    const genesis = withEmpires([
      human(f.alice.key),
      { control: CONTROL.HUMAN, members: undefined },
    ] as unknown as Genesis["empires"]);
    expect(await inspectGenesis(await sealGenesis(genesis))).toContain("members");
  });
});

describe("banners in a sealed record", () => {
  const game = (empires: Genesis["empires"]): Genesis =>
    makeGenesis({ seed: 1, map: { width: 24, height: 24 }, empires });

  const two = (a?: string, b?: string): Genesis["empires"] => [
    { control: CONTROL.HUMAN, ...(a ? { banner: a } : {}), members: [{ kind: MEMBER.HUMAN, key: "k1" }] },
    { control: CONTROL.HUMAN, ...(b ? { banner: b } : {}), members: [{ kind: MEMBER.HUMAN, key: "k2" }] },
  ];

  it("accepts a record whose empires fly different houses", async () => {
    expect(await inspectGenesis(game(two("cobalt", "amber")))).toEqual([]);
  });

  it("accepts a record with no banners at all, which is every record so far", async () => {
    expect(await inspectGenesis(game(two()))).toEqual([]);
  });

  // Two empires wearing one flag is an unreadable board, refused here as well
  // as in `checkPlan` — the two-place rule the seat cap already follows.
  it("refuses two empires flying one banner", async () => {
    expect(await inspectGenesis(game(two("cobalt", "cobalt")))).toContain("duplicate-banner");
  });

  it("refuses a banner that is not in the table", async () => {
    expect(await inspectGenesis(game(two("sping", "amber")))).toContain("duplicate-banner");
  });

  // `canonicalJson` drops `undefined` and keeps `null`, so a record spelling an
  // absent banner as `null` would hash differently while meaning the same thing.
  it("refuses a banner written as null", async () => {
    const empires = two();
    (empires[0] as { banner?: unknown }).banner = null;
    expect(await inspectGenesis(game(empires))).toContain("duplicate-banner");
  });

  // The honest half of a bug that is not a repaint: `state.owner` is an
  // `Int8Array`, so an id above 127 stores negative, every `owner > 0` test
  // reads that territory as neutral, and `tilesOwned` only ever grows. The
  // check used to advertise 255.
  it("refuses more empires than the owner layer can hold", async () => {
    const many = Array.from({ length: 128 }, (_, i) => ({
      control: CONTROL.HUMAN,
      members: [{ kind: MEMBER.HUMAN, key: `k${i}` }],
    }));
    expect(await inspectGenesis(game(many))).toContain("empires");
  });

  // And a cap that bites long before that one.
  it("refuses more empires than there are banners", async () => {
    const many = Array.from({ length: MAX_EMPIRES + 1 }, (_, i) => ({
      control: CONTROL.HUMAN,
      members: [{ kind: MEMBER.HUMAN, key: `k${i}` }],
    }));
    expect(await inspectGenesis(game(many))).toContain("empires");
  });
});
