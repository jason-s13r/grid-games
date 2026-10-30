// Moving a player to another device: the meeting place.
//
// The new device opens a pairing under a short code and shows it; the old
// device types the code and joins. This object passes their messages across
// and nothing else: the two derive a shared secret from keys made for the
// occasion, and the player's key goes over sealed with it, so what passes
// through here is of no use to anybody reading it. A pairing lasts ten
// minutes at most and keeps nothing.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

/** How long a code stays open. */
const OPEN_MS = 10 * 60_000;
/** The largest message passed on: a public key, or the sealed player. */
const MAX_MESSAGE = 4096;

type Side = "new" | "old";

export class Pairing extends DurableObject<Env> {
  private readonly sides = new Map<Side, WebSocket>();
  private opened = 0;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const side = new URL(request.url).searchParams.get("as");
    if (side !== "new" && side !== "old") return new Response("as=new or as=old", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    const now = Date.now();
    if (this.opened && now - this.opened > OPEN_MS) this.close();
    // The new device opens the code; the old one can only join an open one.
    const refuse =
      this.sides.has(side) ? "that code is in use" : side === "old" && !this.sides.has("new") ? "no device is showing that code" : "";
    if (refuse) {
      server.send(JSON.stringify({ t: "error", error: refuse }));
      server.close(4000, refuse);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (side === "new") {
      this.opened = now;
      setTimeout(() => this.close(), OPEN_MS);
    }
    this.sides.set(side, server);
    const other = (s: Side): Side => (s === "new" ? "old" : "new");
    server.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data || data.length > MAX_MESSAGE) return;
      this.sides.get(other(side))?.send(data);
    });
    const gone = () => {
      if (this.sides.get(side) !== server) return;
      this.sides.delete(side);
      const peer = this.sides.get(other(side));
      if (peer) {
        peer.send(JSON.stringify({ t: "gone" }));
        if (side === "new") this.close();
      }
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    if (side === "old") this.sides.get("new")?.send(JSON.stringify({ t: "joined" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private close(): void {
    for (const ws of this.sides.values()) {
      try {
        ws.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
    this.sides.clear();
    this.opened = 0;
  }
}
