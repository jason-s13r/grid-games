// The proposal sheet: a game on the table, rendered the same way for everybody.
//
// The lobby stops being a picker with an audience. There is no host role left to
// privilege — 0009 removed it — so any player may post a revision and the screen
// shows one live count: how many people have agreed to *this* revision of the
// world.
//
// **"Identical on every peer" is not what this screen does**, and the plan's own
// verification asks for the wrong test. The same section wants "3 of 4 signed"
// *and one button that signs it* — a button whose state is whether this key has
// signed — plus a "(you)" marker and a Take-it row that is live only while we
// hold no seat. At least three things here are per-peer by design.
//
// The invariant worth testing is narrower and actually true: **the part derived
// from the proposal is identical; the chrome around it is not.** So the render
// splits in two, and the split is also what makes it testable without a DOM.

import { escape } from "./escape";
import { span } from "./clock";
import { empireTheme } from "./palette";
import type { Proposal } from "@tessera/protocol";

/** What a duration comes to, said in words.
 *
 *  Three rules from one control, and the reason visible: a duration is a step
 *  count, and the join window and the abandon window scale with it. A player
 *  setting "3 days" is also setting when the door closes and how long a silent
 *  team has before it is abandoned, and a screen that hid that would be hiding
 *  the only thing that makes the number a decision. */
export function durationWords(proposal: Proposal): string {
  const rules = proposal.rules;
  const endStep = rules.endStep ?? 0;
  const joinWindow = rules.joinWindow ?? 0;
  const parts: string[] = [];
  parts.push(endStep > 0 ? `runs for ${span(endStep)}` : "runs until somebody wins");
  if (joinWindow > 0) parts.push(`open to joiners for ${span(joinWindow)}`);
  parts.push(`a team is abandoned after ${span(rules.abandonWindow)} of quiet`);
  return parts.join(" · ");
}

/** The half of the sheet that is derived from the proposal and nothing else.
 *
 *  Pure, and returns a string: `apps/web`'s node project has no DOM
 *  environment, so a snapshot of a tree would need an engine it does not have
 *  and a panel snapshot does not need three of them. Comparing strings is the
 *  same assertion for nothing. */
export function proposalBody(proposal: Proposal): string {
  const bots = proposal.simbots.length;
  const vacant = proposal.vacancies;

  const rows: string[] = [];
  if (bots > 0) {
    rows.push(
      `<li class="lobby-seat"><span class="lobby-who">${bots} opponent${
        bots === 1 ? "" : "s"
      } the game plays itself</span></li>`,
    );
  }
  if (vacant > 0) {
    // A vacancy is a capital on the map with nobody in it, which is a different
    // thing from an empty chair and the screen should say which.
    rows.push(
      `<li class="lobby-seat"><span class="lobby-who">${vacant} empire${
        vacant === 1 ? "" : "s"
      } left open, for somebody to arrive into</span></li>`,
    );
  }

  return [
    `<p class="hint">${escape(durationWords(proposal))}</p>`,
    `<p class="hint">A ${proposal.map.width}×${proposal.map.height} map, rule set v${proposal.protocol}.</p>`,
    rows.length > 0 ? `<ul class="lobby-teams">${rows.join("")}</ul>` : "",
  ].join("");
}

export interface ProposalChrome {
  /** Whether this peer has put its name to this exact revision. */
  mine: boolean;
  /** How many have. Not a threshold: the signatures *are* the roster, so there
   *  is nothing anybody is short of. */
  signed: number;
  rev: number;
  /** Milliseconds until the record is sealed, from `startedAt`. */
  startsIn: number;
}

/** The half that is this peer's, and is allowed to differ.
 *
 *  **Signing is not agreeing.** A consent is the thing that puts you in the
 *  game, so a player who has not signed is not a dissenter — they are somebody
 *  who is currently not in it. The button says so.
 *
 *  And a revision does not cost the reviser a signature, it costs everyone else
 *  their seat until they sign again. Posted shortly before the start instant
 *  that is a weapon, so the countdown sits on the same screen as the edit
 *  controls and reads against `startedAt` rather than against a local
 *  stopwatch. */
export function proposalChrome(chrome: ProposalChrome, id: string): string {
  const secs = Math.ceil(chrome.startsIn / 1000);
  const playing = `${chrome.signed} ${chrome.signed === 1 ? "player" : "players"} in this game`;
  return [
    `<p class="hint">${playing}${chrome.rev > 0 ? `, at revision ${chrome.rev}` : ""}.</p>`,
    chrome.mine
      ? `<p class="hint">You are in. Anybody may still revise it, and a revision is a
         different game — you would need to say yes again.</p>`
      : `<p class="hint lobby-problem">You are not in this game yet.</p>
         <button class="btn" type="button" data-proposal="sign"
           data-id="${escape(id)}">Play this game</button>`,
    chrome.startsIn > 0
      ? `<p class="hint">Sealing in ${secs}s, with whoever has signed by then.</p>`
      : "",
  ].join("");
}
