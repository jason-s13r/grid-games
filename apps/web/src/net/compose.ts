// Whether this tab may be the one to seal the record, in somebody else's room.
//
// Backend 2 is "paste a host peer's ref; the tab composes the plan". The
// mechanism has always worked — `Lobby.host` checks the plan and nothing about
// the phase, so any peer in a room may seal a genesis and broadcast it — and
// that is precisely the problem. Give every tab in a room the button and two
// people pressing it seal two different games; each peer plays whichever GENESIS
// frame reached it first, and the room splits with no error anywhere.
//
// 0009 is the answer: a record composed together and co-signed, so there is no
// first-frame-wins to lose to. Until it lands this is the narrow version and it
// is narrow on purpose — the tab offers to compose only while the room says no
// game is running in it, which closes the common case (arriving at a game that
// already started) and leaves the race between two people who arrived at an
// empty room in the same minute.
//
// A disabled button is a UI convention and not a rule. The rule arrives in 0009.

import type { ConnectionRef } from "@tessera/net";

/** What 0006's `GET /room/:code` answers. `gameId` is the empty string before a
 *  record is sealed — an absent field would be indistinguishable from an older
 *  host that never had one, so the check below is against `""` and not against
 *  `undefined`. */
export interface RoomStatus {
  gameId: string;
  step: number;
  peers: number;
  ended: boolean;
}

/** Long enough for a host on a bad link, short enough that the offer to compose
 *  appears while the player is still looking at the room. */
export const STATUS_TIMEOUT_MS = 5_000;

/** Where a socket ref's room reports its state, or nothing.
 *
 *  A WebRTC room has no such URL, and that is not an omission: the room is
 *  another tab, there is nothing in front of it to ask, and a tab that dialled
 *  another tab's code was sent it by a person who knows what is behind it. So
 *  backend 2 is a socket question only. */
export function statusUrl(ref: ConnectionRef): string | undefined {
  if (ref.kind !== "socket") return undefined;
  // One port carries both the upgrade and the reads (0006), so the http origin
  // is the ws one with the scheme swapped. `wss` → `https`, which is also what
  // keeps this reachable from a page on https at all.
  return `${ref.url.replace(/^ws/i, "http")}/room/${encodeURIComponent(ref.room)}`;
}

/** Ask the room what is running in it. Undefined for every way of not knowing —
 *  no URL, no answer, a 404 from a host that has never heard of the room, a body
 *  that is not the shape above — because "I could not find out" and "there is no
 *  game" are different answers and only one of them may unlock a button. */
export async function roomStatus(
  ref: ConnectionRef,
  http: typeof fetch = (...args) => globalThis.fetch(...args),
  timeoutMs: number = STATUS_TIMEOUT_MS,
): Promise<RoomStatus | undefined> {
  const url = statusUrl(ref);
  if (!url) return undefined;
  try {
    const response = await http(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return undefined;
    const status = body as Partial<RoomStatus>;
    if (typeof status.gameId !== "string" || typeof status.step !== "number") return undefined;
    return {
      gameId: status.gameId,
      step: status.step,
      peers: typeof status.peers === "number" ? status.peers : 0,
      ended: status.ended === true,
    };
  } catch {
    return undefined;
  }
}

/** Whether this tab may offer to compose in that room.
 *
 *  Undefined is a no. A host that did not answer might be running a game, and a
 *  tab that composed one into it would be the second record in a room that
 *  already had one — which is the exact failure this guard exists to avoid, so
 *  silence is read as occupied. */
export function mayCompose(status: RoomStatus | undefined): boolean {
  return status !== undefined && status.gameId === "" && !status.ended;
}
