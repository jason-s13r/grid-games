// The sign button, against a DOM that is actually a DOM.
//
// One sheet per world on the table, and a button that signs one. The sheet's
// two halves are pinned as strings in `proposal.test.ts`; what only a parser can
// answer is whether the markup survives being read back, and whether the
// **proposal id a stranger chose** stays inside the attribute the click handler
// reads out of it — the id comes off a frame anybody in the room can send, and
// an id that escapes its attribute takes the button identity with it.

import { describe, expect, it } from "vitest";
import { proposalFrom } from "@tessera/protocol";
import type { Proposal } from "@tessera/protocol";
import { LobbyPanel } from "../view/LobbyPanel";
import type { Lobby } from "@tessera/net";

const world = (over: Partial<Proposal> = {}): Proposal => ({
  ...proposalFrom({ seed: 1, startedAt: 0, map: { width: 48, height: 32 } }),
  ...over,
});

/** Just enough lobby for the panel to draw a table. The panel reads five
 *  things and calls nothing, which is what makes a stub honest here. */
const stub = (tabled: ReturnType<Lobby["proposals"]>, phase = "composing"): Lobby =>
  ({
    phase,
    problem: "",
    code: "tsr-abc234",
    shareable: "tsr-abc234",
    startsIn: 0,
    players: () => [],
    proposals: () => tabled,
  }) as unknown as Lobby;

const mount = () => {
  const root = document.createElement("section");
  document.body.append(root);
  const signed: string[] = [];
  const panel = new LobbyPanel(root, {
    invite: () => undefined,
    endorse: () => undefined,
    admit: () => undefined,
    consent: (id) => signed.push(id),
  });
  return { root, panel, signed };
};

describe("a world on the table", () => {
  it("draws one row per proposal, and signing hands back the one clicked", () => {
    const { root, panel, signed } = mount();
    panel.attach(
      stub([
        { id: "aaa", proposal: world(), rev: 0, by: "k1", signers: ["k1"], mine: false },
        {
          id: "bbb",
          proposal: world({ vacancies: 2 }),
          rev: 3,
          by: "k2",
          signers: ["k1", "k2"],
          mine: false,
        },
      ]),
    );

    expect(root.querySelectorAll(".sheet")).toHaveLength(2);
    expect(root.textContent).toContain("48×32");
    expect(root.textContent).toContain("2 empires left open");
    // A count and never a tally: the signatures *are* the roster, so there is
    // no threshold anybody is short of.
    expect(root.textContent).toContain("1 player in this game");
    expect(root.textContent).toContain("2 players in this game, at revision 3");

    const buttons = root.querySelectorAll<HTMLElement>("[data-proposal='sign']");
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    expect(signed).toEqual(["bbb"]);
  });

  it("offers nothing to sign twice", () => {
    const { root, panel } = mount();
    panel.attach(
      stub([{ id: "aaa", proposal: world(), rev: 0, by: "k1", signers: ["k1"], mine: true }]),
    );
    expect(root.querySelectorAll("[data-proposal='sign']")).toHaveLength(0);
    expect(root.textContent).toContain("You are in");
  });

  // The id is a string a stranger chose. If it escapes its attribute it takes
  // the button's identity with it, and the next click signs something else.
  it("keeps a hostile proposal id inside its attribute", () => {
    const { root, panel, signed } = mount();
    const nasty = `" onclick="alert(1)" data-x="`;
    panel.attach(
      stub([{ id: nasty, proposal: world(), rev: 0, by: "k1", signers: [], mine: false }]),
    );

    const button = root.querySelector<HTMLElement>("[data-proposal='sign']");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("onclick")).toBeNull();
    expect(button!.dataset.id).toBe(nasty);
    button!.click();
    expect(signed).toEqual([nasty]);
  });

  it("says nothing is on the table when nothing is", () => {
    const { root, panel } = mount();
    panel.attach(stub([]));
    expect(root.textContent).toContain("Nothing on the table yet");
  });

  // A record sealed for a future instant is a game that has not begun, and the
  // panel is the half that must not claim otherwise.
  it("counts down rather than showing a frozen board", () => {
    const { root, panel } = mount();
    const lobby = stub([], "starting");
    (lobby as { startsIn: number }).startsIn = 9_500;
    panel.attach(lobby);
    expect(root.textContent).toContain("starts in 10 seconds");
  });
});
