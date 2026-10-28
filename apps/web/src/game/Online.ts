// An online game: the moves come from a game room.
//
// The room decides which step each move lands on and sends the moves in
// batches; the RoomClient simulates them. This driver adapts that to what the
// view needs: the current simulation, the tiles changed since the last frame,
// and a way to send a move.

import { CLAIM, MOVE } from "@tessera/sim";
import type { Move, Sim } from "@tessera/sim";
import type { RoomClient } from "@tessera/room";
import type { Driver, MoveKind } from "./Driver";

export class OnlineGame implements Driver {
  readonly online = true;
  readonly running = true;

  private dirty = new Set<number>();
  /** The world was replaced (joined, resynced): repaint all of it. */
  private repaint = true;

  constructor(private readonly client: RoomClient) {
    client.onAdvance = (dirty) => {
      for (const tile of dirty) this.dirty.add(tile);
    };
    client.onReset = () => {
      this.repaint = true;
    };
  }

  get sim(): Sim {
    return this.client.sim!;
  }

  /** 0 while spectating: an empire id no seat can hold. */
  get empire(): number {
    return this.client.you?.seat?.empire ?? 0;
  }

  get member(): number {
    return this.client.you?.seat?.member ?? 0;
  }

  pause(): void {}
  resume(): void {}

  claim(x: number, y: number): boolean {
    return this.send(CLAIM(0, this.empire, this.member, 0, x, y));
  }

  act(type: MoveKind, x = 0, y = 0): boolean {
    return this.send({ step: 0, empire: this.empire, member: this.member, seq: 0, type, x, y });
  }

  /** Checked against our own simulation for feedback only. The move is applied
   *  when it comes back from the room, and validated again then by every
   *  client; that check is the one that decides. */
  private send(move: Move): boolean {
    if (!this.empire || move.type === MOVE.HEARTBEAT) return false;
    if (!this.sim.validate({ ...move, step: this.sim.step })) return false;
    void this.client.submit(move.type, move.x, move.y);
    return true;
  }

  tick(): Set<number> {
    if (this.repaint) {
      this.repaint = false;
      this.dirty.clear();
      const all = new Set<number>();
      for (let i = 0; i < this.sim.state.owner.length; i++) all.add(i);
      return all;
    }
    const dirty = this.dirty;
    this.dirty = new Set();
    return dirty;
  }

  status(): string {
    if (this.sim.ended) return "Game over";
    return this.empire ? "" : "Spectating";
  }
}
