// One game, hosted in one Durable Object.
//
// The room logic lives in @tessera/room; this file gives it what a Durable
// Object has: hibernatable WebSockets, SQLite storage, timers and an alarm.
//
// While anybody is connected, an in-memory timer ticks every TICK_MS and the
// room seals the steps that have passed. A timer costs compute time only; an
// alarm would also cost a request and a row written per tick, which is about
// 14,400 of each per hour of play. So the alarm is kept for what a timer
// cannot do: waking the object for a scheduled start, and a slow fallback tick
// in case the object is evicted with players still connected. With nobody
// connected nothing runs, and the next connection catches the world up.

import { DurableObject } from "cloudflare:workers";

/** The fallback alarm while players are connected. */
const FALLBACK_MS = 30_000;
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** The alarm as last read or set, so a tick does not have to ask storage. */
  private alarmAt: number | null | undefined;

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
    this.alarmAt = null; // it has fired
    const room = this.load();
    if (!room) return;
    await room.tick();
    await this.schedule();
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.room) return;
    this.ticking = true;
    try {
      await this.room.tick();
      if (!this.room.wantsTicks()) await this.schedule();
    } finally {
      this.ticking = false;
    }
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
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();

    if (room.wantsTicks()) {
      this.timer ??= setInterval(() => void this.tick(), TICK_MS);
      const now = Date.now();
      if (this.alarmAt === null || this.alarmAt < now || this.alarmAt > now + FALLBACK_MS) {
        await this.setAlarm(now + FALLBACK_MS);
      }
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
