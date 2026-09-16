// Names: signed, attributable, and never hashed into anything.
//
// Two halves, and the second is the one that matters. A naming verifies like a
// message, which is well-trodden ground. What is new is that **a name is a
// string a stranger chose that ends up rendered next to a fingerprint**, and
// the fingerprint is the entire anti-impersonation story. So `cleanName` is
// tested against strings that never went through an input field, because the
// sender is untrusted and a hostile client does not run our validation.

import { beforeAll, describe, expect, it } from "vitest";
import { Identity } from "../identity.js";
import { NAME_BYTES, Names, cleanName, displayName } from "../names.js";
import { encodeNaming, signNaming, verifyNaming } from "../records.js";
import type { Naming } from "../records.js";
import { fixture } from "./fixture.js";
import type { Fixture } from "./fixture.js";

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
});

const naming = (over: Partial<Naming> = {}): Naming => ({
  step: 10,
  seq: 0,
  empire: 1,
  member: 0,
  name: "kestrel",
  ...over,
});

describe("a name is a claim only its own seat can make", () => {
  it("verifies against the seat that signed it", async () => {
    const signed = await signNaming(f.alice, f.gameId, naming());
    expect(await verifyNaming(f.roster, f.gameId, signed)).toBe(true);
  });

  it("does not verify when somebody else signed it", async () => {
    const signed = await signNaming(f.bob, f.gameId, naming());
    expect(await verifyNaming(f.roster, f.gameId, signed)).toBe(false);
  });

  it("does not verify against another game", async () => {
    const signed = await signNaming(f.alice, f.gameId, naming());
    expect(await verifyNaming(f.roster, "a-different-game", signed)).toBe(false);
  });

  it("does not verify when the name is edited in flight", async () => {
    const signed = await signNaming(f.alice, f.gameId, naming());
    const edited = { ...signed, naming: { ...signed.naming, name: "someone-else" } };
    expect(await verifyNaming(f.roster, f.gameId, edited)).toBe(false);
  });

  it("refuses an over-long name at the encoder rather than truncating it", () => {
    const long = { ...naming(), name: "x".repeat(NAME_BYTES + 1) };
    expect(() => encodeNaming(f.gameId, long)).toThrow();
  });

  it("is a refusal and never a throw for a record nobody could have signed", async () => {
    const signed = await signNaming(f.alice, f.gameId, naming());
    for (const broken of [
      { ...signed, naming: { ...signed.naming, empire: 0 } },
      { ...signed, naming: { ...signed.naming, step: -1 } },
      { ...signed, naming: { ...signed.naming, name: 7 as unknown as string } },
      { ...signed, sig: 7 as unknown as string },
    ]) {
      await expect(verifyNaming(f.roster, f.gameId, broken)).resolves.toBe(false);
    }
  });
});

describe("what a reader does to a name before showing it", () => {
  it("keeps an ordinary name", () => {
    expect(cleanName("kestrel")).toBe("kestrel");
  });

  // The one that matters. `escape()` replaces four characters and lets U+202E
  // through, and U+202E reverses the rendering of everything after it on the
  // line — including the fingerprint that exists to make impersonation visible.
  it("strips a right-to-left override", () => {
    expect(cleanName("alice‮evil")).toBe("aliceevil");
    expect(cleanName("‮‭⁦⁩nope")).toBe("nope");
  });

  it.each([
    ["a control character", "ab", "ab"],
    ["a C1 control", "ab", "ab"],
    ["a zero-width space", "a​b", "ab"],
    ["a zero-width joiner", "a‍b", "ab"],
    ["a byte-order mark", "﻿name", "name"],
    ["an invisible separator", "a⁣b", "ab"],
    ["interlinear annotation", "a￹b￻c", "abc"],
    ["a left-to-right mark", "a‎b", "ab"],
  ])("strips %s", (_what, raw, want) => {
    expect(cleanName(raw)).toBe(want);
  });

  it("collapses whitespace and trims, so a name cannot be mostly gap", () => {
    expect(cleanName("  a   b  ")).toBe("a b");
    expect(cleanName("\t\n a \n")).toBe("a");
  });

  it("is empty for a name with nothing left in it", () => {
    for (const raw of ["", "   ", "‮​", 7, null, undefined, {}]) {
      expect(cleanName(raw)).toBe("");
    }
  });

  it("normalises to NFC before measuring, so one character is one character", () => {
    // e + combining acute, which is two code points and one grapheme.
    expect(cleanName("é")).toBe("é");
  });

  // Truncating mid-character would produce a lone surrogate, which is not a
  // string anybody can render.
  it("truncates on a code point boundary", () => {
    const long = "\u{1F600}".repeat(40);
    const clean = cleanName(long);
    expect(new TextEncoder().encode(clean).length).toBeLessThanOrEqual(NAME_BYTES);
    expect([...clean].every((c) => c === "\u{1F600}")).toBe(true);
    // No lone surrogate survived.
    expect(clean).toBe(clean.normalize("NFC"));
  });

  it("caps in bytes, not in UTF-16 units", () => {
    const wide = "あ".repeat(40); // 3 bytes each
    expect(new TextEncoder().encode(cleanName(wide)).length).toBeLessThanOrEqual(NAME_BYTES);
  });
});

