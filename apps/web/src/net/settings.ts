// The handful of strings this client keeps, and the cupboard they go in.
//
// The same cupboard as the identity, and the same honest consequence: a private
// window is a different player with a different address book. Read once at
// start and written on change — nothing here is worth a reactive store, and a
// settings object that can change under a render is a bug waiting for a
// screenshot.
//
// There is no default board, which is deliberate and is 0007's decision rather
// than this file's: a board is a URL that arrives the way a room code used to,
// and shipping one would make this client's author the operator of the place
// every game is announced to. An empty string is therefore the normal state and
// the games card is written to say so rather than to look broken.
//
// Each string is validated **on entry, not on use**. A board that cannot be
// read because the page is on https and the board is on http fails at the far
// end as an opaque `TypeError`, several screens away from the field that caused
// it; refusing it in the field is the only place the reason is still known.

import type { ConnectionRef } from "@tessera/net";

/** The one origin-local key. Sits beside `tessera.identity`. */
const STORE = "tessera.settings";

export interface Settings {
  /** The address book to read games from, and to announce to. Empty means
   *  "this client has no address book", which is the default. */
  board: string;
  /** A service that spins host instances up on demand (0008's third create
   *  backend). Empty hides that option entirely rather than showing it
   *  broken. */
  factory: string;
  /** Host peers whose archives the leaderboard reads. Empty is a leaderboard
   *  scoped to files the player drops on it, because there is no index of
   *  finished games anywhere to read instead. */
  rankFrom: string[];
}

const EMPTY: Settings = { board: "", factory: "", rankFrom: [] };

/** Whatever was in the cupboard, shaped. Every field is checked rather than
 *  spread, because what comes out of local storage is a string somebody else's
 *  script may have written and `JSON.parse` believes all of it. */
function load(): Settings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORE);
  } catch {
    // A blocked store costs settings across reloads, not the ability to play.
    return { ...EMPTY };
  }
  if (!raw) return { ...EMPTY };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== "object") return { ...EMPTY };
  const one = parsed as Record<string, unknown>;

  return {
    board: typeof one.board === "string" ? one.board : "",
    factory: typeof one.factory === "string" ? one.factory : "",
    rankFrom: Array.isArray(one.rankFrom)
      ? one.rankFrom.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

let current: Settings = load();

/** What the settings currently are. A copy, so a caller that keeps it cannot
 *  edit the one every other reader is about to see. */
export function settings(): Settings {
  return { ...current, rankFrom: [...current.rankFrom] };
}

/** Told after a write. The store owns this rather than the field that did the
 *  writing, because "the board changed" is news to whoever is reading the board
 *  and not to whoever typed it — and there is no reason for those two to have
 *  to know about each other. */
const listeners = new Set<() => void>();

export function onSettingsChange(listener: () => void): void {
  listeners.add(listener);
}

/** Change some of them. Returns the result, so a caller that just wrote a board
 *  URL does not have to ask for it back. */
export function saveSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch, rankFrom: [...(patch.rankFrom ?? current.rankFrom)] };
  try {
    localStorage.setItem(STORE, JSON.stringify(current));
  } catch {
    // As above: the setting holds for this tab and is gone on reload.
  }
  for (const listener of listeners) listener();
  return settings();
}

/** Only for tests, which cannot reload the module between cases. */
export function resetSettings(): void {
  current = { ...EMPTY };
  listeners.clear();
}

/** Whether this page can open the room a ref names, and why not.
 *
 *  A `ws://` ref is a perfectly good ref. 0003 accepts one and 0006 keeps it
 *  legal on purpose — a LAN, a Tailscale address, a host bound to 127.0.0.1 —
 *  and a headless peer beside it joins happily. What cannot open it is *this
 *  page*, once this page is served over https: the browser refuses the socket
 *  before a byte leaves and reports it as a `TypeError` with nothing in it.
 *
 *  So it is said here and not in `parseRef`, which would be wrong about the ref,
 *  and not at the socket, which no longer knows why. It is the same rule as
 *  `checkBoardUrl` below, in the only other shape this client has for it. */
export function checkRefForPage(
  ref: ConnectionRef,
  pageProtocol = globalThis.location?.protocol ?? "http:",
): string {
  if (ref.kind !== "socket") return "";
  if (pageProtocol !== "https:") return "";
  if (new URL(ref.url).protocol !== "ws:") return "";
  return (
    `this page is served over https, so it can only open wss:// rooms. ` +
    `A headless peer (pnpm --filter @tessera/observer …) can join a ws:// room directly.`
  );
}

/** Whether a string is a board this page could actually read, and why not.
 *
 *  Returns the empty string when it is fine. The protocol is passed in rather
 *  than read off `location`, because the interesting case — an https page and
 *  an http board — is precisely the one a Node test has no location for.
 *
 *  This is the settings half of the mixed-content rule. The join box has the
 *  other half, and both are said here rather than in `parseRef` or in
 *  `Directory`, because neither of those is wrong: an `http://` board is a
 *  perfectly good board, and a headless peer on the same LAN reads it happily.
 *  It is the *page* that cannot, and only the page knows that. */
export function checkBoardUrl(
  text: string,
  // `globalThis.location`, not `location`: this module is imported by a Node
  // test, where the bare name is a ReferenceError rather than `undefined`.
  pageProtocol = globalThis.location?.protocol ?? "http:",
): string {
  const trimmed = text.trim();
  if (!trimmed) return ""; // empty is the default, not a mistake

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `"${trimmed}" is not a URL — an address book looks like https://board.example/games`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `an address book is read over http or https, not ${url.protocol.replace(":", "")}`;
  }

  if (url.protocol === "http:" && pageProtocol === "https:") {
    return (
      `this page is served over https, so it can only read an https:// address book. ` +
      `A headless peer (pnpm --filter @tessera/host … --announce) can use an http:// one.`
    );
  }

  return "";
}

/** The same rule again, for the host factory, and deliberately not the same
 *  function with a noun passed in.
 *
 *  Three sentences differ and all three are the part that is worth reading: a
 *  board is *read* and a factory is *posted to*, the example URLs are different
 *  shapes, and the way out is different — a headless peer can use an http board,
 *  and there is no headless anything that will use somebody's factory for you.
 *  A shared helper with a nouns argument would produce one sentence that fits
 *  neither. */
export function checkFactoryUrl(
  text: string,
  pageProtocol = globalThis.location?.protocol ?? "http:",
): string {
  const trimmed = text.trim();
  if (!trimmed) return ""; // empty is the default, and hides the option entirely

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `"${trimmed}" is not a URL — a host service looks like https://hosts.example`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `a host service is posted to over http or https, not ${url.protocol.replace(":", "")}`;
  }

  if (url.protocol === "http:" && pageProtocol === "https:") {
    return (
      `this page is served over https, so it can only post to an https:// host service. ` +
      `A service on http is reachable from this client served over http — pnpm dev, for instance.`
    );
  }

  return "";
}
