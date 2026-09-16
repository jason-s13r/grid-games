// The half of the proposal sheet that has to be the same everywhere.
//
// The plan asks for "the proposal screen renders identically on every peer",
// and that is not a property this screen can have: it also asks for one button
// that signs, whose state is whether *this* key has signed. So the assertion is
// the narrower and true one — the part derived from the proposal is identical,
// the chrome is not — and the split is what makes it checkable.
//
// Strings rather than a DOM, because `apps/web`'s node project has no DOM and a
// panel snapshot does not need a browser to be a comparison.

import { describe, expect, it } from "vitest";
import { DIFFICULTY, hours } from "@tessera/sim";
import { proposalFrom } from "@tessera/protocol";
import type { Proposal } from "@tessera/protocol";
import { durationWords, proposalBody, proposalChrome } from "../view/Proposal";

const world = (over: Partial<Proposal> = {}): Proposal => ({
  ...proposalFrom({ seed: 1, startedAt: 0, rules: { endStep: hours(72), joinWindow: hours(24) } }),
  ...over,
});

describe("the derived half", () => {
  it("is identical for two peers holding one proposal", () => {
    const a = world({ vacancies: 2, simbots: [DIFFICULTY.easy] });
    // The same world, built independently. Byte equality, because this is the
    // half two players are entitled to compare.
    const b = world({ vacancies: 2, simbots: [DIFFICULTY.easy] });
    expect(proposalBody(b)).toBe(proposalBody(a));
  });

  it("moves when the world does", () => {
    const base = proposalBody(world());
    expect(proposalBody(world({ vacancies: 1 }))).not.toBe(base);
    expect(proposalBody(world({ simbots: [DIFFICULTY.hard] }))).not.toBe(base);
    expect(proposalBody(world({ map: { ...world().map, width: 97 } }))).not.toBe(base);
  });

  // Three rules from one control, and the reason visible. A player setting
  // "3 days" is also setting when the door closes and how long a silent team
  // has — a screen that hid that would hide the only thing making the number a
  // decision.
  it("says what a duration comes to, in all three of its consequences", () => {
    const words = durationWords(world());
    expect(words).toContain("runs for 3d");
    expect(words).toContain("open to joiners for 1d");
    expect(words).toContain("abandoned after");
  });

  it("says so when a game runs until somebody wins", () => {
    expect(durationWords(world({ rules: { ...world().rules, endStep: 0 } }))).toContain(
      "until somebody wins",
    );
  });

  it("names a vacancy as what it is rather than as an empty chair", () => {
    const body = proposalBody(world({ vacancies: 2 }));
    expect(body).toContain("left open");
    expect(proposalBody(world({ vacancies: 0 }))).not.toContain("left open");
  });
});

describe("the chrome, which is allowed to differ", () => {
  const chrome = { mine: false, signed: 3, rev: 2, startsIn: 30_000 };

  // Signing is not agreeing: a consent is the thing that puts you in the game,
  // so somebody who has not signed is not a dissenter — they are not in it.
  it("offers the button to somebody who has not signed", () => {
    const out = proposalChrome(chrome, "abc");
    expect(out).toContain("Play this game");
    expect(out).toContain("not in this game yet");
  });

  it("offers nothing to sign twice", () => {
    const out = proposalChrome({ ...chrome, mine: true }, "abc");
    expect(out).not.toContain("data-proposal=\"sign\"");
    expect(out).toContain("You are in");
  });

  // A count and never a tally: the signatures *are* the roster, so nobody is
  // short of anything.
  it("counts players rather than votes", () => {
    expect(proposalChrome(chrome, "abc")).toContain("3 players in this game");
    expect(proposalChrome({ ...chrome, signed: 1 }, "abc")).toContain("1 player in this game");
  });

  // A revision does not cost the reviser a signature, it costs everybody else
  // their seat until they sign again — so a revision posted just before the
  // instant is a weapon, and the countdown is its mitigation.
  it("counts down against the instant in the record", () => {
    expect(proposalChrome(chrome, "abc")).toContain("Sealing in 30s");
    expect(proposalChrome({ ...chrome, startsIn: 0 }, "abc")).not.toContain("Sealing in");
  });

  it("keeps a hostile proposal id inside its attribute", () => {
    const out = proposalChrome(chrome, `" onclick="alert(1)`);
    expect(out).not.toContain('onclick="alert(1)"');
    expect(out).toContain("&quot;");
  });

  it("is the half that differs between two peers", () => {
    const signed = proposalChrome({ ...chrome, mine: true }, "abc");
    const unsigned = proposalChrome(chrome, "abc");
    expect(signed).not.toBe(unsigned);
  });
});
