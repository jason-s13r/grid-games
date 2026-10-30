// The purchase the render loop was eating.
//
// `Controls.render` runs from a 200 ms block and used to rewrite three subtrees
// unconditionally on every call. Two of them hold no buttons, which is why
// nobody noticed — but `[data-acts]` is the **shop**, and its tiles are
// `<button data-buy>`.
//
// Replace a button between `pointerdown` and `pointerup` and the browser fires
// `click` on the nearest surviving ancestor: `.acts`, where the delegated
// handler's `closest("[data-buy]")` finds nothing and the purchase is dropped
// in silence. At 200 ms and a typical press, a meaningful fraction of every
// purchase in the game was going nowhere.
//
// This needs a real engine, because the thing under test is what a browser does
// to an in-flight click when the element beneath the cursor is replaced. The
// hand-stubbed DOM the other Controls test uses cannot have that behaviour,
// which is exactly why the bug survived having a test file next to it.

import { describe, expect, it } from "vitest";
import { STEPS_PER_SECOND } from "@tessera/sim";
import { LocalGame } from "../game/Local";
import { Controls } from "../view/Controls";

const mount = () => {
  const root = document.createElement("div");
  document.body.append(root);
  const el = (name: string): HTMLElement => {
    const node = document.createElement("div");
    node.dataset.el = name;
    root.append(node);
    return node;
  };
  return {
    root,
    els: {
      hud: el("hud"),
      acts: el("acts"),
      storeHead: el("storeHead"),
      standings: el("standings"),
      roster: el("roster"),
      rosterPanel: el("rosterPanel"),
      clock: el("clock"),
      banner: el("banner"),
      zoomhint: el("zoomhint"),
    },
  };
};

/** A game with enough diamonds to have a shop worth clicking. */
const playing = () => {
  const game = new LocalGame({ seed: 4242, width: 24, height: 24, bots: ["steady"] });
  const empire = game.sim.state.empires[game.empire - 1]!;
  empire.diamonds = 999;
  return game;
};

describe("a click that spans a render", () => {
  it("still buys the thing that was under the cursor", () => {
    const game = playing();
    const { els } = mount();
    const controls = new Controls(game, els);
    controls.render(game.sim.state);

    const bridge = els.acts.querySelector<HTMLElement>('[data-buy="bridge"]');
    expect(bridge, "the shop drew a bridge tile").not.toBeNull();

    const bought: string[] = [];
    const realAct = game.act.bind(game);
    game.act = ((type: Parameters<typeof realAct>[0]) => {
      bought.push(String(type));
      return realAct(type);
    }) as typeof game.act;

    // The render loop fires between the press and the release. Nothing about
    // the state has changed, so nothing should be rewritten — and the button
    // the player is pressing has to still be the same node.
    bridge!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    controls.render(game.sim.state);
    const after = els.acts.querySelector<HTMLElement>('[data-buy="bridge"]');
    expect(after, "the button survived the render").toBe(bridge);

    bridge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bought).toHaveLength(1);
  });

  it("does not rewrite a subtree whose markup has not changed", () => {
    const game = playing();
    const { els } = mount();
    const controls = new Controls(game, els);

    controls.render(game.sim.state);
    const nodes = [...els.acts.children];
    const standings = [...els.standings.children];

    controls.render(game.sim.state);
    controls.render(game.sim.state);

    expect([...els.acts.children]).toEqual(nodes);
    expect([...els.standings.children]).toEqual(standings);
  });

  // The guard is per subtree so a HUD that genuinely changes every step does
  // not drag the shop into being redrawn with it.
  it("still redraws a subtree that did change", () => {
    const game = playing();
    const { els } = mount();
    const controls = new Controls(game, els);
    controls.render(game.sim.state);
    const before = els.hud.innerHTML;

    for (let i = 0; i < STEPS_PER_SECOND; i++) game.sim.advance([]);
    controls.render(game.sim.state);

    expect(els.hud.innerHTML).not.toBe(before);
  });
});
