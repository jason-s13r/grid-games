// A bot that plays a seat rather than an empire.
//
// The SimBot in packages/sim runs inside every peer's simulation, drives a
// whole empire, and costs no bandwidth — which is exactly why it has to be
// perfectly deterministic and can never be told anything. A PeerBot is the
// other half of that table: its own mesh client, holding one member seat in a
// human empire, signing and broadcasting a move like any other player.
//
// That difference buys the thing a marathon game needs. A team can sleep and
// still hold its ground, because the empty seat keeps answering — it heartbeats,
// it promises readiness, and so it never blocks the peers still playing.
//
// It costs the empire something, or night cover would be strictly free and
// therefore overpowered. The price is charged by the rules, not here: a BOT
// member accrues at half rate, caps at 499 instead of 999, and its coin claims
// fire without triggering the coins they land on. A bot holds the line; it
// cannot execute the big farming play. Cascade mastery stays the human skill.
//
// It also only ever defends. A night-shift bot that attacked would take ground
// its team never chose to take, on a front nobody was awake to hold, and would
// hand the empire a war it had to wake up to. Pinned to defence it reinforces
// the thinnest contested tile and nothing else — it does not expand, it does
// not grab coins, and with no line to hold it banks its population for the
// morning. Cover, not initiative.
//
// Its randomness is its own business. A SimBot must draw from the shared seeded
// stream because every peer re-derives its moves; a PeerBot's moves are
// validated rather than derived, so it must NOT touch that stream — a draw made
// on one peer and nowhere else is a desync.

import { Rng, policy, seedFrom } from "@tessera/sim";
import type { Mode } from "@tessera/sim";
import type { Move } from "@tessera/sim";
import type { Lockstep } from "./lockstep.js";

export interface PeerBotOptions {
  /** The driver whose seat this bot plays. Must have an identity and a seat. */
  lockstep: Lockstep;
  /** Steps between actions. Defaults to the genesis rule the SimBot uses. */
  interval?: number;
  /** Where its decisions come from. Anything will do; the default is seeded
   *  from the seat so a replay of a test reproduces the same bot. */
  rng?: Rng;
  /** What it is allowed to do. Defence is the default and the point; the field
   *  exists so a test can put a bot on the attack deliberately. */
  mode?: Mode;
}

export class PeerBot {
  private readonly lockstep: Lockstep;
  private readonly rng: Rng;
  private readonly interval: number;
  private readonly mode: Mode;
  /** The step it last acted on, rather than a modulo of the current step: a
   *  pump can cross several steps at once, and a bot that only fires on an
   *  exact multiple would skip its turn whenever it did. */
  private actedAt = -Infinity;
  /** One signature in flight at a time. Two overlapping submits would fight
   *  over the readiness ceiling, and the second would pick a slot for a move
   *  the first had not finished promising about. */
  private acting = false;

  constructor(options: PeerBotOptions) {
    this.lockstep = options.lockstep;
    const seat = this.lockstep.seat;
    this.rng =
      options.rng ?? new Rng(seedFrom(`peerbot:${seat?.empire ?? 0}:${seat?.member ?? 0}`));
    this.interval =
      options.interval ?? this.lockstep.sim.state.genesis.rules.botActionInterval;
    this.mode = options.mode ?? "defend";
  }

  /** Advance the game and take a turn if one is due. Returns what pump()
   *  returns, so a PeerBot drops into a loop wherever a driver would. */
  tick(): Set<number> {
    const dirty = this.lockstep.pump();
    void this.act();
    return dirty;
  }

  /** The move it would make right now, or null. Exposed because deciding and
   *  submitting are worth testing apart: one is a policy question and the other
   *  is a networking one. */
  decide(): Move | null {
    const seat = this.lockstep.seat;
    if (!seat) return null;
    const state = this.lockstep.sim.state;
    const empire = state.empires[seat.empire - 1];
    if (!empire?.alive) return null;
    return policy(state, empire, seat.member, this.rng, this.mode);
  }

  private async act(): Promise<void> {
    if (this.acting || this.lockstep.stopped || this.lockstep.sim.ended) return;
    const step = this.lockstep.step;
    if (step - this.actedAt < this.interval) return;

    const move = this.decide();
    // Claim the turn either way. A bot with nothing legal to do should wait for
    // the next interval rather than re-scanning the whole board every step.
    this.actedAt = step;
    if (!move) return;

    this.acting = true;
    try {
      await this.lockstep.submit(move.type, move.x, move.y);
    } finally {
      this.acting = false;
    }
  }
}
