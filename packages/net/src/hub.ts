// Several drivers in one tab, sharing one connection to the world.
//
// A PeerBot is a full mesh client: it holds a seat, signs its own moves, and
// runs its own Lockstep. Nothing says that client has to be in its own browser
// — a team that wants night cover should be able to seat a bot from the lobby
// and close the laptop lid on it, not open a second tab and keep it alive.
//
// The obstacle is that a mesh only reaches *other* people. `broadcast` walks
// the open data channels, and a driver in this same page is not on one of them,
// so a locally-seated bot would sign moves that every remote peer applied and
// its own tab never heard — the one peer guaranteed to desync would be the one
// hosting the bot.
//
// The hub is the missing loop-back. It hands out ports that look exactly like a
// Transport, sends what they broadcast both outward and sideways, and fans
// anything arriving from a remote peer to every port. Each port is a peer as
// far as its driver is concerned, and the drivers stay unaware that they share
// a page: the alternative, teaching Lockstep that some seats are local, would
// put a special case in the middle of the consensus code for the sake of a
// convenience feature.
//
// Frames cross the hub as text, exactly as they cross a data channel. Handing
// the same object to two drivers would let one mutate what the other is about
// to read, and that bug would pass every local test and appear only on the
// wire.

import { decodeFrame, encodeFrame } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import type { FrameHandler, Transport } from "./transport.js";

/** How a sibling port's id is built from the shared one. These ids never leave
 *  the page — the mesh gossips its own connection list, not the hub's — but a
 *  suffix the broker would never mint keeps a local id from colliding with a
 *  real peer's if one ever did. */
const SUFFIX = "~";

export class LocalHub {
  private readonly ports = new Map<string, FrameHandler[]>();
  /** Delivery is queued rather than immediate so that a handler which sends
   *  while handling appends to the queue instead of recursing into a second
   *  delivery halfway through the first — the same ordering guarantee a real
   *  channel gives for free, and one the consensus code relies on. */
  private readonly queue: Array<{ from: string; to: string; text: string }> = [];
  private draining = false;
  private unlisten?: () => void;
  private issued = 0;

  constructor(private readonly base: Transport) {
    this.unlisten = base.listen((from, frame) => {
      // A remote peer addresses this whole page by its one mesh id, so there is
      // no way for it to reply to a particular port. Everything it sends is
      // offered to all of them; a driver that did not ask for a snapshot
      // refuses it, which it must do anyway against an unsolicited one.
      const text = encodeFrame(frame);
      for (const id of this.ports.keys()) this.queue.push({ from, to: id, text });
      this.drain();
    });
  }

  /** A transport for one more driver in this page. The first port takes the
   *  mesh's own id, so a page with no bots in it behaves exactly as it did
   *  before the hub existed. */
  port(): Transport {
    const id = this.issued === 0 ? this.base.id : `${this.base.id}${SUFFIX}${this.issued}`;
    this.issued++;
    this.ports.set(id, []);

    const hub = this;
    return {
      id,
      peers: () => [...hub.ports.keys(), ...hub.base.peers()].filter((peer) => peer !== id),
      broadcast(frame) {
        hub.base.broadcast(frame);
        hub.sideways(id, frame);
      },
      send(to, frame) {
        if (hub.ports.has(to)) hub.post(id, to, frame);
        else hub.base.send(to, frame);
      },
      listen(handler) {
        const list = hub.ports.get(id);
        if (!list) return () => {};
        list.push(handler);
        return () => {
          const at = list.indexOf(handler);
          if (at >= 0) list.splice(at, 1);
        };
      },
    };
  }

  close(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.ports.clear();
    this.queue.length = 0;
  }

  /** Queue the whole fan-out before delivering any of it. Draining after each
   *  recipient would let the first one's reply overtake the second one's copy
   *  of the original — two drivers in one page seeing one broadcast in two
   *  different orders, which is precisely what a shared transport must not do. */
  private sideways(from: string, frame: Frame): void {
    const text = encodeFrame(frame);
    for (const id of this.ports.keys()) {
      if (id !== from) this.queue.push({ from, to: id, text });
    }
    this.drain();
  }

  private post(from: string, to: string, frame: Frame): void {
    if (!this.ports.has(to)) return;
    this.queue.push({ from, to, text: encodeFrame(frame) });
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // Not a for-of: handlers push onto this queue while it is being walked,
      // and those frames belong at the end of this same drain.
      while (this.queue.length > 0) {
        const envelope = this.queue.shift()!;
        const frame = decodeFrame(envelope.text);
        if (!frame) continue;
        for (const handler of [...(this.ports.get(envelope.to) ?? [])]) {
          handler(envelope.from, frame);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
