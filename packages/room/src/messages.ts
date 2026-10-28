// What a client and a room say to each other.
//
// JSON over one socket. Nothing here is signed as a frame: the records inside
// that need to be believed (moves, the hello proof) carry their own signatures,
// and the rest is the room telling a client what it decided.

import type { BotChoice, Genesis, Move, MoveType } from "@tessera/sim";
import type { SignedInvite } from "@tessera/protocol";

/** A move as it sits in the log: stamped with its step by the room, and signed
 *  by the seat that made it. Moves the room makes itself (heartbeats for
 *  connected seats) carry no signature. */
export interface Stamped {
  move: Move;
  sig?: string;
}

/** What a player chooses before the game starts. Everything else about the
 *  world comes from the room's configuration. */
export interface LobbyPlayer {
  key: string;
  name: string;
  /** Index into the human empires, or null while undecided. */
  empire: number | null;
  connected: boolean;
}

export interface LobbyView {
  creator: string;
  empires: number;
  seatsPerEmpire: number;
  bots: number;
  players: LobbyPlayer[];
  /** When the room will start on its own, ms since the epoch. */
  startsAt?: number;
}

export interface SnapshotWire {
  step: number;
  hash: number;
  /** The snapshot bytes, base64url. */
  data: string;
}

/** Everything a client needs to be at the room's current step. */
export interface Catchup {
  genesis: Genesis;
  /** Absent when the client's own state is a valid starting point. */
  snapshot?: SnapshotWire;
  /** Every logged move from the snapshot's step (or the client's), including
   *  moves stamped for steps the room has not simulated yet. */
  tail: Stamped[];
  /** The room's own simulation step; informational. */
  upTo: number;
  /** The room's clock, ms since the epoch, for the client to set its own by. */
  now: number;
}

export interface You {
  key: string;
  /** Present once the game has started and this key holds a seat. */
  seat?: { empire: number; member: number };
  /** The next `seq` the room will accept from this key. A reloaded tab has
   *  forgotten its own count, and a reused number is refused. */
  nextSeq: number;
}

export type Phase = "lobby" | "playing";

/** Somebody in a running game, seated or watching. */
export interface Person {
  key: string;
  name: string;
  connected: boolean;
  seat?: { empire: number; member: number };
}

/** Somebody asking an empire for a seat. Any member of that empire may answer. */
export interface SeatRequest {
  key: string;
  name: string;
  empire: number;
}

/** One line of chat. `team` lines go only to the speaker's empire. */
export interface ChatLine {
  key: string;
  name: string;
  /** The speaker's empire, or 0 for somebody without a seat. */
  empire: number;
  channel: "all" | "team";
  text: string;
  /** The room's clock, ms since the epoch. */
  at: number;
}

export interface People {
  people: Person[];
  requests: SeatRequest[];
}

export type ServerMessage =
  | { t: "challenge"; nonce: string }
  | { t: "welcome"; phase: Phase; you: You; lobby?: LobbyView; game?: Catchup }
  | { t: "lobby"; lobby: LobbyView }
  | { t: "start"; genesis: Genesis; you: You; now: number }
  /** Moves just stamped, and the room's clock when it stamped them. */
  | { t: "moves"; moves: Stamped[]; now: number }
  | { t: "resync"; game: Catchup }
  | { t: "seated"; you: You }
  | { t: "people"; people: People }
  /** Lines of chat: the recent history on joining, then each as it is said. */
  | { t: "chat"; lines: ChatLine[] }
  | { t: "error"; message: string };

export type ClientMessage =
  | {
      t: "hello";
      key: string;
      nonce: string;
      proof: string;
      name?: string;
      /** Where this client already is, if it has a game in memory. */
      have?: { step: number; hash: number };
    }
  | { t: "lobby"; name?: string; empire?: number | null }
  | { t: "start" }
  | { t: "move"; move: { seq: number; type: MoveType; x: number; y: number }; sig: string }
  | { t: "hash"; step: number; hash: number }
  | { t: "resume"; have?: { step: number; hash: number } }
  /** Take an empire nobody holds. */
  | { t: "claim"; empire: number }
  /** Ask an empire for a seat. */
  | { t: "ask"; empire: number }
  | { t: "withdraw" }
  /** A member of an empire answering somebody's request. */
  | { t: "approve"; key: string }
  | { t: "decline"; key: string }
  /** Join through an invite a member signed. */
  | { t: "redeem"; invite: SignedInvite }
  | { t: "name"; name: string }
  | { t: "say"; channel: "all" | "team"; text: string };

/** How a room is set up when it is created. Fixed for the room's life. */
export interface RoomConfig {
  /** The room's own id: the address it is reached at, and what hello proofs
   *  are bound to. Not the genesis game id, which does not exist until the
   *  game starts. */
  roomId: string;
  /** The key allowed to start the game by hand. */
  creator: string;
  /** Human empires on the map. Those nobody picks are left open. */
  empires: number;
  seatsPerEmpire: number;
  bots: BotChoice[];
  map: { width: number; height: number };
  /** Game length in steps. */
  duration: number;
  /** Share of the game that late joiners may still arrive in. */
  joinShare?: number;
  /** Start on its own at this time, ms since the epoch. */
  startAt?: number;
}

const MAX_MESSAGE = 4 * 1024 * 1024;

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Null for anything that is not a well-formed message object. A peer may send
 *  anything, and none of it should throw on the receiving side. */
export function decode<T extends { t: string }>(text: unknown): T | null {
  if (typeof text !== "string" || text.length > MAX_MESSAGE) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || typeof (value as { t?: unknown }).t !== "string") {
      return null;
    }
    return value as T;
  } catch {
    return null;
  }
}
