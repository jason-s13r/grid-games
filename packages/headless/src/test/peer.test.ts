// What a headless peer does with a ref before it touches the network.
//
// Both of these are about the native module. node-datachannel is the one
// dependency here that is not portable TypeScript, and a socket-only deployment
// — a small VPS, a container with no prebuilt binary for its platform — has no
// use for it. So "a socket ref installs no WebRTC" is not a micro-optimisation
// to assert, it is the difference between an install that works there and one
// that does not.

import { describe, expect, it } from "vitest";
import { Identity } from "@tessera/protocol";
import { joinGame } from "../peer.js";

const globals = globalThis as unknown as Record<string, unknown>;

describe("joinGame", () => {
  it("refuses a string that was never a room, before connecting to anything", async () => {
    const identity = await Identity.generate();
    // Forgetting the `verify` subcommand used to dial a path as if it were a
    // peer id and wait 45 seconds for a broker that was never going to have it.
    await expect(joinGame({ ref: "./archives/abc", identity })).rejects.toThrow(/is not a room/);
  });

  it("takes a socket ref, and loads no native module on the way", async () => {
    const identity = await Identity.generate();

    // A relay that says go away the moment it is dialled, so the failure is the
    // relay's rather than a twelve-second timeout's. What is being asserted is
    // the branch above it: a socket peer never reaches installWebRTC.
    const previous = globals.WebSocket;
    globals.WebSocket = class {
      readyState = 1;
      onopen: ((event?: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event?: unknown) => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ op: "closed", reason: "not today." }) });
        }, 0);
      }
      send(): void {}
      close(): void {}
    };

    try {
      await expect(joinGame({ ref: "wss://relay.example/tessera/r", identity })).rejects.toThrow(
        /not today/,
      );
    } finally {
      globals.WebSocket = previous;
    }

    // The honest version of this assertion is that the suite runs with
    // node-datachannel absent and still passes; this is the cheap version, which
    // at least fails if `installWebRTC` creeps back above the branch.
    expect(globals.RTCPeerConnection).toBeUndefined();
  });
});
