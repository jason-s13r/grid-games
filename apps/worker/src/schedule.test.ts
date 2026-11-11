import { describe, expect, it } from "vitest";
import { durationRules } from "@tessera/sim";
import { configFrom } from "./create.js";
import { SERIES, configFor, joinMs, roomIdOf, scheduleCreator, slotsAt, wanted } from "./schedule.js";

const HOUR = 3_600_000;
const six = SERIES.find((s) => s.id === "6h")!;
const only6h = (list: ReturnType<typeof wanted>) => list.filter((w) => w.series === six).map((w) => w.slot);

describe("scheduled games", () => {
  it("open each one's lobby as the last one stops taking late joiners", () => {
    const j = joinMs(six);
    expect(j).toBe(2 * HOUR);
    const { startsAt } = slotsAt(six, 0);
    for (const slot of [5, 6, 7]) {
      const config = configFor(six, slot, startsAt(slot) - j);
      // Late joining closes J after the start, as the room computes it...
      const rules = durationRules(config.duration, config.joinShare);
      const closes = config.startAt! + (rules.joinWindow! / 12) * 1000;
      expect(closes).toBe(startsAt(slot) + j);
      // ...which is when the next slot's lobby opens.
      expect(slotsAt(six, closes).current).toBe(slot + 1);
      expect(startsAt(slot + 1) - closes).toBe(j);
    }
  });

  it("make the current slot's game before its start, and nothing once it exists", () => {
    const { startsAt } = slotsAt(six, 0);
    const lobby = startsAt(100) - HOUR;
    expect(only6h(wanted(lobby, () => false))).toEqual([100]);
    expect(only6h(wanted(lobby, (id) => id === roomIdOf(six, 100)))).toEqual([]);
  });

  it("leave a started game taking late joiners alone, and move on when it was called off", () => {
    const { startsAt } = slotsAt(six, 0);
    const lateJoining = startsAt(100) + HOUR;
    expect(only6h(wanted(lateJoining, (id) => id === roomIdOf(six, 100)))).toEqual([]);
    // Nobody picked an empire, so it was deleted at the start: the next one opens early.
    expect(only6h(wanted(lateJoining, () => false))).toEqual([101]);
    expect(only6h(wanted(lateJoining, (id) => id === roomIdOf(six, 101)))).toEqual([]);
  });

  it("are public, ownerless, start in the future and fit a room id", () => {
    const now = Date.UTC(2026, 10, 11, 7);
    for (const { series, slot } of wanted(now, () => false)) {
      const config = configFor(series, slot, now);
      expect(config.creator).toBe("");
      expect(config.public).toBe(true);
      expect(config.chat).toBe("open");
      expect(config.startAt!).toBeGreaterThan(now);
      expect(config.startAt! - now).toBeLessThanOrEqual(2 * joinMs(series));
      expect(config.roomId).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
    }
    expect(wanted(now, () => false).map((w) => w.series.id)).toEqual(["6h", "1d", "3d", "10d"]);
    // A valid request, as the create form's would be: bots and empires within the limits.
    for (const series of SERIES) {
      const config = configFor(series, 1, 0);
      expect(configFrom({ ...config, creator: "B".repeat(87), startAt: undefined, hours: series.hours, map: series.map }, config.roomId, 1, 0)).toEqual(
        expect.objectContaining({ bots: config.bots, empires: config.empires, duration: config.duration }),
      );
    }
  });

  it("belong to the key in SCHEDULE_CREATOR, or to nobody", () => {
    const key = "B".repeat(87);
    expect(scheduleCreator({ SCHEDULE_CREATOR: key })).toBe(key);
    expect(scheduleCreator({ SCHEDULE_CREATOR: ` ${key}\n` })).toBe(key);
    expect(scheduleCreator({ SCHEDULE_CREATOR: "me" })).toBe("");
    expect(scheduleCreator({})).toBe("");
    expect(configFor(six, 1, 0, key).creator).toBe(key);
  });
});
