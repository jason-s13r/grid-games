// The map as the listings carry it comes back out exactly as it went in.

import { describe, expect, it } from "vitest";
import { encodeMap } from "./records.js";
import type { ListedMap } from "./records.js";

describe("a listed map", () => {
  it("round-trips through deflate and base64", async () => {
    const cells = new Uint8Array(96 * 64).map((_, i) => (i % 7 === 0 ? 3 : i % 11 === 0 ? 241 : 0));
    const listed = JSON.parse(
      await encodeMap({ width: 96, height: 64, cells, banners: ["sping", "tide"], step: 1234 }),
    ) as ListedMap;
    expect([listed.w, listed.h, listed.b, listed.step]).toEqual([96, 64, ["sping", "tide"], 1234]);
    const bytes = Uint8Array.from(atob(listed.c), (c) => c.charCodeAt(0));
    expect(bytes.length).toBeLessThan(cells.length / 4);
    const back = new Uint8Array(
      await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
    );
    expect(back).toEqual(cells);
  });
});
