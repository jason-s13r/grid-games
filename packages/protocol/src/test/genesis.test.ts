// The genesis record is the root of trust, and its hash is the game id. If two
// peers can be made to compute different ids for the same record, or the same
// id for different ones, nothing built on top of it means anything.

import { beforeAll, describe, expect, it } from "vitest";
import { CONTROL, DEFAULT_RULES, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
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
