// What the lockstep driver needs from a network, and nothing more.
//
// The driver never mentions PeerJS, WebRTC or a socket. That is not tidiness:
// it is what makes the consensus logic testable at all. A loopback network in
// this file runs six drivers in one Node process with deterministic delivery
// order, so "do peers converge" is a check in CI rather than two browser tabs
// and a squint.

import { decodeFrame, encodeFrame } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";

export type FrameHandler = (from: string, frame: Frame) => void;

export interface Transport {
  readonly id: string;
  peers(): readonly string[];
  broadcast(frame: Frame): void;
  send(to: string, frame: Frame): void;
  /** Returns the unsubscribe function. */
  listen(handler: FrameHandler): () => void;
}

interface Envelope {
  from: string;
  to: string;
  /** Serialised, not the object: a peer receives bytes, and a driver that
   *  accidentally relies on sharing an object with the sender would pass a
   *  loopback test and fail on the wire. */
  text: string;
  due: number;
}

export interface LoopbackOptions {
  /** Delivery delay in flushes. 0 means the next flush delivers it. */
  latency?: number;
  /** Return true to drop a frame on the floor — packet loss on demand. */
  drop?: (from: string, to: string, frame: Frame) => boolean;
}

/** An in-memory switch. Delivery is explicit: nothing arrives until flush() is
 *  called, so a test controls interleaving exactly and never races a timer. */
export class LoopbackNetwork {
  private readonly handlers = new Map<string, FrameHandler[]>();
  private queue: Envelope[] = [];
  private clock = 0;
  sent = 0;
  delivered = 0;
  dropped = 0;

  constructor(private readonly options: LoopbackOptions = {}) {}

  connect(id: string): Transport {
    if (this.handlers.has(id)) throw new Error(`peer ${id} is already connected`);
    this.handlers.set(id, []);

    const network = this;
    return {
      id,
      peers: () => [...network.handlers.keys()].filter((peer) => peer !== id),
      broadcast(frame) {
        for (const peer of this.peers()) network.enqueue(id, peer, frame);
      },
      send(to, frame) {
        network.enqueue(id, to, frame);
      },
      listen(handler) {
        const list = network.handlers.get(id)!;
        list.push(handler);
        return () => {
          const at = list.indexOf(handler);
          if (at >= 0) list.splice(at, 1);
        };
      },
    };
  }

  disconnect(id: string): void {
    this.handlers.delete(id);
    this.queue = this.queue.filter((envelope) => envelope.to !== id && envelope.from !== id);
  }

  private enqueue(from: string, to: string, frame: Frame): void {
    if (!this.handlers.has(to)) return;
    if (this.options.drop?.(from, to, frame)) {
      this.dropped++;
      return;
    }
    this.sent++;
    this.queue.push({
      from,
      to,
      text: encodeFrame(frame),
      due: this.clock + (this.options.latency ?? 0),
    });
  }

  /** Deliver everything due now. Frames sent by a handler during delivery land
   *  in the next flush, so a chain of reactions cannot starve the caller. */
  flush(): number {
    const due = this.queue.filter((envelope) => envelope.due <= this.clock);
    this.queue = this.queue.filter((envelope) => envelope.due > this.clock);
    this.clock++;

    for (const envelope of due) {
      const frame = decodeFrame(envelope.text);
      if (!frame) continue; // a peer that emits garbage is simply not heard
      this.delivered++;
      for (const handler of this.handlers.get(envelope.to) ?? []) {
        handler(envelope.from, frame);
      }
    }
    return due.length;
  }

  pending(): number {
    return this.queue.length;
  }
}
