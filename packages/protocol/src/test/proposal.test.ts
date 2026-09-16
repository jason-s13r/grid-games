// A genesis everybody signed.
//
// Two claims carry this whole design, and everything below is one of them:
//
//   * **`composeGenesis` ∘ `proposalOf` is the identity** on every record
//     `composeGenesis` produces. If it is not, a consent signed over a world
//     cannot be checked against the record that world composed into, and the
//     feature is decoration.
//   * **Two peers sealing the same proposal and the same consent set produce
//     byte-identical records.** If they do not, they derive different game ids
//     and never meet — which is the failure this file exists to make loud.

import { beforeAll, describe, expect, it } from "vitest";
import { CONTROL, DEFAULT_RULES, DIFFICULTY, MEMBER, PROTOCOL_VERSION, hours } from "@tessera/sim";
import type { BotProfile, Genesis } from "@tessera/sim";
import { Identity } from "../identity.js";
import { canonicalJson, gameIdOf, inspectGenesis, sealGenesis } from "../genesis.js";
import {
  checkConsent,
  composeGenesis,
  orderConsents,
  proposalFrom,
  proposalId,
  proposalOf,
} from "../proposal.js";
import type { Proposal } from "../proposal.js";
import { signConsent, verifyConsent } from "../records.js";
import type { SignedConsent } from "../records.js";

let people: Identity[] = [];

beforeAll(async () => {
  people = await Promise.all(Array.from({ length: 6 }, () => Identity.generate()));
});

const world = (over: Partial<Proposal> = {}): Proposal => ({
  ...proposalFrom({ seed: 4242, startedAt: 1_700_000_000_000 }),
  ...over,
});

const consentsFor = async (id: string, who: Identity[]): Promise<SignedConsent[]> =>
  Promise.all(who.map((one) => signConsent(one, id)));

const sign = async (p: Proposal, who: Identity[]): Promise<SignedConsent[]> =>
  consentsFor(await proposalId(p), who);

describe("the proposal id", () => {
  it("does not depend on key insertion order", async () => {
    const p = world();
    const shuffled = {
      vacancies: p.vacancies,
      simbots: p.simbots,
      rules: p.rules,
      map: p.map,
      startedAt: p.startedAt,
      seed: p.seed,
      protocol: p.protocol,
    } as Proposal;
    expect(await proposalId(shuffled)).toBe(await proposalId(p));
  });

  it("moves when any single field moves", async () => {
    const base = await proposalId(world());
    const moved = await Promise.all([
      proposalId(world({ seed: 4243 })),
      proposalId(world({ startedAt: 1_700_000_000_001 })),
      proposalId(world({ vacancies: 1 })),
      proposalId(world({ simbots: [DIFFICULTY.easy] })),
      proposalId(world({ protocol: PROTOCOL_VERSION + 1 })),
      proposalId(world({ map: { ...world().map, width: 97 } })),
      proposalId(world({ rules: { ...DEFAULT_RULES, endStep: hours(3) } })),
    ]);
    for (const one of moved) expect(one).not.toBe(base);
    expect(new Set(moved).size).toBe(moved.length);
  });

  // The seed is random rather than derived from a room code and a clock, so two
  // identical-looking worlds in two different rooms are distinct objects. That
  // is the whole reason a consent can stand in a proposal id where every other
  // record carries a game id.
  it("a consent does not verify against a different world", async () => {
    const p = world();
    const [signed] = await sign(p, [people[0]!]);
    expect(await verifyConsent(signed!, await proposalId(p))).toBe(true);
    expect(await verifyConsent(signed!, await proposalId(world({ vacancies: 1 })))).toBe(false);
  });

  it("a consent lifted onto another proposal id is refused before the signature", async () => {
    const p = world();
    const [signed] = await sign(p, [people[0]!]);
    const lifted = { ...signed!, proposalId: await proposalId(world({ seed: 9 })) };
    expect(await verifyConsent(lifted, lifted.proposalId)).toBe(false);
  });
});

