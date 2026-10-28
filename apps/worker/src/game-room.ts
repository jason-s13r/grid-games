// One game, hosted in one Durable Object.
//
// The room logic lives in @tessera/room; this file gives it what a Durable
// Object has: hibernatable WebSockets, SQLite storage and an alarm. While
// anybody is connected the alarm fires every TICK_MS and the room seals the
// steps that have passed. With nobody connected there is no alarm (except a
// scheduled start), the object can be evicted, and the next connection wakes it
// and catches the world up.

import { DurableObject } from "cloudflare:workers";
import { Room, TICK_MS } from "@tessera/room";
import type { Connection, RoomConfig } from "@tessera/room";
import { SqlStore } from "./store.js";
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
}

export class GameRoom extends DurableObject<Env> {
  private readonly store: SqlStore;
  private room: Room | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
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
    return { roomId: room.id, phase: room.phase, step: room.step, ended: room.ended };
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

  /** Tick while somebody is here; otherwise sleep until a scheduled start. */
  private async schedule(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const current = await this.ctx.storage.getAlarm();
    if (room.wantsTicks()) {
      const at = Date.now() + TICK_MS;
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      return;
    }
    const wake = room.wakeAt();
    if (wake !== undefined) {
      if (current !== wake) await this.ctx.storage.setAlarm(wake);
    } else if (current !== null) {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

function connection(ws: WebSocket, id: string): Connection {
  return {
    id,
    send: (text) => ws.send(text),
  };
}
