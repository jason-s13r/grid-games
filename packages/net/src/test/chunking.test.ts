// A channel with a ceiling.
//
// PeerJS refuses an oversized JSON message outright: it raises on the *sender*
// and the frame simply never leaves. Its ceiling is chunkedMTU, 16300 bytes,
// and a snapshot of a real map is an order of magnitude past it — so PeerMesh
// cuts a large frame into slices and puts it back together on the far side.
//
// The loopback network has no ceiling and so exercises none of that, which is
// how a reassembly bug reached a browser: the slices all arrived, and the frame
// was rebuilt from the first of them alone. This fake is the smallest thing
// that has the property the loopback lacks.

import { beforeAll, describe, expect, it } from "vitest";
import { FRAME } from "@tessera/protocol";
import type { Frame } from "@tessera/protocol";
import { PeerMesh } from "../index.js";
import type { PeerConstructor } from "../index.js";
import { FakePeer } from "./fakepeer.js";
import { settle } from "./harness.js";

describe("a frame larger than the channel", () => {
  // Ten times the ceiling, and every byte positioned, so a frame rebuilt out of
  // order or from a subset of its slices cannot happen to compare equal.
  const data = Array.from({ length: 168_000 }, (_, i) => "abcdefgh"[i % 8]!).join("");

  let heard: Frame[];
  let errors: string[];

  beforeAll(async () => {
    FakePeer.all.clear();
    errors = [];
    heard = [];

    const PeerClass = FakePeer as unknown as PeerConstructor;
    const host = new PeerMesh(PeerClass, { onError: (e) => errors.push(e.message) });
    await host.opening;
    const guest = new PeerMesh(PeerClass, {
      join: host.id,
      onError: (e) => errors.push(e.message),
    });
    await guest.opening;
    await settle(4);

    guest.listen((_from, frame) => heard.push(frame));

    host.broadcast({ t: FRAME.BYE, reason: "small" });
    await settle(4);
    host.broadcast({ t: FRAME.SNAPSHOT, step: 172, hash: 42, data });
    await settle(8);

    host.close();
    guest.close();
  });

  it("a small frame arrives unsliced", () => expect(heard[0]?.t).toBe(FRAME.BYE));

  it("the large frame arrives too", () => expect(heard).toHaveLength(2));

  it("as one snapshot, not a truncated one", () => {
    const arrived = heard[1];
    expect(arrived?.t).toBe(FRAME.SNAPSHOT);
    expect(arrived?.t === FRAME.SNAPSHOT ? arrived.data : "").toBe(data);
  });

  it("and the sender never had a message refused", () => expect(errors).toEqual([]));
});
