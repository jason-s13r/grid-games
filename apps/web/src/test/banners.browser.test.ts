// Seven empires, against a DOM that is actually a DOM.
//
// This is the lead finding, and it could only ever be caught here. The palette
// had six themes and `empireTheme` wrapped with `% 6`, so nothing threw and
// nothing looked wrong in any unit test — but `injectThemeCss` emitted exactly
// six rules keyed `.tile[data-empire="N"]`, so a seventh empire matched **none
// of them**, inherited `--c1: transparent` from the base rule, and had its
// territory painted invisible on the main board while carrying the right
// pattern class and the right attribute the whole time.
//
// Not a duplicate colour. A disappearance — enemy territory rendered
// indistinguishable from empty ground — and reachable by seven friends pressing
// start, because `composeTeams` gives a player with no team preference an empire
// of their own.
//
// So this asks the question only a real style engine can: does every empire in
// a full game end up with a colour that is actually painted.

import { describe, expect, it } from "vitest";
import { BANNERS, MAX_EMPIRES } from "@tessera/sim";
import { Flags, injectThemeCss, setFlags, empireTheme } from "../view/palette";

/** One tile per empire, with the attribute the renderer writes. */
const board = (count: number): HTMLElement[] => {
  const root = document.createElement("div");
  document.body.append(root);
  return Array.from({ length: count }, (_, i) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.banner = empireTheme(i + 1).id;
    root.append(tile);
    return tile;
  });
};

const paintedColour = (el: HTMLElement): string =>
  getComputedStyle(el).getPropertyValue("--c1").trim();

describe("every empire is drawn", () => {
  it("injects one rule per banner, not one per empire", () => {
    injectThemeCss();
    const tiles = board(MAX_EMPIRES);

    const colours = tiles.map(paintedColour);
    // The failure this file exists for: a colour that resolves to nothing.
    for (const [at, colour] of colours.entries()) {
      expect(colour, `empire ${at + 1}`).not.toBe("");
      expect(colour, `empire ${at + 1}`).not.toBe("transparent");
    }
    // And distinguishable, which is the point of having a table at all.
    expect(new Set(colours).size).toBe(colours.length);
  });

  // The specific number that was broken, called out because seven friends is
  // not an unusual game and this was invisible for as long as the palette had
  // six entries.
  it("a seventh empire is painted, and is not empire one", () => {
    injectThemeCss();
    const tiles = board(7);
    expect(paintedColour(tiles[6]!)).not.toBe("");
    expect(paintedColour(tiles[6]!)).not.toBe(paintedColour(tiles[0]!));
    expect(tiles[6]!.dataset.banner).toBe(BANNERS[6]!.id);
  });

  it("the attribute is the banner slug, so a sealed banner repaints a tile", () => {
    injectThemeCss();
    // Empire 1 flies Rose rather than its index colour.
    setFlags(new Flags([{ banner: "rose" }, {}, {}]));
    const tiles = board(3);

    expect(tiles[0]!.dataset.banner).toBe("rose");
    expect(paintedColour(tiles[0]!)).toBe(BANNERS.find((b) => b.id === "rose")!.c1);
    // And the empires that said nothing keep their index colours.
    expect(tiles[1]!.dataset.banner).toBe(BANNERS[1]!.id);

    setFlags(new Flags());
  });
});

describe("the control that proves the check has teeth", () => {
  // Without this, the tests above could pass because `getComputedStyle` always
  // returns something. A tile whose slug has no rule resolves to the base
  // rule's `transparent` — which is exactly the state a seventh empire was in,
  // and exactly what the assertions above are looking for.
  it("a slug with no rule paints nothing", () => {
    injectThemeCss();
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.banner = "sping";
    document.body.append(tile);

    const colour = getComputedStyle(tile).getPropertyValue("--c1").trim();
    expect(colour === "" || colour === "transparent").toBe(true);
  });
});
