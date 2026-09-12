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

1. `parseRef(options.ref)` — a bad room fails here, before anything connects;
2. `installWebRTC()`, **for an rtc ref only**. This is the only place in the
   repository that loads a native module, and node-datachannel is the one
   genuinely unpleasant dependency here — prebuilt binaries per platform, where
   everything else is portable TypeScript — so a socket-only peer skipping it is
   the difference between an install that works on a small VPS and one that does
   not. `shutdownWebRTC()` needs no guard: it returns early when nothing was
   installed;
3. `Lobby.open(identity, ref, { iceServers?, id? })` — `JOIN_TIMEOUT_MS = 45000`
   (longer than the client's 15 s; a daemon would rather retry a slow host);
4. build a [`Lockstep`](../continuity/lockstep.md);
5. `options.onDriver(driver, genesis, seat)` **before** `driver.start()` — the
   only moment an [archive](../trust-and-verification/archive-format.md) can
   attach without missing a step;
6. `setInterval(() => driver.pump(), 1000 / STEPS_PER_SECOND)`.

The timer is **deliberately not `unref`'d** — it is what keeps the process alive,
so `stop()` (clearInterval + `driver.stop()` + `lobby.close()` +
`shutdownWebRTC()`) is the whole of stopping the program. `JoinOptions.ref` is the
room — a code or a link — and `JoinOptions.id` claims a stable peer id so a game
whose original host went home is reachable at this one.

## hostGame

[`hostGame(options)`](../../packages/headless/src/peer.ts) is `joinGame`'s sibling
and most of it is the same function: after the genesis record exists, a host is an
ordinary peer, so both end in the same driver, the same pump timer and the same
handle.

What differs is the front:

1. the lobby is opened with `hosting: true`, so nothing waits for a genesis to
   arrive and the joiner's watchdog is never armed — a socket host joins its own
   room, where there is nobody else by definition;
2. `compose(players)` is asked on every change and returns a plan or **null** for
   "not yet". Its plan must list the host's own key under `watching`, or
   `checkPlan` refuses it as "somebody here has no seat";
3. `onRefused` reports a plan `checkPlan` would not take. Composing again would be
   refused again — the reasons are structural — so a caller should say so and stop
   rather than loop;
4. `connect` lets a host that is also the relay attach [in process](../mesh/room-bus.md)
   rather than dialling itself.

## FileArchive

[`FileArchive`](../../packages/headless/src/store.ts#L61) wraps `net`'s
[`Archive`](../trust-and-verification/archive-format.md) with `retain: false` and
writes the append-only directory layout described in
[archive-format.md](../trust-and-verification/archive-format.md).
`readArchive` / `readSnapshots` read it back.
[`store.test.ts`](../../packages/headless/src/test/store.test.ts): "a game reads
back as the game that was played; survives the half-written line a crash leaves;
a late-join archive says so".
