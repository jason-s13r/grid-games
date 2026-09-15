// Putting a game this tab is hosting on an address book.
//
// Announcing is not a way of starting a game differently. The record is sealed
// the same way, the room is the same room, and every peer checks the same
// things. What it changes is who can see it: `announce()` posts the sealed
// genesis record — which carries every member key in the roster, each player's
// stable public identity — to a server chosen by whoever configured the board.
// That is a disclosure, so the tab asks first, and the checkbox is off.
//
// The other half of the honesty is here rather than in the UI: a tab may only
// announce a door it is actually holding open. See `doorOf`.

import { formatRef } from "@tessera/net";
import type { ConnectionRef, Directory, Listing, Lobby, ResumePoint } from "@tessera/net";
import type { Identity } from "@tessera/protocol";
import type { Genesis } from "@tessera/sim";

/** How long a row this tab posted stays on the board without being refreshed.
 *
 *  A tab is not a process. A phone swiped away, a crashed renderer and a closed
 *  laptop lid all skip every teardown a page can register, so the TTL is the
 *  mechanism that removes a dead row and the withdrawal below is a courtesy.
 *  Three minutes is the host peer's default (`--ttl`) and there is no reason for
 *  a browser's rows to expire on a different schedule than a process's. */
export const TTL_MS = 180_000;

/** Half the TTL, so one missed beat is survivable and two are not. Browsers
 *  clamp timers in a backgrounded tab and may not run this for an hour, which
 *  is another way of saying the TTL is the mechanism. */
export const BEAT_MS = TTL_MS / 2;

/** A door, or nothing at all.
 *
 *  A tab hosting over WebRTC is genuinely dialable — its peer id *is* the
 *  room — so it announces and heartbeats like any other announcer. A tab that
 *  joined somebody's room bus is a guest in it: the door is the host peer's, it
 *  is already on the board (0006 announces its own room), and re-posting it
 *  would put a row on a TTL that this tab happens to keep alive and takes down
 *  when it closes. Same for a room a managed factory made. */
export function doorOf(lobby: Lobby): ConnectionRef | undefined {
  return lobby.hosting && lobby.ref.kind === "rtc" ? lobby.ref : undefined;
}

/** The row, rebuilt each beat so its proof keeps up with the game.
 *
 *  The witnesses are the resume point's with the snapshot left off: a majority
 *  of this game's own seats signing (step, hash) is the only field on a board a
 *  reader can believe without dialling, and it costs a few hundred bytes rather
 *  than a megabyte.
 *
 *  Nothing claims `seatsUsed`. This tab knows how many peers are connected, not
 *  how many seats are held, and announcing the first as the second would be
 *  exactly the claim a reader is right not to trust. */
export function rowFor(
  genesis: Genesis,
  door: ConnectionRef,
  point: ResumePoint | undefined,
  now: number,
  ttlMs: number = TTL_MS,
): Listing {
  return {
    gameId: genesis.gameId!,
    genesis,
    refs: [formatRef(door)],
    ...(point
      ? {
          step: point.step,
          hash: point.hash,
          witnesses: point.witnesses,
          amendments: point.amendments,
          drops: point.drops,
        }
      : {}),
    expiresAt: now + ttlMs,
  };
}

export interface AnnouncerOptions {
  ttlMs?: number;
  beatMs?: number;
  now?: () => number;
  /** Where a failure goes. A board being down is never a reason to stop holding
   *  a game open for the people already in it, so nothing here throws and the
   *  default is to say nothing at all. */
  onProblem?: (message: string) => void;
}

/** One game's row, kept alive for as long as this tab holds the door.
 *
 *  A lease, not a registration — which is the same shape 0006 uses, for the
 *  same reason: nothing that can be killed gets to be the thing that cleans up
 *  after itself. */
export class Announcer {
  private beating?: ReturnType<typeof setInterval>;
  private row?: Listing;
  private proof?: () => ResumePoint | undefined;

  constructor(
    private readonly board: Directory,
    private readonly identity: Identity,
    private readonly options: AnnouncerOptions = {},
  ) {}

  /** Whether a row of ours is up. */
  get listed(): boolean {
    return this.row !== undefined;
  }

  /** Post the door and start the heartbeat. Safe to call for a game with no
   *  door: a guest announces nothing, which is the guard's whole job. */
  start(genesis: Genesis, door: ConnectionRef | undefined, proof: () => ResumePoint | undefined): void {
    if (this.row || !door || !genesis.gameId) return;
    const ttlMs = this.options.ttlMs ?? TTL_MS;
    const now = this.options.now ?? Date.now;
    this.proof = proof;
    this.row = rowFor(genesis, door, undefined, now(), ttlMs);

    const post = async (): Promise<void> => {
      if (!this.row) return;
      this.row = rowFor(genesis, door, this.proof?.(), now(), ttlMs);
      try {
        await this.board.present(this.identity, this.row);
      } catch (error) {
        this.options.onProblem?.((error as Error).message);
      }
    };

    void post();
    this.beating = setInterval(() => void post(), this.options.beatMs ?? BEAT_MS);
  }

  /** Take the row down, and stop beating either way.
   *
   *  Said out loud on the way out so the board is only wrong for as long as it
   *  takes one request, and never waited on: leaving a game must not be slower
   *  than the slowest board somebody configured. */
  stop(): void {
    if (this.beating) clearInterval(this.beating);
    this.beating = undefined;
    const row = this.row;
    this.row = undefined;
    this.proof = undefined;
    if (!row) return;
    void this.board
      .withdraw(this.identity, row.gameId, row.refs)
      .catch((error: Error) => this.options.onProblem?.(error.message));
  }
}
