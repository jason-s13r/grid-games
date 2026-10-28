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
  /** Hand this client's open socket to a rebuilt room, as a woken Durable
   *  Object does with the sockets it kept. */
  reattach(room: Room): void;
  /** Hold everything the room sends this client, as a slow network would. */
  hold(): void;
  /** Deliver what was held, in order. */
  release(): void;
}

let ids = 0;

export class Harness {
  readonly clock = new Clock();
  readonly store = new MemoryStore();
  room: Room;
  private readonly pending = new Set<Promise<void>>();
  private readonly clients: RoomClient[] = [];

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

  async join(identity: Identity, name?: string, options: { bot?: boolean } = {}): Promise<Linked> {
    const errors: string[] = [];
    let id = "";
    let open = false;
    let held: string[] | undefined;
    const client = new RoomClient({
      identity,
      now: this.clock.now,
      roomId: this.room.id,
      ...(options.bot ? { bot: true } : {}),
      ...(name ? { name } : {}),
      send: (text) => {
        if (open) this.track(this.room.receive(id, text));
      },
    });
    client.onError = (message) => errors.push(message);
    this.clients.push(client);

    const socket = (myId: string) => ({
      id: myId,
      send: (text: string) => {
        if (!open || id !== myId) return;
        if (held) held.push(text);
        else this.track(client.receive(text));
      },
    });
    const connect = (): void => {
      id = `conn-${++ids}`;
      open = true;
      this.room.connect(socket(id));
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
      reattach: (room) => room.reattach(socket(id), identity.key),
      hold: () => {
        held = [];
      },
      release: () => {
        const texts = held ?? [];
        held = undefined;
        for (const text of texts) this.track(client.receive(text));
      },
    };
  }

  /** Advance the clock in frames, letting every client simulate up to now and
   *  everything settle after each. The room is not ticked: it acts on
   *  messages, as it does when hosted, except for a scheduled start. */
  async run(ms: number, frameMs = 250): Promise<void> {
    for (let t = 0; t < ms; t += frameMs) {
      this.clock.advance(frameMs);
      await this.room.tick();
      for (const client of this.clients) client.advance();
      await this.settle();
    }
  }

  /** The room's step and hash, caught up to now, to compare clients against. */
  roomStep(): number {
    return this.room.catchUp();
  }

  roomHash(): number | undefined {
    this.room.catchUp();
    return this.room.hash();
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
