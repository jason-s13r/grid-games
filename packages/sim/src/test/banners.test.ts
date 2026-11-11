// The banner table, and the one property that makes it safe to grow.
//
// A record written before banners existed carries no banner field and falls
// back to its **empire index**. So the table's order is not presentation — it
// is the meaning of every archived game, and moving an entry repaints history.
//
// The fixture below is the whole point of this file. It is a list of ids in
// their committed order, and it is compared against a prefix of the live table.
// Appending passes; reordering, renaming an id, or removing one fails.

import { describe, expect, it } from "vitest";
import { BANNERS, MAX_EMPIRES, PATTERNS, bannerAt, bannerById, flyBanners, mapColour } from "../banners.js";
import { Sim, makeGenesis } from "../sim.js";
import { humans, simbot } from "../specs.js";

/** The ids in their committed order. **Append to this, never edit it.**
 *
 *  The first six are the themes the web client shipped with, in the order it
 *  had them. A record with no banner field says "empire 3 flies whatever is
 *  third", so this list is what that record means. */
const COMMITTED = [
  "vermilion",
  "verdant",
  "cobalt",
  "amber",
  "amethyst",
  "cyan",
  "marigold",
  "rose",
  "slate",
  "moss",
  "indigo",
  "sand",
  "peony",
  "ink",
  "plum",
  "tide",
  "zest",
  "kestrel",
  "lagoon",
  "orchid",
  "mint",
  "lumen",
  "sping",
];

describe("the banner table", () => {
  it("is append-only: every committed id keeps its position", () => {
    const live = BANNERS.map((banner) => banner.id);
    expect(live.slice(0, COMMITTED.length)).toEqual(COMMITTED);
  });

  it("has unique ids", () => {
    const ids = BANNERS.map((banner) => banner.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique colours, because two houses that look alike are one house", () => {
    const colours = BANNERS.map((banner) => `${banner.c1}/${banner.c2}`);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it("mixes each house's map colour from both of its colours", () => {
    const sping = bannerById("sping")!;
    expect(mapColour(sping)).not.toBe(sping.c1);
    expect(mapColour(sping)).not.toBe(sping.c2);
  });

  it("keeps every house's map colour apart from every other's", () => {
    // The zoomed-out map and the minimap draw a house in this one colour, so
    // two that land close together are one house there.
    const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const colours = BANNERS.map((banner) => rgb(mapColour(banner)));
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        const apart = Math.hypot(...colours[i]!.map((v, k) => v - colours[j]![k]!));
        expect(apart, `${BANNERS[i]!.id} and ${BANNERS[j]!.id}`).toBeGreaterThan(30);
      }
    }
  });

  it("draws every house with a pattern the client knows", () => {
    for (const banner of BANNERS) expect(PATTERNS).toContain(banner.pattern);
  });

  it("stores ids, never display names", () => {
    // A rename must be a one-line edit that every archive picks up on its next
    // replay. That is only true while the id and the name are separate fields.
    for (const banner of BANNERS) {
      expect(banner.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(banner.id).not.toBe(banner.name);
    }
  });
});

describe("the fallback", () => {
  // The claim "growing the table is a pure data change" is false if the
  // fallback wraps: `(id - 1) % length` makes it a function of the table's
  // length, so appending would turn empire 7 from banner 1 into banner 7 for
  // every record ever written. This is that failure, asserted away.
  it("indexes rather than wrapping", () => {
    expect(bannerAt(1)!.id).toBe(COMMITTED[0]);
    expect(bannerAt(7)!.id).toBe(COMMITTED[6]);
    // Past the end is undefined, not a wrap back to the start — a game that
    // should have been refused at composition.
    expect(bannerAt(MAX_EMPIRES + 1)).toBeUndefined();
    expect(bannerAt(0)).toBeUndefined();
  });

  it("does not depend on the table's length", () => {
    // Appending cannot change what any existing empire index means, which is
    // the whole property. Proved by construction: `bannerAt` reads BANNERS[i]
    // with no arithmetic on `.length` in it.
    const before = Array.from({ length: 6 }, (_, i) => bannerAt(i + 1)!.id);
    expect(before).toEqual(COMMITTED.slice(0, 6));
  });

  it("looks a banner up by id, and says no to one that is not there", () => {
    expect(bannerById("cobalt")!.name).toBe("Cobalt");
    expect(bannerById("sping")!.name).toBe("Sping");
    expect(bannerById("nonesuch")).toBeUndefined();
    expect(bannerById(undefined)).toBeUndefined();
  });
});

describe("a banner is inert", () => {
  // Almost free — `snapshot()` encodes no genesis field at all, which is a
  // stronger statement than "banners are not hashed" — and kept anyway as the
  // tripwire against somebody copying the field into `State`.
  it("a genesis with banners and one without reach the same hash", () => {
    const plain = makeGenesis({
      seed: 4242,
      map: { width: 24, height: 24 },
      empires: [humans(1), humans(1), simbot("steady")],
    });
    const flown = makeGenesis({
      seed: 4242,
      map: { width: 24, height: 24 },
      empires: [humans(1, "cobalt"), humans(1, "amber"), simbot("steady", "rose")],
    });

    const a = new Sim(plain);
    const b = new Sim(flown);
    for (let i = 0; i < 120; i++) {
      a.advance();
      b.advance();
    }
    expect(b.hash()).toBe(a.hash());
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  // `canonicalJson` drops `undefined` and keeps `null`, so the two spellings of
  // "no banner" must not both be reachable — one of them would hash differently
  // while meaning exactly the same thing.
  it("is omitted when unset, never written as null", () => {
    expect("banner" in humans(1)).toBe(false);
    expect("banner" in simbot("easy")).toBe(false);
    expect(humans(1, "cobalt").banner).toBe("cobalt");
    expect(simbot("easy", "rose").banner).toBe("rose");
  });
});

describe("flying banners", () => {
  const ids = (banners: Array<{ id: string }>) => banners.map((banner) => banner.id);

  it("paints a record with no banners exactly as the index always did", () => {
    expect(ids(flyBanners([{}, {}, {}]))).toEqual(COMMITTED.slice(0, 3));
  });

  it("keeps a sealed house and lends a vacancy one nobody is flying", () => {
    // Empire 1 picked Verdant, which empire 2 would have worn by index.
    const flown = ids(flyBanners([{ banner: "verdant" }, {}, { banner: "peony" }]));
    expect(flown[0]).toBe("verdant");
    expect(flown[2]).toBe("peony");
    expect(flown[1]).not.toBe("verdant");
    expect(new Set(flown).size).toBe(3);
  });

  it("gives a claimant the house it brought, and moves the vacancy that wore it", () => {
    const before = ids(flyBanners([{ banner: "cobalt" }, {}, {}]));
    const lent = before[1]!;
    const after = ids(flyBanners([{ banner: "cobalt" }, {}, {}], new Map([[3, lent]])));
    expect(after[2]).toBe(lent);
    expect(after[1]).not.toBe(lent);
    expect(new Set(after).size).toBe(3);
  });

  it("refuses a claimed house somebody is already flying, and keeps the seat's colours apart", () => {
    const flown = ids(flyBanners([{ banner: "cobalt" }, {}], new Map([[2, "cobalt"]])));
    expect(flown[0]).toBe("cobalt");
    expect(flown[1]).not.toBe("cobalt");
  });

  it("the first claim of a house wins", () => {
    const flown = ids(flyBanners([{}, {}, {}], new Map([[2, "lumen"], [3, "lumen"]])));
    expect(flown[1]).toBe("lumen");
    expect(flown[2]).not.toBe("lumen");
  });
});
