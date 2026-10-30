// The connection to a game room, and everything about keeping it open.
//
// One WebSocket to /game/<id>/ws on the page's own origin. When it drops, it is
// opened again with a growing delay, and the RoomClient keeps its game across
// the gap: the room's hello on the new socket sends only what was missed.

import type { Identity } from "@tessera/protocol";
import { RoomClient } from "@tessera/room";

export type LinkState = "connecting" | "open" | "retrying" | "closed";

export interface RoomLinkOptions {
  roomId: string;
  identity: Identity;
  name: string;
  onState?: (state: LinkState) => void;
}

const BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

export class RoomLink {
  readonly client: RoomClient;
  private socket: WebSocket | undefined;
  private attempts = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** Hidden tabs get no animation frames, so the game would stop advancing,
   *  and stop sending the hash reports that keep a seat present. A slow timer
   *  keeps both going; browsers throttle it, which is fine for this. */
  private readonly background = setInterval(() => this.client.advance(), 1000);

  constructor(private readonly options: RoomLinkOptions) {
    this.client = new RoomClient({
      identity: options.identity,
      roomId: options.roomId,
      name: options.name,
      send: () => {},
    });
  }

  /** Open the socket. Separate from construction so callers can wire the
   *  client's handlers first. */
  connect(): void {
    this.open();
  }

  get roomId(): string {
    return this.options.roomId;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.background);
    clearTimeout(this.retry);
    this.socket?.close();
    this.options.onState?.("closed");
  }

  private open(): void {
    if (this.closed) return;
    this.options.onState?.(this.attempts ? "retrying" : "connecting");
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/game/${this.options.roomId}/ws`);
    this.socket = socket;

    this.client.reconnected((text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    });
    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.options.onState?.("open");
    });
    socket.addEventListener("message", (event) => {
      void this.client.receive(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.closed) return;
      const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
      this.attempts++;
      this.options.onState?.("retrying");
      this.retry = setTimeout(() => this.open(), delay);
    });
  }
}

/** The room id in a link, a path, or on its own. */
export function roomIdFrom(input: string): string | null {
  const text = input.trim();
  const match = text.match(/(?:^|\/g\/)([A-Za-z0-9_-]{4,64})\/?$/);
  return match ? match[1]! : null;
}

export interface CreateGame {
  creator: string;
  empires: number;
  seatsPerEmpire: number;
  bots: unknown[];
  map: "small" | "medium" | "large" | "huge" | "vast";
  hours: number;
  startAt?: number;
  public?: boolean;
}

/** Ask the Worker for a new room. Returns its id, or throws with the reason. */
export async function createGame(request: CreateGame): Promise<string> {
  const response = await fetch("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!response.ok || !body.id) throw new Error(body.error ?? `the server said ${response.status}`);
  return body.id;
}
