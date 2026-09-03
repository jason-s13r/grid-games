// Mesh play: the same simulation, driven by signed moves from every seat.
//
// Nothing here decides anything about the game. It adapts the lockstep driver
// to the interface the view already speaks, and turns its callbacks into a line
// of text a player can read.

import { MOVE, STEPS_PER_SECOND } from "@tessera/sim";
import type { Move, Sim } from "@tessera/sim";
import type { Lockstep, PeerMesh } from "@tessera/net";
import type { Driver, MoveKind } from "./Driver";

export class OnlineGame implements Driver {
  readonly online = true;
  /** Wall-clock time is the game's clock, so there is nothing to pause: the
   *  world turns whether or not this tab is watching. */
  readonly running = true;

  private note = "";
  /** Game step at which the note stops being news. */
  private noteUntil = 0;

  constructor(
    private readonly lockstep: Lockstep,
    private readonly mesh: PeerMesh,
  ) {
    lockstep.onEjection = (who, atStep, reason) => {
      const seat = `Empire ${who.empire} seat ${who.member}`;
      const why =
        reason === "equivocation"
          ? "was caught sending conflicting moves and was removed"
          : reason === "desync"
            ? "kept disagreeing about the state of the game and was dropped"
            : "stopped responding and was dropped";
      this.say(`${seat} ${why} at step ${atStep}.`);
    };
    lockstep.onDesync = (step) => {
      this.say(`State disagreement at step ${step} — rebuilding from a checkpoint.`);
      lockstep.requestSnapshot(step);
    };
    lockstep.onHalt = (reason) => {
      this.say(`Stopped: ${reason}`, Infinity);
    };
  }

  /** A note is news, not state. A peer that resumed from a snapshot repairs the
   *  disagreement that prompted it within a step or two, and leaving the notice
   *  up afterwards tells every player the game is broken when it is not. Only a
   *  halt is permanent, because only a halt is still true a minute later. */
  private say(text: string, seconds = 12): void {
    this.note = text;
    this.noteUntil = this.sim.step + STEPS_PER_SECOND * seconds;
  }

  get sim(): Sim {
    return this.lockstep.sim;
  }

  /** Read from the driver rather than stored, because it can change: a peer
   *  that arrived mid-game holds no seat until an empire votes it one, and
   *  from that step onwards it is an ordinary player. Empire 0 is neutral, so
   *  an observer highlights nothing and owns nothing. */
  get empire(): number {
    return this.lockstep.seat?.empire ?? 0;
  }

  get member(): number {
    return this.lockstep.seat?.member ?? 0;
  }

  /** True while this peer is watching rather than playing. */
  get watching(): boolean {
    return !this.lockstep.seat;
  }

  pause(): void {
    /* nothing to pause */
  }

  resume(): void {
    /* nothing to resume */
  }

  claim(x: number, y: number): boolean {
    return this.act(MOVE.CLAIM, x, y);
  }

  /** The simulation is asked first purely so a rejected click feels rejected.
   *  What actually decides is the same check running on every peer when the
   *  step comes round. */
  act(type: MoveKind, x = 0, y = 0): boolean {
    const seat = this.lockstep.seat;
    if (!seat) return false; // watching, not playing
    const probe: Move = {
      step: this.sim.step,
      empire: seat.empire,
      member: seat.member,
      seq: 0,
      type,
      x,
      y,
    };
    if (type !== MOVE.HEARTBEAT && !this.sim.validate(probe)) return false;
    void this.lockstep.submit(type, x, y);
    return true;
  }

  tick(): Set<number> {
    return this.lockstep.pump();
  }

  status(): string {
    if (this.note && this.sim.step < this.noteUntil) return this.note;

    const waiting = this.lockstep.blockedOn();
    if (waiting.length > 0) {
      const who = waiting.map((seat) => `E${seat.empire}·${seat.member}`).join(", ");
      return `Waiting for ${who}`;
    }
    if (!this.lockstep.seat) {
      return `Watching · ${this.mesh.peers().length} peers · step ${this.lockstep.step}`;
    }
    const peers = this.mesh.peers().length;
    return `${peers} peer${peers === 1 ? "" : "s"} · step ${this.lockstep.step}`;
  }
}
