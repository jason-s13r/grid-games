# Headless peers

[`packages/headless`](../../packages/headless) is a peer with no page around it.
It is thinner than it looks, because everything below the
[lobby](../mesh/the-lobby.md) already ran under Node — that is what the
[test harness](../mesh/transport-interface.md) is. What was missing: a WebRTC
implementation, a key in a file, a pump on a timer, an archive on disk.

Consumed by [`apps/observer`](observer.md) and [`apps/bot`](bot.md).

## installWebRTC

PeerJS reaches for `RTCPeerConnection` as a global — no injection point. So
[`installWebRTC()`](../../packages/headless/src/webrtc.ts#L24) copies
`node-datachannel/polyfill`'s exports onto `globalThis` **before anything imports
peerjs**, and sets `globalThis.window ??= globalThis` (PeerJS reads
`window.RTCRtpTransceiver` while feature-detecting).

`node-datachannel` is **the only native dependency in the repository** — a
headless peer needs prebuilt binaries for its platform, where everything else is
portable TypeScript. The alternative is running a headless Chromium to hold a
data channel open for days.

[`shutdownWebRTC()`](../../packages/headless/src/webrtc.ts#L43) calls
libdatachannel's `cleanup()` — it keeps threads alive after the last connection
closes, so a process that merely stops using WebRTC does not exit; it sits there
having finished, which looks exactly like a hang.

## identityAt

[`identityAt(path)`](../../packages/headless/src/identity.ts#L18): load an
[`Identity`](../protocol/identity.md) from a JWK file, or mint one on first run
written at **mode `0600`** (a private key readable by every account on the box is
a seat anyone on the box can play). A corrupt file **throws** rather than being
replaced — overwriting it would silently abandon whatever seat that key held.

## joinGame

[`joinGame(options)`](../../packages/headless/src/peer.ts#L66) is the whole
"reloading tab" join path under Node:

1. `installWebRTC()`;
2. `Lobby.open(identity, code, { iceServers?, id? })` — `JOIN_TIMEOUT_MS = 45000`
   (longer than the client's 15 s; a daemon would rather retry a slow host);
3. build a [`Lockstep`](../continuity/lockstep.md);
4. `options.onDriver(driver, genesis, seat)` **before** `driver.start()` — the
   only moment an [archive](../trust-and-verification/archive-format.md) can
   attach without missing a step;
5. `setInterval(() => driver.pump(), 1000 / STEPS_PER_SECOND)`.

The timer is **deliberately not `unref`'d** — it is what keeps the process alive,
so `stop()` (clearInterval + `driver.stop()` + `lobby.close()` +
`shutdownWebRTC()`) is the whole of stopping the program. `JoinOptions.id` claims
a stable peer id so a game whose original host went home is reachable at this one.

## FileArchive

[`FileArchive`](../../packages/headless/src/store.ts#L61) wraps `net`'s
[`Archive`](../trust-and-verification/archive-format.md) with `retain: false` and
writes the append-only directory layout described in
[archive-format.md](../trust-and-verification/archive-format.md).
`readArchive` / `readSnapshots` read it back.
[`store.test.ts`](../../packages/headless/src/test/store.test.ts): "a game reads
back as the game that was played; survives the half-written line a crash leaves;
a late-join archive says so".