describe("composition", () => {
  // The claim the whole plan rests on. If the inverse is not exact, no consent
  // ever verifies against the record its world composed into.
  it("proposalOf recovers every proposal composeGenesis was given", async () => {
    const profiles: BotProfile[][] = [
      [],
      [DIFFICULTY.easy],
      [DIFFICULTY.hard, DIFFICULTY.easy],
      [{ popMax: 51, coins: 7, phases: { expand: { steps: 60, rate: [12, 24] } } }],
    ];
    for (let signers = 1; signers <= 6; signers++) {
      for (let vacancies = 0; vacancies <= 3; vacancies++) {
        for (const simbots of profiles) {
          const p = world({ vacancies, simbots });
          const consents = await sign(p, people.slice(0, signers));
          const recovered = proposalOf(composeGenesis(p, consents));
          expect(recovered, `${signers} signers, ${vacancies} vacancies`).toBeDefined();
          expect(canonicalJson(recovered!)).toBe(canonicalJson(p));
        }
      }
    }
  });

  // Byte-identical, not merely equivalent: a game id is a hash, so "nearly the
  // same record" is a different game and two peers that produce one never meet.
  it("two peers sealing one proposal and one consent set agree on the game id", async () => {
    const p = world({ vacancies: 1, simbots: [DIFFICULTY.steady] });
    const consents = await sign(p, people.slice(0, 3));

    const mine = composeGenesis(p, consents);
    // The other peer holds the same signatures in whatever order they arrived.
    const theirs = composeGenesis(p, [consents[2]!, consents[0]!, consents[1]!]);

    expect(canonicalJson(theirs)).toBe(canonicalJson(mine));
    expect(await gameIdOf(theirs)).toBe(await gameIdOf(mine));
  });

  it("the roster is the signers, in key order, and the layout is fixed", async () => {
    const p = world({ vacancies: 2, simbots: [DIFFICULTY.easy, DIFFICULTY.hard] });
    const consents = await sign(p, people.slice(0, 3));
    const genesis = composeGenesis(p, consents);
    const keys = [...consents].map((one) => one.key).sort();

    expect(genesis.empires).toHaveLength(3 + 2 + 2);
    expect(genesis.empires.slice(0, 3).map((e) => e.members[0]!.key)).toEqual(keys);
    for (const empire of genesis.empires.slice(3, 5)) expect(empire.members).toHaveLength(0);
    for (const empire of genesis.empires.slice(5)) expect(empire.control).toBe(CONTROL.SIMBOT);
  });

  // The deadlock this design exists to avoid, asserted rather than argued: the
  // world names nobody, so nobody else arriving can void a signature over it.
  it("a consent survives three more signers arriving", async () => {
    const p = world();
    const id = await proposalId(p);
    const early = await consentsFor(id, [people[0]!]);
    const late = await consentsFor(id, people.slice(1, 4));

    expect((await checkConsent(composeGenesis(p, early))).state).toBe("checked");
    const grown = composeGenesis(p, [...early, ...late]);
    expect((await checkConsent(grown)).state).toBe("checked");
    expect(grown.consent).toHaveLength(4);
  });

  it("the same key consenting twice is one seat", async () => {
    const p = world();
    const twice = await sign(p, [people[0]!, people[1]!, people[0]!]);
    expect(orderConsents(twice)).toHaveLength(2);
    expect(composeGenesis(p, twice).empires).toHaveLength(2);
  });

  it("a composed record is one this build will join", async () => {
    const p = world({ vacancies: 1, simbots: [DIFFICULTY.easy] });
    const sealed = await sealGenesis(composeGenesis(p, await sign(p, people.slice(0, 2))));
    expect(await inspectGenesis(sealed)).toEqual([]);
  });
});

describe("the dishonest sealer", () => {
  // Every row of the table that argues sealing is clerical, as one test each.
  // None of them needs its own branch in `checkConsent`: they all fail the same
  // recomposition, which is the point of verifying by rebuild rather than by
  // audit.
  const tampered: Record<string, (genesis: Genesis, strangerKey: string) => Genesis> = {
    "an altered rule": (g) => ({ ...g, rules: { ...g.rules, abandonWindow: hours(99) } }),
    "an altered map": (g) => ({ ...g, map: { ...g.map, width: g.map.width + 1 } }),
    "a moved start time": (g) => ({ ...g, startedAt: g.startedAt + 1 }),
    "a seated non-signer": (g, key) => ({
      ...g,
      empires: [...g.empires, { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key }] }],
    }),
    "a signer dropped from the roster but left in the list": (g) => ({
      ...g,
      empires: g.empires.slice(1),
    }),
    "a reordered roster": (g) => ({ ...g, empires: [...g.empires].reverse() }),
    "a swapped bot profile": (g) => ({
      ...g,
      empires: g.empires.map((empire) =>
        empire.control === CONTROL.SIMBOT
          ? { ...empire, members: [{ kind: MEMBER.BOT, bot: DIFFICULTY.hard }] }
          : empire,
      ),
    }),
    "an extra vacancy": (g) => ({
      ...g,
      empires: [...g.empires, { control: CONTROL.HUMAN, members: [] }],
    }),
    "a forged signature": (g) => ({
      ...g,
      consent: g.consent!.map((one, at) => (at === 0 ? { ...one, sig: "not-a-signature" } : one)),
    }),
  };

  it.each(Object.keys(tampered))("%s is refused", async (what) => {
    const p = world({ vacancies: 1, simbots: [DIFFICULTY.easy] });
    const honest = composeGenesis(p, await sign(p, people.slice(0, 3)));
    expect((await checkConsent(honest)).state).toBe("checked");

    const forged = tampered[what]!(honest, people[5]!.key);
    expect((await checkConsent(forged)).state).toBe("failed");
    // And it is a refusal a joiner actually sees, not one buried in a helper.
    expect(await inspectGenesis(await sealGenesis(forged))).toContain("consent");
  });
});

