// The one place a ref becomes a connection.
//
// Two transports, one switch, and it lives here rather than in the lobby so
// that the file which is supposed to know nothing about networks goes on
// knowing nothing. The lobby asks for a connection and gets one; which library
// opened it, and what its errors are called, stop at this boundary.

import { createMesh } from "./mesh.js";
import { RTC_PREFIX, formatRef } from "./ref.js";
import type { ConnectionRef } from "./ref.js";
import type { Transport } from "./transport.js";

/** A transport with a life: something the lobby opened, and must therefore be
 *  able to shut.
 *
 *  `Transport` stays four verbs and an id. Widening the interface that every
 *  driver, the hub and the whole test harness are written against, for the
 *  benefit of the two implementations the lobby happens to open, would be the
 *  wrong way round — a loopback switch and a hub port have nothing to close,
 *  and an optional `close?()` would put a `?.` at every call site to say so. */
export interface Connection extends Transport {
  close(): void;
}

export interface ConnectOptions {
  /** The id to claim rather than one assigned to us. A request on both
   *  transports and a right on neither: the broker refuses a taken id, and a
   *  room bus stamps `from` itself. */
  id?: string;
  /** WebRTC only; ignored for a socket ref. Replaces PeerJS's own relays rather
   *  than adding to them — the trap `mesh.ts` documents at length. */
  iceServers?: RTCIceServer[];
  onJoin?: (peer: string) => void;
  onLeave?: (peer: string) => void;
  onError?: (error: Error) => void;
}

/** Injectable so the lobby can be tested without a broker. The only reason the
 *  lobby takes an opener at all, and it costs four words in a signature. */
export type Opener = (
  ref: ConnectionRef | undefined,
  options: ConnectOptions,
) => Promise<Connection>;

/** Open the connection a ref names. `undefined` means "start a room here",
 *  which only WebRTC can do — over a socket the room bus creates a room on
 *  first join, so hosting is not a separate act. */
export const openConnection: Opener = async (ref, options = {}) => {
  if (ref?.kind === "socket") throw new Error("socket rooms are not built yet");

  return createMesh({
    ...(ref ? { join: ref.code } : {}),
    prefix: RTC_PREFIX,
    ...(options.iceServers ? { iceServers: options.iceServers } : {}),
    ...(options.id ? { id: options.id } : {}),
    onJoin: options.onJoin,
    onLeave: options.onLeave,
    onError: (error) => options.onError?.(translate(error, ref)),
  });
};

/** PeerJS tags its errors, and the two that matter to a player are being unable
 *  to reach the broker at all and naming a room that is not there. This lived
 *  in the lobby, which meant the one file that is supposed to know nothing
 *  about transports was reading a PeerJS discriminator. Every transport owes
 *  the lobby a sentence, not a tag. */
export function translate(error: Error, ref?: ConnectionRef): Error {
  const type = (error as Error & { type?: string }).type;
  const where = ref ? formatRef(ref) : "the broker";
  if (type === "peer-unavailable") {
    return new Error(`no game is running under ${where}.`);
  }
  if (type === "network" || type === "server-error") {
    return new Error("lost contact with the matchmaking broker.");
  }
  return error;
}