describe("the display form", () => {
  // Nothing stops two players choosing one name, and nothing should: uniqueness
  // needs an authority to arbitrate, and there is no authority anywhere in this
  // system by design. So the suffix is not optional.
  it("always carries the fingerprint", () => {
    expect(displayName("kestrel", "a3f19c04")).toBe("kestrel#a3f19c04");
  });

  it("is the bare fingerprint when there is no name", () => {
    expect(displayName("", "a3f19c04")).toBe("a3f19c04");
  });

  it("makes two people with one name distinguishable", () => {
    expect(displayName("kestrel", "a3f19c04")).not.toBe(displayName("kestrel", "b7c20d55"));
  });
});

describe("the store", () => {
  const entry = (over: Partial<Parameters<Names["take"]>[0]> = {}) => ({
    key: "k1",
    name: "first",
    step: 10,
    seq: 0,
    sig: "aaa",
    ...over,
  });

  it("keeps the latest (step, seq) and forgets the rest", () => {
    const names = new Names();
    expect(names.take(entry())).toBe(true);
    expect(names.take(entry({ step: 20, name: "second" }))).toBe(true);
    expect(names.nameOf("k1")).toBe("second");
    // An earlier record arriving late changes nothing.
    expect(names.take(entry({ step: 5, name: "stale" }))).toBe(false);
    expect(names.nameOf("k1")).toBe("second");
  });

  // Not a desync — a name is not hashed — but a permanent UI split, with two
  // peers showing different names for one person for the rest of the game.
  it("breaks a tie deterministically, whichever order the two arrive in", () => {
    const a = entry({ name: "alpha", sig: "aaa" });
    const b = entry({ name: "beta", sig: "bbb" });

    const one = new Names();
    one.take(a);
    one.take(b);

    const two = new Names();
    two.take(b);
    two.take(a);

    expect(one.nameOf("k1")).toBe(two.nameOf("k1"));
    expect(one.nameOf("k1")).toBe("beta");
  });

  // The whole reason the store is keyed by key and not by seat: within one game
  // a seat index is not stable across a drop and a return.
  it("is keyed by the person, not the chair", () => {
    const names = new Names();
    names.take(entry({ key: "k1", name: "alice" }));
    names.take(entry({ key: "k2", name: "bob" }));
    expect(names.nameOf("k1")).toBe("alice");
    expect(names.nameOf("k2")).toBe("bob");
    expect(names.nameOf("k3")).toBe("");
  });

  it("knows a key on first sight, which is what stops the answer looping", () => {
    const names = new Names();
    expect(names.knows("k1")).toBe(false);
    names.take(entry());
    expect(names.knows("k1")).toBe(true);
    // A re-assert of the same name is not news, and redraws nothing.
    expect(names.take(entry({ step: 30 }))).toBe(false);
    expect(names.knows("k1")).toBe(true);
  });
});

describe("a name on the wire is whatever the sender chose", () => {
  // The signature covers the raw bytes. Cleaning happens on the way in, so a
  // hostile client signing a bidi override produces a record that verifies and
  // renders harmlessly — which is the correct outcome and the reason cleaning
  // is not part of verification.
  it("verifies a hostile name, and the reader is what makes it safe", async () => {
    const alice = await Identity.generate();
    void alice;
    const nasty = "alice‮evil";
    const signed = await signNaming(f.alice, f.gameId, naming({ name: nasty }));
    expect(await verifyNaming(f.roster, f.gameId, signed)).toBe(true);
    expect(cleanName(signed.naming.name)).toBe("aliceevil");
  });
});
