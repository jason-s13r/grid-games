// What kind of connection a string names.
//
// The player types one thing and it decides everything: a peer id is a WebRTC
// mesh introduced by a broker, a wss:// URL is a room on a relay. There is no
// settings screen, no probe and no fallback ladder, because a transport nobody
// chose is a transport nobody can debug — and the two failure modes it would be
// hiding (symmetric NAT, an unreachable relay) look identical from inside a
// ladder and completely different from outside one.
//
// A ref is an address and nothing more. It says where to go, never what will be
// found there or whether it can be believed: the genesis record answers the
// first question and every signature answers the second.

/** The characters a room name may use, on either transport.
 *
 *  One charset for both is what lets a listing offer the same room under two
 *  refs. It is also why formatRef is a concatenation rather than an escaping
 *  problem: every legal name is already a safe URL path segment. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The prefix `openConnection` mints room codes under. Refs are not required to
 *  carry it — an `--as nightwatch` peer is dialled at `nightwatch` — but a code
 *  this build handed out always will. */
export const RTC_PREFIX = "tsr-";

export type ConnectionRef =
  | { kind: "socket"; url: string; room: string }
  | { kind: "rtc"; code: string };

const EXPECTED =
  'a room code like "tsr-abc234", or a room link like ' +
  '"wss://relay.example/tessera/abc234"';

export function parseRef(input: string): ConnectionRef {
  const text = input.trim();
  if (!text) throw new Error(`nothing to join — expected ${EXPECTED}`);
  if (/^wss?:\/\//i.test(text)) return socketRef(text);

  // Not a URL, so it is a peer id. Deliberately not a `tsr-` check: an observer
  // started with `--as nightwatch` is dialled at `nightwatch`, and the address
  // book will hand out ids minted by peers this build never saw. The prefix is
  // a minting convention, not a wire format, and treating it as one would break
  // the durable peer that is the whole reason `--as` exists.
  if (!NAME.test(text)) {
    throw new Error(`"${text}" is not a room — expected ${EXPECTED}`);
  }
  return { kind: "rtc", code: text };
}

function socketRef(text: string): ConnectionRef {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${text}" is not a URL — expected ${EXPECTED}`);
  }
  // Refused rather than dropped: a ref has to survive being printed and typed
  // back in, and anything formatRef cannot reproduce would silently become a
  // different ref on the round trip.
  if (url.search || url.hash) {
    throw new Error("a room link carries no query or fragment");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const room = parts.pop();
  if (!room) throw new Error(`"${text}" names a server but no room`);
  if (!NAME.test(room)) throw new Error(`"${room}" is not a room name`);

  const path = parts.length > 0 ? `/${parts.join("/")}` : "";
  return { kind: "socket", url: `${url.protocol}//${url.host}${path}`, room };
}

/** The exact inverse. Everything that prints a ref — the panel's share line, a
 *  CLI's "joining …", the address book — goes through here, so "parse then
 *  format is the identity" is one property to test rather than four
 *  hand-written strings to keep in step with each other. */
export function formatRef(ref: ConnectionRef): string {
  return ref.kind === "rtc" ? ref.code : `${ref.url}/${ref.room}`;
}

/** Whether a string is a room name this build would mint or route. Exported for
 *  the CLIs, which warn rather than fail: an id outside the charset can be
 *  claimed at the broker and then never typed back into a join box. */
export function isRoomName(text: string): boolean {
  return NAME.test(text);
}