describe("the power the sealer does keep", () => {
  // Dropping a signer *and* their consent is not a tamper `checkConsent` can
  // catch, and the plan's verification table is wrong to list it among the five
  // it refuses. The record that comes out is a smaller game whose every
  // signature covers the world it composes — which is exactly what sealing a
  // subset *is*, and the one power the "sealing is clerical" argument
  // deliberately grants: deciding who was late.
  //
  // So the exclusion check cannot be stateless. It is the lobby's, against what
  // this peer actually signed — see `lobby.test.ts`.
  it("a sealer may seal a subset, and the record still verifies", async () => {
    const p = world();
    const consents = await sign(p, people.slice(0, 3));
    const without = composeGenesis(p, consents.slice(1));

    expect((await checkConsent(without)).state).toBe("checked");
    expect(await inspectGenesis(await sealGenesis(without))).toEqual([]);
    expect(without.empires).toHaveLength(2);
  });

  // What it cannot do is seal two different games from one set and have both
  // pass as the same game: each is its own record with its own id.
  it("two subsets are two different games", async () => {
    const p = world();
    const consents = await sign(p, people.slice(0, 3));
    const a = await gameIdOf(composeGenesis(p, consents.slice(0, 2)));
    const b = await gameIdOf(composeGenesis(p, consents.slice(1, 3)));
    expect(a).not.toBe(b);
  });
});

describe("what a reader is told", () => {
  // Three states rather than two. The one real objection to shipping this
  // without a protocol bump is that an unverified list looks like proof — and a
  // verdict that separates checked from absent from failed cannot be.
  it("a record with no consent field claims nothing and fails nothing", async () => {
    const p = world();
    const { consent: _dropped, ...bare } = composeGenesis(p, await sign(p, [people[0]!]));
    const verdict = await checkConsent(bare as Genesis);
    expect(verdict.state).toBe("absent");
    expect(await inspectGenesis(await sealGenesis(bare as Genesis))).toEqual([]);
  });

  it("a checked record says how many seats signed it", async () => {
    const p = world({ simbots: [DIFFICULTY.easy] });
    const verdict = await checkConsent(composeGenesis(p, await sign(p, people.slice(0, 3))));
    expect(verdict).toEqual({ state: "checked", signed: 3, seats: 3 });
  });

  // A SimBot seat has no key and is nobody's to agree to, so it is not a seat a
  // consent could be owed for.
  it("a bot empire is not counted as an unsigned seat", async () => {
    const p = world({ simbots: [DIFFICULTY.easy, DIFFICULTY.hard] });
    const verdict = await checkConsent(composeGenesis(p, await sign(p, [people[0]!])));
    expect(verdict.seats).toBe(1);
  });
});

describe("records this function did not produce", () => {
  it("proposalOf declines a hand-built roster it cannot have composed", () => {
    const shapes: Genesis["empires"][] = [
      // A team: two seats on one empire. Legal, and not a composed game.
      [{ control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: "b" }, { kind: MEMBER.HUMAN, key: "c" }] }],
      // Signers out of key order — the tamper that would otherwise move a capital.
      [
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: "z" }] },
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: "a" }] },
      ],
      // A signer after a vacancy: the layout is part of the format.
      [
        { control: CONTROL.HUMAN, members: [] },
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: "a" }] },
      ],
      // A bot empire before a vacancy, for the same reason.
      [
        { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT, bot: DIFFICULTY.easy }] },
        { control: CONTROL.HUMAN, members: [] },
      ],
    ];
    for (const empires of shapes) {
      const genesis = { ...composeGenesis(world(), []), empires } as Genesis;
      expect(proposalOf(genesis), canonicalJson(empires)).toBeUndefined();
    }
  });

  // `canonicalJson` throws on a non-finite number and proposals now arrive from
  // strangers, so every hash of an untrusted object reads a throw as a refusal.
  it("a non-finite number in a record is a refusal, never a throw", async () => {
    const p = world();
    const genesis = composeGenesis(p, await sign(p, [people[0]!]));
    const poisoned = { ...genesis, seed: Number.NaN } as Genesis;
    await expect(checkConsent(poisoned)).resolves.toMatchObject({ state: "failed" });
  });

  it("an empty consent list is a claim that fails, not an absence", async () => {
    const genesis = { ...composeGenesis(world(), []), consent: [] } as unknown as Genesis;
    expect((await checkConsent(genesis)).state).toBe("failed");
  });
});
