// Which versions this build plays, and when it stops playing them.
//
// The awkward thing about this file on the day it ships: SUPPORTED_PROTOCOLS
// has one entry, so every production call site asks a question with one
// possible answer. A predicate nobody can move is a predicate nobody has
// tested, which is why `playsProtocol` takes the set as a parameter — the
// tests below hand in sets this build will not have for a year and exercise
// the behaviour before the constant does.
//
// The sunset assertions are the other half, and they are an alarm clock: the
// suite goes red on the day a version is due to be dropped, rather than on the
// day somebody notices a game has quietly stopped working.

import { describe, expect, it } from "vitest";
import {
  PROTOCOL_SUNSET,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  playsProtocol,
  shelfLife,
} from "../constants.js";
import { makeGenesis, Sim } from "../sim.js";
import { humans } from "../specs.js";
import type { Genesis } from "../types.js";
import { RECORDED } from "./fixtures/index.js";

const genesisAt = (protocol: number): Genesis => ({
  ...makeGenesis({ seed: 1, empires: [humans(1), humans(1)] }),
  protocol,
});

describe("playsProtocol", () => {
  it("answers over a set it is handed, not the one this build ships", () => {
    expect(playsProtocol(4, [4, 3])).toBe(true);
    expect(playsProtocol(3, [4, 3])).toBe(true);
    expect(playsProtocol(2, [4, 3])).toBe(false);
    expect(playsProtocol(4, [3])).toBe(false);
  });

  it("defaults to this build's set", () => {
    expect(playsProtocol(PROTOCOL_VERSION)).toBe(true);
    expect(playsProtocol(PROTOCOL_VERSION + 1)).toBe(false);
  });
});

describe("the supported set", () => {
  it("leads with the version this build composes", () => {
    expect(SUPPORTED_PROTOCOLS[0]).toBe(PROTOCOL_VERSION);
  });

  it("is descending and free of duplicates", () => {
    const sorted = [...SUPPORTED_PROTOCOLS].sort((a, b) => b - a);
    expect([...SUPPORTED_PROTOCOLS]).toEqual(sorted);
    expect(new Set(SUPPORTED_PROTOCOLS).size).toBe(SUPPORTED_PROTOCOLS.length);
  });

  it("supports at most the current version and its predecessor", () => {
    // N and N-1 only. A third entry is a third gated branch to maintain, and
    // the retirement rule exists so the array cannot grow by inattention.
    expect(SUPPORTED_PROTOCOLS.length).toBeLessThanOrEqual(2);
  });
});

describe("retirement", () => {
  it("dates every superseded version and only those", () => {
    const dated = Object.keys(PROTOCOL_SUNSET).map(Number).sort((a, b) => b - a);
    const superseded = SUPPORTED_PROTOCOLS.filter((v) => v !== PROTOCOL_VERSION);
    expect(dated).toEqual([...superseded].sort((a, b) => b - a));
  });

  it("has not passed a sunset date", () => {
    // The alarm. When this fails the fix is to drop that version from
    // SUPPORTED_PROTOCOLS, delete its fixture and remove its gated branches —
    // not to move the date.
    for (const [version, until] of Object.entries(PROTOCOL_SUNSET)) {
      const day = Date.parse(`${until}T00:00:00Z`);
      expect(Number.isNaN(day), `v${version} sunset "${until}" is not ISO`).toBe(
        false,
      );
      expect(day, `v${version} was due to be dropped on ${until}`).toBeGreaterThan(
        Date.now(),
      );
    }
  });
});

describe("the fixture set", () => {
  it("has a recorded game for every supported version", () => {
    const recorded = RECORDED.map((r) => r.genesis.protocol).sort((a, b) => b - a);
    expect(recorded).toEqual([...SUPPORTED_PROTOCOLS].sort((a, b) => b - a));
  });

  it("records no version this build does not support", () => {
    // The other direction, and the one that makes retirement honest: drop a
    // version from SUPPORTED_PROTOCOLS and crossenv fails on exactly that
    // fixture, while this test says the fix is to delete the file.
    for (const recorded of RECORDED) {
      expect(
        playsProtocol(recorded.genesis.protocol),
        `recorded-v${recorded.genesis.protocol}.json has no supported version`,
      ).toBe(true);
    }
  });

  it("proves the bump moved nothing", () => {
    // record() is deterministic in the seed and draws its hand from
    // Rng(seed ^ 0x5eed); none of that reads the protocol number. So two
    // fixtures recorded at the same seed under different versions must reach
    // the same hash, and that is a stronger claim than "crossenv still
    // passes": crossenv proves each fixture reproduces itself, and this
    // proves the bump changed nothing about what a game *is*.
    const hashes = new Set(RECORDED.map((r) => r.hash));
    expect(hashes.size, [...hashes].join(" != ")).toBe(1);
  });

  it("records the same game under every version", () => {
    const shape = RECORDED.map((r) => `${r.steps}/${r.moveLog.length}`);
    expect(new Set(shape).size).toBe(1);
  });

  it("names each fixture by the version it recorded", () => {
    for (const recorded of RECORDED) {
      expect(recorded.note).toContain(`v${recorded.genesis.protocol}`);
    }
  });
});

describe("shelfLife", () => {
  it("says nothing about a game on the current version", () => {
    expect(shelfLife(genesisAt(PROTOCOL_VERSION))).toBeNull();
  });

  it("names the version and its date for a superseded game", () => {
    const [version, until] = Object.entries(PROTOCOL_SUNSET)[0] ?? [];
    if (version === undefined) return; // no superseded version yet; see 0002
    expect(shelfLife(genesisAt(Number(version)))).toEqual({
      version: Number(version),
      until,
    });
  });
});

describe("the constructor's refusal", () => {
  it("still refuses a version nobody supports", () => {
    // Widening the accepted set must not widen it to everything.
    expect(() => new Sim(genesisAt(99))).toThrow(/protocol mismatch/);
  });

  it("names every version it plays, not just the one it composes", () => {
    let message = "";
    try {
      new Sim(genesisAt(99));
    } catch (err) {
      message = (err as Error).message;
    }
    for (const version of SUPPORTED_PROTOCOLS) {
      expect(message).toContain(`v${version}`);
    }
  });

  it("accepts every supported version", () => {
    for (const version of SUPPORTED_PROTOCOLS) {
      expect(() => new Sim(genesisAt(version))).not.toThrow();
    }
  });
});
