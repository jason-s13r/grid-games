// What we hand PeerJS about relays, and — mostly — what we do not.
//
// PeerJS ships a STUN server and two TURN relays and uses them unless it is
// given a `config` of its own. That option is merged one level deep, so a
// config is not an addition to the defaults but a replacement for them: the
// moment this package passed one containing a single STUN entry, the relays
// went away. Everything kept working for anyone whose NAT did not need one,
// which is most people most of the time, and the ~20% of pairs that did need
// one simply never connected.
//
// So the property under test is an absence, and an absence is exactly the kind
// of thing that comes back.

import { beforeEach, describe, expect, it } from "vitest";
import { PeerMesh } from "../index.js";
import type { PeerConstructor } from "../index.js";
import { FakePeer } from "./fakepeer.js";

const PeerClass = FakePeer as unknown as PeerConstructor;

/** The PeerMesh constructor hands its options straight to the Peer, so the
 *  mesh does not have to be open to read them back. */
const built = (mesh: PeerMesh): FakePeer => mesh.peer as unknown as FakePeer;

describe("the relays PeerJS ships with", () => {
  beforeEach(() => FakePeer.all.clear());

  it("are left in place when nobody asks otherwise", () => {
    expect(built(new PeerMesh(PeerClass)).options?.config).toBeUndefined();
  });

  it("including for a joiner", () => {
    const host = new PeerMesh(PeerClass);
    const guest = new PeerMesh(PeerClass, { join: host.id });
    expect(built(guest).options?.config).toBeUndefined();
  });

  // Other peerOptions are not a statement about ICE and must not become one.
  it("and are not disturbed by an unrelated option", () => {
    const mesh = new PeerMesh(PeerClass, { peerOptions: { debug: 2 } });
    expect(built(mesh).options?.config).toBeUndefined();
  });
});

describe("a relay of your own", () => {
  beforeEach(() => FakePeer.all.clear());

  const coturn: RTCIceServer[] = [
    { urls: "turn:relay.example:3478", username: "u", credential: "p" },
  ];

  it("replaces them when you pass one", () => {
    const mesh = new PeerMesh(PeerClass, { iceServers: coturn });
    expect(built(mesh).options?.config?.iceServers).toEqual(coturn);
  });

  it("and an explicit peerOptions config still wins outright", () => {
    const direct: RTCConfiguration = { iceServers: [{ urls: "stun:stun.example:3478" }] };
    const mesh = new PeerMesh(PeerClass, { iceServers: coturn, peerOptions: { config: direct } });
    expect(built(mesh).options?.config?.iceServers).toEqual(direct.iceServers);
  });
});
