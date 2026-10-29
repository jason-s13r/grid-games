// One game, hosted in one Durable Object.
//
// The room logic lives in @tessera/room; this file gives it what a Durable
// Object has: hibernatable WebSockets, SQLite storage and an alarm.
//
// The room acts only when a message arrives: it stamps moves, catches its own
// simulation up when it needs to, and sends. Between messages nothing runs, so
// the object can hibernate and costs nothing, and clients keep their own
// clocks. The alarm is for one thing only: waking the object for a scheduled
// start.

import { DurableObject } from "cloudflare:workers";
import { Room } from "@tessera/room";
import type { Connection, RoomConfig } from "@tessera/room";
import { SqlStore } from "./store.js";
import type { StoreUsage } from "./store.js";
import type { Env } from "./env.js";

/** What each socket carries across hibernation. */
interface Attachment {
  id: string;
  key?: string;
}

export interface RoomInfo {
  roomId: string;
  phase: "lobby" | "playing";
  step: number;
  ended: boolean;
  /** SQLite rows this object has read and written since it last woke. */
  storage: StoreUsage;
}

export class GameRoom extends DurableObject<Env> {
  private readonly store: SqlStore;
  private room: Room | undefined;
  /** The alarm as last read or set, so a message does not have to ask storage. */
  private alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
  }

  /** Create the room. False if this object already holds one. */
  async init(config: RoomConfig): Promise<boolean> {
    if (this.store.get("config")) return false;
    Room.create(this.store, config);
    this.load();
    await this.schedule();
    return true;
  }

  async info(): Promise<RoomInfo | null> {
    const room = this.load();
    if (!room) return null;
    return { roomId: room.id, phase: room.phase, step: room.step, ended: room.ended, storage: this.store.usage };
  }

  override async fetch(request: Request): Promise<Response> {
    const room = this.load();
    if (!room) return new Response("no such game", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { id: crypto.randomUUID() };
    server.serializeAttachment(attachment);
    room.connect(connection(server, attachment.id));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const room = this.load();
    if (!room || typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as Attachment;
    await room.receive(attachment.id, message);

    // Keep the proved key with the socket, so a woken room can take it back
    // without asking again.
    const key = room.keyOf(attachment.id);
    if (key && key !== attachment.key) ws.serializeAttachment({ ...attachment, key });
    await this.schedule();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.drop(ws);
    try {
      ws.close(code, "closing");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.drop(ws);
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null; // it has fired
    const room = this.load();
    if (!room) return;
    await room.tick();
    await this.schedule();
  }

  private drop(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment) this.room?.disconnect(attachment.id);
  }

  /** The room, built from storage on first use after a wake. Sockets that
   *  survived hibernation are handed back to it. */
  private load(): Room | undefined {
    if (this.room) return this.room;
    if (!this.store.get("config")) return undefined;
    const room = new Room(this.store);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) room.reattach(connection(ws, attachment.id), attachment.key);
    }
    this.room = room;
    return room;
  }

  /** An alarm for a scheduled start, and none otherwise. */
  private async schedule(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    const wake = room.wakeAt();
    if (wake !== undefined) {
      if (this.alarmAt !== wake) await this.setAlarm(wake);
    } else if (this.alarmAt !== null) {
      await this.ctx.storage.deleteAlarm();
      this.alarmAt = null;
    }
  }

  private async setAlarm(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }
}

function connection(ws: WebSocket, id: string): Connection {
  return {
    id,
    send: (text) => ws.send(text),
  };
}
