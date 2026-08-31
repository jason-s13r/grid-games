// Who may act, and as whom.
//
// A signed move carries no key: it carries (empire, member), and the roster
// says which key sits there. That is deliberate. If the key travelled in the
// move, a verifier would have to decide whether to trust it, and "signature
// valid for the key it names" proves nothing at all. Looking the key up by seat
// means a valid signature is automatically a signature from the seat's holder.
//
// The roster is mutable because ROSTER_AMEND is: a substitute joining on day
// three is a normal part of a marathon game. Every peer applies amendments in
// log order, so every peer's roster is the same at the same step.

import { MEMBER } from "@tessera/sim";
import type { Genesis, MemberKind } from "@tessera/sim";
import type { MemberKey } from "./identity.js";

export interface Seat {
  empire: number;
  member: number;
  key: MemberKey;
  kind: MemberKind;
  joinedAt: number;
}

export class Roster {
  /** empire id -> member index -> seat. Sparse only in that a SimBot seat has
   *  no key and therefore no entry. */
  private readonly seats = new Map<number, Map<number, Seat>>();
  private readonly byKey = new Map<MemberKey, Seat>();
  private readonly sizes = new Map<number, number>();

  static fromGenesis(genesis: Genesis): Roster {
    const roster = new Roster();
    genesis.empires.forEach((empire, offset) => {
      const id = offset + 1; // empire 0 is neutral
      roster.sizes.set(id, empire.members.length);
      empire.members.forEach((member, index) => {
        if (!member.key) return;
        roster.seat({
          empire: id,
          member: index,
          key: member.key,
          kind: member.kind ?? MEMBER.HUMAN,
          joinedAt: 0,
        });
      });
    });
    return roster;
  }

  private seat(seat: Seat): void {
    let empire = this.seats.get(seat.empire);
    if (!empire) {
      empire = new Map();
      this.seats.set(seat.empire, empire);
    }
    empire.set(seat.member, seat);
    this.byKey.set(seat.key, seat);
  }

  keyOf(empire: number, member: number): MemberKey | undefined {
    return this.seats.get(empire)?.get(member)?.key;
  }

  seatOf(key: MemberKey): Seat | undefined {
    return this.byKey.get(key);
  }

  size(empire: number): number {
    return this.sizes.get(empire) ?? 0;
  }

  /** Keyed seats of one empire, ordered by member index — the signers an
   *  amendment quorum is counted against. */
  membersOf(empire: number): Seat[] {
    const seats = this.seats.get(empire);
    if (!seats) return [];
    return [...seats.values()].sort((a, b) => a.member - b.member);
  }

  /** Strict majority of the keyed seats. A single-member empire is its own
   *  quorum, which is what lets a solo player recruit a teammate. */
  quorum(empire: number): number {
    return Math.floor(this.membersOf(empire).length / 2) + 1;
  }

  /** Append a seat, mirroring what applyMove does to the simulation: the sim
   *  pushes a Member, this pushes the key that authorises it. The returned
   *  index is the one the ROSTER_AMEND move must produce. */
  amend(empire: number, key: MemberKey, kind: MemberKind, step: number): number {
    const member = this.size(empire);
    this.sizes.set(empire, member + 1);
    this.seat({ empire, member, key, kind, joinedAt: step });
    return member;
  }

  has(key: MemberKey): boolean {
    return this.byKey.has(key);
  }

  /** Every keyed seat in the game. An observer holds no seat, which is why an
   *  uninvited peer is an observer by construction rather than by permission. */
  all(): Seat[] {
    return [...this.byKey.values()];
  }
}
