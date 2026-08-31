// Scheduled world events.
//
// The world runs on wall-clock time, so a peer returning after six hours must
// fast-forward ~260,000 steps. Scanning the map per tick would take a minute;
// draining a few hundred scheduled events takes milliseconds, and empty steps
// cost nothing at all.
//
// Ordering is by (step, seq) with a monotonic seq, a total order — so heap
// tie-breaks can never differ between peers.

export const EVENT = { SPAWN: 0 } as const;
export type EventType = (typeof EVENT)[keyof typeof EVENT];

export interface ScheduledEvent {
  step: number;
  seq: number;
  type: EventType;
  payload: number;
}

const before = (a: ScheduledEvent, b: ScheduledEvent): boolean =>
  a.step !== b.step ? a.step < b.step : a.seq < b.seq;

export class EventQueue {
  heap: ScheduledEvent[] = [];
  seq = 0;

  get size(): number {
    return this.heap.length;
  }

  /** Step of the next pending event, or Infinity — lets fastForward() skip
   *  straight to the next thing that actually happens. */
  get nextStep(): number {
    return this.heap.length === 0 ? Infinity : this.heap[0]!.step;
  }

  push(step: number, type: EventType, payload = 0): ScheduledEvent {
    const node: ScheduledEvent = { step, seq: this.seq++, type, payload };
    const heap = this.heap;
    heap.push(node);

    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
    return node;
  }

  /** Next event due at or before `step`, else null. */
  poll(step: number): ScheduledEvent | null {
    const heap = this.heap;
    if (heap.length === 0 || heap[0]!.step > step) return null;

    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && before(heap[l]!, heap[best]!)) best = l;
        if (r < heap.length && before(heap[r]!, heap[best]!)) best = r;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best]!, heap[i]!];
        i = best;
      }
    }
    return top;
  }

  /** Rebuild from a canonical, already-sorted list, preserving each event's
   *  original seq. A sorted array satisfies the heap property, so it can be
   *  adopted directly — reassigning seqs here would change the state hash
   *  without changing behaviour. */
  load(events: ScheduledEvent[]): void {
    this.heap = events.slice();
  }

  /** Canonical order for serialisation. */
  toSorted(): ScheduledEvent[] {
    return this.heap.slice().sort((a, b) => (before(a, b) ? -1 : 1));
  }
}
