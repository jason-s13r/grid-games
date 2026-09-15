// The games card, against a DOM that is actually a DOM.
//
// `games.test.ts` pins the view model, which is where every judgement about a
// row lives. What it cannot see is the half after that: these views build markup
// by concatenating strings, and a template that a browser parses differently
// from how it was written produces a card that is wrong in a way no assertion
// about an array will ever notice. A stray tag closes a list early; an
// unescaped quote in a game id swallows an attribute and takes the button's
// identity with it.
//
// So this runs in one real engine and asks the questions only a parser can
// answer: did the rows survive, does clicking one hand back the game that was
// clicked, and does a hostile string stay a string.

import { describe, expect, it } from "vitest";
import { hours, makeGenesis } from "@tessera/sim";
import type { GameListing } from "@tessera/net";
import { Games } from "../view/Games";
import type { GameRow } from "../view/Games";

const NOW = 1_700_000_000_000;

const listing = (extra: Partial<GameListing> = {}): GameListing => ({
  gameId: "abcdef0123456789",
  genesis: makeGenesis({
    seed: 1,
    empires: [{ members: [{ key: "one" }] }, { members: [{ key: "two" }] }],
    map: { width: 160, height: 112 },
    rules: { endStep: hours(3), joinWindow: hours(1) },
  }),
  refs: [{ kind: "rtc", code: "tsr-abc234" }],
  unreadable: [],
  resume: [],
  seats: { total: 2, keyed: 2 },
  endsAt: NOW + 3 * 3600 * 1000,
  joinableUntil: NOW + 3600 * 1000,
  playable: true,
  ...extra,
});

/** A card on a detached root. Nothing here needs the page, only a parser. */
const mount = () => {
  const root = document.createElement("section");
  document.body.append(root);
  const opened: GameRow[] = [];
  const resumed: GameRow[] = [];
  const card = new Games(root, {
    open: (row) => opened.push(row),
    resume: (row) => resumed.push(row),
  });
  return { root, card, opened, resumed };
};

describe("the card renders into a real DOM", () => {
  it("says there is no board before one is configured", () => {
    const { root } = mount();
    expect(root.textContent).toContain("no default one");
    expect(root.querySelectorAll("li")).toHaveLength(0);
  });

  it("draws one element per game, and the parser agrees about how many", () => {
    // The assertion a string test cannot make: a malformed row closes the list
    // early and the count silently drops.
    const { root, card } = mount();
    card.show([listing(), listing({ gameId: "999888777666" })], NOW);
    expect(root.querySelectorAll(".games-row")).toHaveLength(2);
  });

  it("hands back the game that was clicked", () => {
    const { root, card, opened } = mount();
    card.show([listing(), listing({ gameId: "999888777666" })], NOW);
    root.querySelectorAll<HTMLButtonElement>("[data-game]")[1]!.click();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.gameId).toBe("999888777666");
  });

  it("puts the facts and the witnesses on screen, not just in the model", () => {
    const { root, card } = mount();
    card.show([listing()], NOW);
    const text = root.textContent ?? "";
    expect(text).toContain("3 hours");
    expect(text).toContain("seats open for");
    expect(text).toContain("No witnesses yet");
  });

  it("keeps a hostile game id inside its attribute", () => {
    // A board is allowed to lie, and an id is a string it chose. If quoting
    // fails here the row's button loses its identity and the markup around it
    // becomes whatever the board wanted.
    const { root, card, opened } = mount();
    card.show([listing({ gameId: '" onclick="boom()" data-x="' })], NOW);
    const button = root.querySelector<HTMLButtonElement>("[data-game]")!;
    expect(button.getAttribute("onclick")).toBeNull();
    expect(button.dataset.x).toBeUndefined();
    button.click();
    expect(opened[0]!.gameId).toBe('" onclick="boom()" data-x="');
  });
});

describe("what a knock does to a row", () => {
  it("shows the tally before the player commits to a resume", () => {
    const { root, card } = mount();
    card.show([listing({ refs: [], resume: ["https://host.example/r/resume"] })], NOW);
    card.offer("abcdef0123456789", {
      kind: "resume",
      step: 41_200,
      tally: "Endorsed by 3 of the 3 seats it needs",
    });
    const text = root.textContent ?? "";
    expect(text).toContain("Nobody is there");
    expect(text).toContain("Endorsed by 3 of the 3 seats");
    expect(text).toContain("41,200");
  });

  it("routes the commit to the resume handler rather than a plain join", () => {
    const { root, card, opened, resumed } = mount();
    card.show([listing({ refs: [], resume: ["https://host.example/r/resume"] })], NOW);
    card.offer("abcdef0123456789", { kind: "resume", step: 900, tally: "Endorsed by 2 of 2" });
    root.querySelector<HTMLButtonElement>('[data-act="resume"]')!.click();
    expect(resumed).toHaveLength(1);
    expect(opened).toHaveLength(0);
  });

  it("lists every reason a dead row gave, rather than one of them", () => {
    // A leaderboard that silently drops what it could not verify is one nobody
    // can audit, and the same is true of a door that would not open.
    const { root, card } = mount();
    card.show([listing()], NOW);
    card.offer("abcdef0123456789", {
      kind: "gone",
      problems: ["tsr-abc234 did not answer", "that game's clock ran out"],
    });
    expect(root.querySelectorAll(".games-problems li")).toHaveLength(2);
    // And the row stays offering a retry: a host that is rebooting is worth
    // another knock in a minute.
    expect(root.querySelector("[data-game]")!.textContent).toContain("Try again");
  });

  it("forgets a knock about a game the board has stopped listing", () => {
    const { root, card } = mount();
    card.show([listing()], NOW);
    card.offer("abcdef0123456789", { kind: "gone", problems: ["nobody answered"] });
    card.show([listing({ gameId: "999888777666" })], NOW);
    expect(root.textContent).not.toContain("nobody answered");
  });
});
