// One game, hosted in one Durable Object.
//
// The room logic lives in @tessera/room; this file gives it what a Durable
// Object has: hibernatable WebSockets, SQLite storage and an alarm.
//
// The room acts only when a message arrives: it stamps moves, catches its own
// simulation up when it needs to, and sends. Between messages nothing runs, so
// the object can hibernate and costs nothing, and clients keep their own
// clocks. The alarm wakes the object for a scheduled start, for the end of a
// running game, and twice a day while one runs to see whether it has ended on
// its own.
//
// What the room reports (a listing row, a player, a result) goes to D1. The
// writes are collected while a handler runs and waited for before it returns.
//
// A game that has ended is archived to R2, and some days later (KEEP_DAYS)
// the object deletes its own storage: from then on the archive is the game.
//
// A game nobody came to (see Room.deserted) goes entirely, once joining has
// closed: its storage and its rows in D1, with no archive.

import { DurableObject } from "cloudflare:workers";
import { Room } from "@tessera/room";
import type { Connection, RoomConfig, RoomEvents } from "@tessera/room";
import { SqlStore } from "./store.js";
import type { StoreUsage } from "./store.js";
import { dropGame, writeGame, writePlayer, writeResult } from "./records.js";
import { writeArchive } from "./archive.js";
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
  /** Its archive is written: a replay can be watched. */
  archived: boolean;
  /** SQLite rows this object has read and written since it last woke. */
  storage: StoreUsage;
}

export class GameRoom extends DurableObject<Env> {
  private store: SqlStore;
  private room: Room | undefined;
  /** The alarm as last read or set, so a message does not have to ask storage. */
  private alarmAt: number | null | undefined;
  /** D1 writes started by the current handler. */
  private writes: Promise<unknown>[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
  }

  /** Create the room. False if this object already holds one. */
  async init(config: RoomConfig): Promise<boolean> {
    if (this.store.get("config")) return false;
    Room.create(this.store, config);
    const room = this.load()!;
    this.events().game?.(room.summary());
    await this.schedule();
    await this.flush();
    return true;
  }

  /** Take a member's name out of this game. See Room.forget. */
  async forgetName(key: string): Promise<boolean> {
    const room = this.load();
    if (!room) return false;
    const forgot = room.forget(key);
    await this.flush();
    return forgot;
  }

  async info(): Promise<RoomInfo | null> {
    const room = this.load();
    if (!room) return null;
    return { roomId: room.id, phase: room.phase, step: room.step, ended: room.ended,
      archived: this.store.get("archivedAt") !== undefined,
      storage: this.store.usage,
    };
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
    await this.flush();
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
    const until = this.keptUntil();
    if (until !== undefined && Date.now() >= until) return this.forget();
    await room.tick();
    if (room.deserted()) {
      await this.flush();
      if (this.env.DB) await dropGame(this.env.DB, room.id).catch((error: unknown) => console.error("D1 delete failed", error));
      return this.forget("nobody played this game");
    }
    await this.schedule();
    await this.flush();
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
    const room = new Room(this.store, { events: this.events() });
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) room.reattach(connection(ws, attachment.id), attachment.key);
    }
    this.room = room;
    return room;
  }

  /** The room's reports, as D1 writes. None without a database. */
  private events(): RoomEvents {
    const db = this.env.DB;
    if (!db) return {};
    const keep = (write: () => Promise<unknown>): void => {
      this.writes.push(
        write().catch((error: unknown) => console.error("D1 write failed", error)),
      );
    };
    return {
      game: (summary) => keep(() => writeGame(db, summary, Date.now())),
      player: (record) => keep(() => writePlayer(db, record)),
      ended: (result) => keep(() => writeResult(db, result)),
    };
  }

  private async flush(): Promise<void> {
    const writes = this.writes;
    this.writes = [];
    await Promise.all(writes);
    await this.archive();
  }

  /** Write a finished game to R2, once. Tried again on the next wake if it
   *  fails, so a game is never deleted unarchived. */
  private async archive(): Promise<void> {
    const room = this.room;
    if (!room?.ended || !this.env.ARCHIVE || this.store.get("archivedAt")) return;
    const archive = room.archive();
    if (!archive) return;
    try {
      await writeArchive(this.env.ARCHIVE, archive);
      this.store.put("archivedAt", Date.now());
      await this.schedule();
    } catch (error) {
      console.error("archive failed", error);
    }
  }

  /** When an archived game's storage goes, or undefined to keep it. */
  private keptUntil(): number | undefined {
    const at = this.store.get<number>("archivedAt");
    if (at === undefined) return undefined;
    const days = Number(this.env.KEEP_DAYS);
    return at + (Number.isFinite(days) && days >= 0 ? days : 30) * 86_400_000;
  }

  /** Delete everything: the game lives on as its archive, or, deserted, not
   *  at all. */
  private async forget(reason = "this game has been archived"): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.room = undefined;
    this.alarmAt = null;
    this.store = new SqlStore(this.ctx.storage);
  }

  /** An alarm whenever the room asks for one, and none otherwise. */
  private async schedule(): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    const wake = room.wakeAt() ?? this.keptUntil();
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
