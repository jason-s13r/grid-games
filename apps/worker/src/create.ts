// Turning a create-game request into a room configuration.
//
// Everything a request says is checked here, because a room's configuration is
// fixed for its life and the room trusts it. The creator's key is taken as
// given: it only matters once somebody proves they hold it, which the room
// asks for before letting anybody start the game.

import { DIFFICULTY, MAX_DURATION, MAX_EMPIRES, STEPS_PER_SECOND, checkProfile } from "@tessera/sim";
import type { BotChoice } from "@tessera/sim";
import type { RoomConfig } from "@tessera/room";

export const MAP_SIZES = {
  small: { width: 96, height: 72 },
  medium: { width: 160, height: 112 },
  large: { width: 256, height: 176 },
  // From sim v5, whose maps scale their mountains, lakes and rivers with the
  // size. The vast map's snapshot is about 1.3 MB, inside a Durable Object's
  // 2 MB limit on one stored value.
  huge: { width: 384, height: 256 },
  vast: { width: 512, height: 352 },
} as const;

export interface CreateRequest {
  creator: string;
  empires?: number;
  seatsPerEmpire?: number;
  bots?: BotChoice[];
  map?: keyof typeof MAP_SIZES;
  /** Game length in hours. Absent means the Worker's default. */
  hours?: number;
  joinShare?: number;
  /** Start on its own at this time, ms since the epoch. */
  startAt?: number;
  /** Show it in the public list of games. */
  public?: boolean;
  /** Who may chat. Absent: open, or team only for a public game. */
  chat?: "open" | "team" | "off";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ROOM_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** A short, unambiguous room id: what goes in the link. */
export function newRoomId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

const isInt = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** A room configuration, or the reason the request cannot be one. */
export function configFrom(
  body: unknown,
  roomId: string,
  defaultHours: number,
  now: number,
): RoomConfig | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const request = body as CreateRequest;

  if (typeof request.creator !== "string" || !/^[A-Za-z0-9_-]{40,200}$/.test(request.creator)) {
    return "creator must be a public key";
  }

  const bots = request.bots ?? ["steady"];
  if (!Array.isArray(bots) || bots.length > MAX_EMPIRES) return "bots must be a short list";
  for (const bot of bots) {
    if (typeof bot === "string") {
      if (!(bot in DIFFICULTY)) return `unknown bot difficulty: ${bot}`;
    } else {
      const problem = checkProfile(bot);
      if (problem) return `bot profile: ${problem}`;
    }
  }

  const empires = request.empires ?? 2;
  if (!isInt(empires, 1, MAX_EMPIRES - bots.length)) {
    return `empires must be between 1 and ${MAX_EMPIRES - bots.length} alongside ${bots.length} bots`;
  }
  const seatsPerEmpire = request.seatsPerEmpire ?? 2;
  if (!isInt(seatsPerEmpire, 1, 4)) return "seatsPerEmpire must be between 1 and 4";

  if (request.chat !== undefined && !["open", "team", "off"].includes(request.chat)) {
    return "chat must be open, team or off";
  }

  const name = request.map ?? "medium";
  const map = Object.hasOwn(MAP_SIZES, name) ? MAP_SIZES[name] : undefined;
  if (!map) return `map must be one of ${Object.keys(MAP_SIZES).join(", ")}`;

  const hours = request.hours ?? defaultHours;
  const duration = Math.round(hours * 60 * 60 * STEPS_PER_SECOND);
  if (typeof hours !== "number" || !(duration > 0) || duration > MAX_DURATION) {
    return `hours must be positive and at most ${MAX_DURATION / STEPS_PER_SECOND / 3600}`;
  }

  const joinShare = request.joinShare ?? 1 / 3;
  if (typeof joinShare !== "number" || !(joinShare >= 0 && joinShare <= 1)) {
    return "joinShare must be between 0 and 1";
  }

  if (request.startAt !== undefined) {
    if (!isInt(request.startAt, now, now + 30 * DAY_MS)) {
      return "startAt must be within the next 30 days";
    }
  }

  return {
    roomId,
    creator: request.creator,
    empires,
    seatsPerEmpire,
    bots,
    map: { ...map },
    duration,
    joinShare,
    ...(request.startAt !== undefined ? { startAt: request.startAt } : {}),
    public: request.public === true,
    chat: request.chat ?? (request.public === true ? "team" : "open"),
    createdAt: now,
  };
}
