// A room and its clients in one process, with a clock the test turns.
//
// Delivery is direct and in order, through the same JSON text a socket would
// carry. `settle()` lets every queued handler finish, so a test can say "after
// this, everybody has heard" without racing a timer.

import { Identity } from "@tessera/protocol";
import { Room } from "../room.js";
import { RoomClient } from "../client.js";
import { MemoryStore } from "../store.js";
import type { RoomConfig } from "../messages.js";

export class Clock {
  constructor(public time = 1_800_000_000_000) {}
  now = (): number => this.time;
  advance(ms: number): void {
    this.time += ms;
  }
}

export interface Linked {
  client: RoomClient;
  identity: Identity;
  errors: string[];
  /** Drop the connection. The client keeps its state, as a tab would. */
  drop(): void;
  /** Open a new connection for the same client. */
  reconnect(): void;
}

let ids = 0;

export class Harness {
  readonly clock = new Clock();
  readonly store = new MemoryStore();
  room: Room;
  private readonly pending = new Set<Promise<void>>();

  constructor(config: Partial<RoomConfig> & { creator: string }) {
    Room.create(this.store, {
      roomId: "test-room",
      empires: 2,
      seatsPerEmpire: 2,
      bots: [],
      map: { width: 48, height: 36 },
      duration: 12 * 60 * 30,
      ...config,
    });
    this.room = new Room(this.store, { now: this.clock.now });
  }

  /** Throw the room away and build it again from its store, as a Durable
   *  Object waking up after eviction would. Every connection is lost. */
  restart(): void {
    this.room = new Room(this.store, { now: this.clock.now });
  }

  async join(identity: Identity, name?: string): Promise<Linked> {
    const errors: string[] = [];
    let id = "";
    let open = false;
    const client = new RoomClient({
      identity,
      roomId: this.room.id,
      ...(name ? { name } : {}),
      send: (text) => {
        if (open) this.track(this.room.receive(id, text));
      },
    });
    client.onError = (message) => errors.push(message);

    const connect = (): void => {
      id = `conn-${++ids}`;
      open = true;
      const myId = id;
      this.room.connect({
        id: myId,
        send: (text) => {
          if (open && id === myId) this.track(client.receive(text));
        },
      });
    };
    connect();
    await this.settle();
    return {
      client,
      identity,
      errors,
      drop: () => {
        open = false;
        this.room.disconnect(id);
      },
      reconnect: connect,
    };
  }

  /** Advance the clock in ticks, letting everything settle after each. */
  async run(ms: number, tickMs = 250): Promise<void> {
    for (let t = 0; t < ms; t += tickMs) {
      this.clock.advance(tickMs);
      await this.room.tick();
      await this.settle();
    }
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.pending.size === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (this.pending.size === 0) return;
      }
      await Promise.all([...this.pending]);
    }
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }
}

export async function identities(n: number): Promise<Identity[]> {
  return Promise.all(Array.from({ length: n }, () => Identity.generate()));
}
