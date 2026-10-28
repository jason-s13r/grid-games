// Where a game link points: the room's socket, and an invite if it carries one.

import type { SignedInvite } from "@tessera/protocol";

export interface Link {
  /** ws:// or wss:// address of the room. */
  socket: string;
  roomId: string;
  invite?: SignedInvite;
}

/** The parts of a game link: https://host/g/<id>[?invite=…]. */
export function parseLink(text: string): Link | string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "give the whole game link, starting https://";
  }
  const match = url.pathname.match(/^\/g\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (!match) return "that is not a game link: expected …/g/<game>";
  const roomId = match[1]!;
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const link: Link = { socket: `${scheme}//${url.host}/game/${roomId}/ws`, roomId };
  const invite = url.searchParams.get("invite");
  if (invite) {
    try {
      link.invite = JSON.parse(Buffer.from(invite, "base64url").toString("utf8")) as SignedInvite;
    } catch {
      return "the invite in that link is damaged";
    }
  }
  return link;
}
