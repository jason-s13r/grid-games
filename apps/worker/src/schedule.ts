// Scheduled public games: one of each length is always open to sign up for.
//
// Each series runs on a fixed grid. With `J` the late-join window (a third of
// the game, as for any game), game k starts at `k * 2J` and takes late joiners
// until `k * 2J + J`, which is exactly when game k + 1 opens its lobby, `J`
// before its own start. So at any moment one game of each length is either
// in its lobby or still taking late joiners, and the next one appears the
// moment the last one shuts its door. For six hours: a lobby for two hours,
// two hours of late joining, four more of play, and a new game every four.
//
// Nothing runs on a timer. The open list makes sure each series has its
// current game whenever somebody looks, which is the only time anybody can
// sign up anyway. Room ids come from the series and the slot, so two lists
// asked for at once make the same room, and the second `init` is refused.
//
// The rooms have no creator unless the dashboard names one (SCHEDULE_CREATOR,
// a player's key): without one, nobody can start one early or change its
// settings, and it starts itself on time. One nobody picked an empire in by
// then is deleted like any other, and the list moves on to the next slot.

import { STEPS_PER_SECOND } from "@tessera/sim";
import type { BotChoice } from "@tessera/sim";
import type { RoomConfig } from "@tessera/room";
import { MAP_SIZES } from "./create.js";
import type { Env } from "./env.js";

export interface Series {
  /** Leads each room id, so the series and slot can be read off it. */
  id: string;
  hours: number;
  map: keyof typeof MAP_SIZES;
  empires: number;
  seatsPerEmpire: number;
  bots: BotChoice[];
}

// One bot of each difficulty: the shorter games an easy and a steady one, the
// longer ones a hard one as well.
export const SERIES: readonly Series[] = [
  { id: "6h", hours: 6, map: "medium", empires: 6, seatsPerEmpire: 2, bots: ["easy", "steady"] },
  { id: "1d", hours: 24, map: "large", empires: 6, seatsPerEmpire: 2, bots: ["easy", "steady"] },
  { id: "3d", hours: 72, map: "large", empires: 8, seatsPerEmpire: 2, bots: ["easy", "steady", "hard"] },
  { id: "10d", hours: 240, map: "huge", empires: 8, seatsPerEmpire: 3, bots: ["easy", "steady", "hard"] },
];

/** The share of a game late joiners may arrive in: the same as any game's. */
const JOIN_SHARE = 1 / 3;
const HOUR_MS = 3_600_000;

/** The late-join window, ms. */
export const joinMs = (series: Series): number => series.hours * HOUR_MS * JOIN_SHARE;

export const roomIdOf = (series: Series, slot: number): string => `${series.id}-${slot.toString(36)}`;

/** The slot whose lobby or late joining is open at `now`. The grid's slot is
 *  open from `J` before its start to `J` after; once it has started, the next
 *  slot is the one to make if this one has no game (nobody came, so it was
 *  deleted at its start), so that something is always open. */
export function slotsAt(series: Series, now: number): { current: number; next: number; startsAt: (slot: number) => number } {
  const j = joinMs(series);
  const period = 2 * j;
  const current = Math.floor((now + j) / period);
  return { current, next: current + 1, startsAt: (slot) => slot * period };
}

/** The owner of scheduled games: SCHEDULE_CREATOR if it is a key, else
 *  nobody (no key is the empty string). */
export function scheduleCreator(env: Pick<Env, "SCHEDULE_CREATOR">): string {
  const key = (env.SCHEDULE_CREATOR ?? "").trim();
  return /^[A-Za-z0-9_-]{40,200}$/.test(key) ? key : "";
}

export function configFor(series: Series, slot: number, now: number, creator = ""): RoomConfig {
  const { startsAt } = slotsAt(series, now);
  return {
    roomId: roomIdOf(series, slot),
    creator,
    empires: series.empires,
    seatsPerEmpire: series.seatsPerEmpire,
    bots: series.bots,
    map: { ...MAP_SIZES[series.map] },
    duration: Math.round(series.hours * 3600 * STEPS_PER_SECOND),
    joinShare: JOIN_SHARE,
    startAt: startsAt(slot),
    public: true,
    // Everybody, to all or to their own team.
    chat: "open",
    createdAt: now,
  };
}

/** The room each series wants at `now`, and whether it must be made. A slot
 *  still before its start is wanted; one already started is wanted only if
 *  its game is still taking people, and otherwise the next slot is. */
export function wanted(now: number, exists: (id: string) => boolean): Array<{ series: Series; slot: number }> {
  return SERIES.flatMap((series) => {
    const { current, next, startsAt } = slotsAt(series, now);
    if (now < startsAt(current)) return exists(roomIdOf(series, current)) ? [] : [{ series, slot: current }];
    if (exists(roomIdOf(series, current))) return [];
    return exists(roomIdOf(series, next)) ? [] : [{ series, slot: next }];
  });
}

/** Make whatever scheduled games are missing. Cheap when none are: one D1
 *  read. */
export async function ensureScheduled(env: Env, now: number): Promise<void> {
  if (!env.DB) return;
  const ids = SERIES.flatMap((series) => {
    const { current, next } = slotsAt(series, now);
    return [roomIdOf(series, current), roomIdOf(series, next)];
  });
  const { results } = await env.DB
    .prepare(`SELECT id FROM games WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...ids)
    .all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  const creator = scheduleCreator(env);
  await Promise.all(
    wanted(now, (id) => known.has(id)).map(({ series, slot }) =>
      env.GAMES.get(env.GAMES.idFromName(roomIdOf(series, slot)))
        .init(configFor(series, slot, now, creator))
        .catch((error: unknown) => console.error("scheduled game failed", series.id, error)),
    ),
  );
}
