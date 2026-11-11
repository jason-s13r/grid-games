// The map over time: recorded on a steady pace however the room is woken, and
// decoded back to exactly the map each frame was taken from.

import { beforeAll, describe, expect, it } from "vitest";
import { STEPS_PER_SECOND, Sim } from "@tessera/sim";
import type { Identity } from "@tessera/protocol";
import { KEY_EVERY, decodeFrame, encodeFrame, frameEvery, isKeyFrame, timelineOf } from "../frames.js";
import type { StoredFrame } from "../frames.js";
import { FRAME_WIDTH } from "../frames.js";
import { thumbnail } from "../thumb.js";
import { Harness, identities } from "./harness.js";

let alice: Identity;

beforeAll(async () => {
  [alice] = (await identities(1)) as [Identity];
});

describe("a frame", () => {
  it("round-trips as a key frame and as a delta", () => {
    const a = new Uint8Array(5000).map((_, i) => (i < 1200 ? 0 : i < 3000 ? 2 : 241));
    const b = a.slice();
    b.fill(3, 400, 450);
    b[4999] = 7;
    const key = encodeFrame(a);
    const delta = encodeFrame(b, a);
    expect(isKeyFrame(key)).toBe(true);
    expect(isKeyFrame(delta)).toBe(false);
    expect(decodeFrame(key, a.length)).toEqual(a);
    expect(decodeFrame(delta, b.length, a)).toEqual(b);
    // A few changes cost a few bytes.
    expect(delta.length).toBeLessThan(20);
  });
});

/** Every frame's cells, in order, following the chain of deltas. */
function decodeAll(frames: StoredFrame[], size: number): Array<{ step: number; cells: Uint8Array }> {
  let previous: Uint8Array | undefined;
  return frames.map((frame) => {
    previous = decodeFrame(frame.bytes, size, previous);
    return { step: frame.step, cells: previous };
  });
}

async function running(duration: number) {
  const h = new Harness({ creator: alice.key, bots: ["steady"], duration });
  const a = await h.join(alice);
  a.client.pickBanner("sping");
  await h.settle();
  a.client.start();
  await h.settle();
  return { h, a };
}

describe("the room's timeline", () => {
  it("records a frame on every beat, connected or not, each the map at its step", async () => {
    // Two hours long, so a frame every 2 * 3600 * 12 / 4000 = 21.6 → 22 steps.
    const duration = 2 * 3600 * STEPS_PER_SECOND;
    const { h, a } = await running(duration);
    const genesis = a.client.genesis!;
    const every = frameEvery(genesis);
    expect(every).toBe(22);

    await h.run(60_000, 1_000); // a minute with somebody there
    a.drop();
    h.clock.advance(20 * 60_000); // twenty minutes with nobody
    await h.room.tick();

    const frames = h.store.frames();
    const steps = frames.map((f) => f.step);
    expect(steps[0]).toBe(0);
    for (let i = 1; i < steps.length; i++) expect(steps[i]! - steps[i - 1]!).toBe(every);
    expect(steps.at(-1)!).toBeGreaterThanOrEqual(21 * 60 * STEPS_PER_SECOND - every);
    expect(frames.filter((f) => isKeyFrame(f.bytes)).length).toBe(Math.ceil(frames.length / KEY_EVERY));

    // Each frame is the map at its step, replayed from the record.
    const sim = new Sim(genesis);
    const log = h.store.movesFrom(0).map((s) => s.move);
    const size = thumbnail(sim.state, [], 0, FRAME_WIDTH);
    const decoded = decodeAll(frames, size.width * size.height);
    for (const frame of decoded.filter((_, i) => i % 37 === 0 || i === decoded.length - 1)) {
      while (sim.step < frame.step) sim.advance(log.filter((m) => m.step === sim.step));
      expect(frame.cells).toEqual(thumbnail(sim.state, [], sim.step, FRAME_WIDTH).cells);
    }
  });

  it("keeps the chain whole across a rebuild, and goes into the archive at the end", async () => {
    const duration = 20 * 60 * STEPS_PER_SECOND;
    const { h, a } = await running(duration);
    await h.run(3 * 60_000, 1_000);
    a.drop();
    h.restart();
    h.clock.advance(30 * 60_000);
    await h.room.tick();
    await h.room.tick();
    expect(h.room.ended).toBe(true);

    const archive = h.room.archive()!;
    const timeline = archive.timeline!;
    expect(timeline.every).toBe(frameEvery(archive.genesis));
    expect(timeline.banners[0]).toBe("sping");
    expect(timeline.frames.at(-1)![0]).toBe(archive.steps);
    const size = timeline.width * timeline.height;
    // Decodes start to finish: every delta has the frame it was made against.
    const frames = h.store.frames();
    const decoded = decodeAll(frames, size);
    const sim = new Sim(archive.genesis);
    const log = archive.moveLog.map((s) => s.move);
    while (sim.step < archive.steps && !sim.ended) sim.advance(log.filter((m) => m.step === sim.step));
    expect(decoded.at(-1)!.cells).toEqual(thumbnail(sim.state, [], sim.step, FRAME_WIDTH).cells);
  });

  it("is made again from the archive alone, frame for frame", async () => {
    // What a game archived before rooms kept timelines is given, so it can be
    // watched once its sim is retired.
    const duration = 20 * 60 * STEPS_PER_SECOND;
    const { h, a } = await running(duration);
    await h.run(3 * 60_000, 1_000);
    a.drop();
    h.clock.advance(30 * 60_000);
    await h.room.tick();
    await h.room.tick();
    const archive = h.room.archive()!;
    const { timeline, ...without } = archive;
    expect(timelineOf(without)).toEqual(timeline);
  });
});
