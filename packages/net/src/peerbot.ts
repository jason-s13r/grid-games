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

import { Rng, STEPS_PER_SECOND, policy, seedFrom } from "@tessera/sim";
import type { Mode, State } from "@tessera/sim";
import type { Move } from "@tessera/sim";
import type { Lockstep } from "./lockstep.js";

/** How it plays. The four are the simulation's own modes; "cycle" is the
 *  rotation a SimBot runs — twenty seconds of each in turn, with the occasional
 *  deviation so two bots in the same phase do not move in lockstep. */
export type Play = Mode | "cycle";

/** Who it walks towards while attacking. A number names an empire; "nearest" is
 *  what the simulation does unasked; "random" picks one and "rotate" takes them
 *  in turn, both changing only every few minutes — a bot that re-chose every
 *  action would be "nearest" with extra steps, since the nearest front is where
 *  its tiles are anyway. */
export type Target = "nearest" | "random" | "rotate" | number;

/** Steps between reconsidering who to attack. Two minutes: long enough for a
 *  push to mean something, short enough that a game notices. */
const ROTATE_STEPS = STEPS_PER_SECOND * 120;

export interface PeerBotOptions {
  /** The driver whose seat this bot plays. Must have an identity and a seat. */
  lockstep: Lockstep;
  /** Steps between actions, floored at the genesis rule.
   *
   *  Slower than the rule is a choice; faster is not on offer. `botActionInterval`
   *  is what every peer agreed bots act at, and a PeerBot that outran it would
   *  be night cover with better reflexes than the people it is covering for —
   *  which is the one thing an always-on seat must not be. */
  interval?: number;
  /** Where its decisions come from. Anything will do; the default is seeded
   *  from the seat so a replay of a test reproduces the same bot. */
  rng?: Rng;
  /** What it is allowed to do. Defence is the default and the point; anything
   *  else is a deliberate choice by whoever started it. */
  mode?: Play;
  /** Who to attack, when it is attacking at all. */
  target?: Target;
  /** Whether it is playing right now. Called with wall-clock milliseconds, and
   *  false means it holds its seat without using it.
   *
   *  This is the balance lever an always-on seat needs. A bot that is quiet is
   *  still *pumping* — it heartbeats, it promises readiness, it never blocks
   *  the peers still playing — it simply banks its population instead of
   *  spending it. Twenty-four hours of reflexes is the thing worth being able
   *  to turn down, and turning it down must not cost the empire the seat. */
  awake?: (now: number) => boolean;
}

export class PeerBot {
  private readonly lockstep: Lockstep;
  private readonly rng: Rng;
  private readonly interval: number;
  private readonly mode: Play;
  private readonly target: Target;
  private readonly awake: (now: number) => boolean;
  private readonly now: () => number;
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
    const floor = this.lockstep.sim.state.genesis.rules.botActionInterval;
    this.interval = Math.max(options.interval ?? floor, floor);
    this.mode = options.mode ?? "defend";
    this.target = options.target ?? "nearest";
    this.awake = options.awake ?? ((): boolean => true);
    this.now = (): number => Date.now();
  }

  /** Whether it would act if a turn were due. Exposed so a caller can say so on
   *  screen: a bot that has gone quiet looks identical to one that has crashed,
   *  and the difference matters to the team relying on it. */
  get resting(): boolean {
    return !this.awake(this.now());
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
    // "cycle" is the absence of a forced mode rather than a mode of its own —
    // and passing nothing also re-opens the coin grab, which a pinned bot skips
    // because taking a coin is expansion onto neutral ground.
    const mode = this.mode === "cycle" ? undefined : this.mode;
    return policy(state, empire, seat.member, this.rng, mode, this.focus(state, seat.empire));
  }

  /** Which empire to walk towards. Decided here rather than in the simulation
   *  because it is a decision made outside the shared stream — a SimBot could
   *  not make it without every peer having to agree on the answer. */
  private focus(state: State, ours: number): number | undefined {
    if (this.target === "nearest") return undefined;
    if (typeof this.target === "number") return this.target;

    const enemies = state.empires.filter((one) => one.alive && one.id !== ours);
    if (enemies.length === 0) return undefined;
    if (this.target === "random") {
      return enemies[this.rng.int(enemies.length)]!.id;
    }
    // Rotate: everyone in turn, on a clock rather than per action, so a push
    // lasts long enough to be a push.
    const turn = Math.floor(state.step / ROTATE_STEPS);
    return enemies[turn % enemies.length]!.id;
  }

  private async act(): Promise<void> {
    if (this.acting || this.lockstep.stopped || this.lockstep.sim.ended) return;
    const step = this.lockstep.step;
    if (step - this.actedAt < this.interval) return;
    // Checked after the interval and before deciding, so a rest costs a turn
    // rather than banking them up to spend the moment it wakes.
    if (!this.awake(this.now())) {
      this.actedAt = step;
      return;
    }

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
