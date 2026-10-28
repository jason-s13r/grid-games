// An online game: the moves come from a game room.
//
// The room decides which step each move lands on; the RoomClient simulates up
// to now on its own clock, every frame. This driver adapts that to what the
// view needs: the current simulation, the tiles changed since the last frame,
// and a way to send a move.

import { CLAIM, MOVE } from "@tessera/sim";
import type { Move, Sim } from "@tessera/sim";
import type { RoomClient } from "@tessera/room";
import type { Driver, MoveKind } from "./Driver";

export class OnlineGame implements Driver {
  readonly online = true;
  readonly running = true;

  /** The world was replaced (joined, resynced, rewound): repaint all of it. */
  private repaint = true;

  constructor(private readonly client: RoomClient) {
    client.onReset = () => {
      this.repaint = true;
    };
  }

  get sim(): Sim {
    return this.client.sim!;
  }

  /** The seat, once our simulation has reached the step that created it. A
   *  seat given mid-game is announced before the ROSTER_AMEND lands, half a
   *  second later, and until then there is no member to draw. */
  private get seat(): { empire: number; member: number } | undefined {
    const seat = this.client.you?.seat;
    if (!seat || !this.sim.state.empires[seat.empire - 1]?.members[seat.member]) return undefined;
    return seat;
  }

  /** 0 while spectating: an empire id no seat can hold. */
  get empire(): number {
    return this.seat?.empire ?? 0;
  }

  get member(): number {
    return this.seat?.member ?? 0;
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
    const dirty = this.client.advance();
    if (!this.repaint) return dirty;
    this.repaint = false;
    const all = new Set<number>();
    for (let i = 0; i < this.sim.state.owner.length; i++) all.add(i);
    return all;
  }

  status(): string {
    if (this.sim.ended) return "Game over";
    return this.empire ? "" : "Spectating";
  }
}
