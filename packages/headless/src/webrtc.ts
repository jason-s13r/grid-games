// WebRTC, where there is no browser to provide it.
//
// PeerJS reaches for `RTCPeerConnection` as a global and nothing else — it has
// no injection point, no options hook, no way to be handed an implementation.
// So the implementation has to be put where it looks, before it looks, which is
// what this does and why it must be called before anything imports peerjs.
//
// node-datachannel is libdatachannel with a WebRTC-shaped face on it. It is a
// native module, which is the one genuinely unpleasant dependency in this
// repository: a headless peer needs prebuilt binaries for its platform, where
// everything else here is portable TypeScript. The alternative is running a
// headless Chromium to hold a data channel open for three days, which is worse
// in every way that matters.
//
// `window` is set to globalThis for the same reason. PeerJS reads
// `window.RTCRtpTransceiver` while deciding whether the browser it is running
// in supports unified plan — a question with no meaning here, and one that
// throws rather than answering false when there is no window at all.

let installed = false;

/** Put a WebRTC implementation where PeerJS will find it. Idempotent, because
 *  an observer and a bot in one process would otherwise each install it. */
export async function installWebRTC(): Promise<void> {
  if (installed) return;
  installed = true;

  const polyfill = (await import("node-datachannel/polyfill")) as unknown as Record<
    string,
    unknown
  >;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(polyfill)) {
    if (name === "default" || name in globals) continue;
    globals[name] = value;
  }
  globals.window ??= globalThis;
}

/** Release the native side. Node keeps libdatachannel's threads alive after the
 *  last connection closes, so a process that merely stops using WebRTC does not
 *  exit — it sits there having finished, which looks exactly like a hang. */
export async function shutdownWebRTC(): Promise<void> {
  if (!installed) return;
  const module = (await import("node-datachannel")) as unknown as {
    cleanup?: () => void;
    default?: { cleanup?: () => void };
  };
  (module.cleanup ?? module.default?.cleanup)?.();
}
