// Backend 3: asking a service to put a room somewhere.
//
// Nothing in this series builds a managed factory. 0006 describes one in a
// paragraph and is careful to make it optional — spin up a host, hand back
// connection params, get out of the way — and what ships here is the shape of
// that request with no server to answer it. The URL lives in settings beside the
// address book, is empty by default, and the option is hidden entirely while it
// is empty rather than shown broken.
//
// POST <factory>/rooms  { protocol, plan }  ->  { refs: string[], resume?: string }
//
// A factory is a convenience and never an authority. What comes back is a set of
// refs, which is the same thing a friend sends you in a message: the game that
// ends up running in that room is composed by this tab and verified by every
// peer in it, so a factory that lies hands back a door into a room that will
// refuse us. The plan in the request is a *hint* — what this tab intends to run,
// so the factory can size or refuse the instance — and it is not the record.
// Nothing signs it and nothing is bound by it.

import { PROTOCOL_VERSION } from "@tessera/sim";
import { parseRef } from "@tessera/net";
import type { ConnectionRef, HostPlan } from "@tessera/net";

/** Long enough for a service that has to boot a process, short enough that a
 *  player is not left looking at a button they pressed a minute ago. */
export const FACTORY_TIMEOUT_MS = 30_000;

/** A hostile or broken factory can stream indefinitely and `response.json()`
 *  will buffer all of it. A handful of refs is a few hundred bytes. */
export const FACTORY_CAP = 64_000;

/** What the tab intends to run. Every field is a hint and none is a claim: the
 *  roster is empty because nobody has arrived yet, and the record that finally
 *  gets sealed is composed here, after they have. */
export type PlanHint = Omit<HostPlan, "empires"> & { empires?: never };

export interface FactoryRoom {
  /** Doors this build can read, in the order the factory listed them. */
  refs: ConnectionRef[];
  /** Doors it could not. Kept rather than dropped so a client can say "that
   *  service offered a kind of room this version cannot open" instead of
   *  "nothing came back". */
  unreadable: string[];
  /** Where a resume point could be fetched, if the factory handed a room that
   *  already has a game in it. Not used by the create flow — there is nothing to
   *  resume in a room that was made a second ago — and carried because dropping
   *  a field silently is how a seam stops being one. */
  resume?: string;
}

/** Ask for a room. Throws with something worth reading; the caller shows it.
 *
 *  Errors rather than a result type because every one of these is the end of the
 *  attempt: there is no partial room, and nothing downstream can proceed on
 *  "the factory said 503". */
export async function askForRoom(
  factory: string,
  plan: PlanHint,
  http: typeof fetch = (...args) => globalThis.fetch(...args),
  timeoutMs: number = FACTORY_TIMEOUT_MS,
): Promise<FactoryRoom> {
  const url = `${factory.replace(/\/+$/, "")}/rooms`;
  let response: Response;
  try {
    response = await http(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ protocol: PROTOCOL_VERSION, plan }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A cross-origin POST that the service does not allow fails here, opaquely,
    // and looks exactly like a service that is down. Both get the same sentence
    // because from this side they are the same event.
    throw new Error(
      `could not reach ${url} — it may be down, or it may not allow this page to post to it ` +
        `(${(error as Error).message})`,
    );
  }

  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`.trim());
  }

  const body = await capped(response, url);
  if (!body || typeof body !== "object" || !Array.isArray((body as { refs?: unknown }).refs)) {
    throw new Error(`${url} answered something that is not a room`);
  }

  const refs: ConnectionRef[] = [];
  const unreadable: string[] = [];
  for (const entry of (body as { refs: unknown[] }).refs) {
    if (typeof entry !== "string") continue;
    try {
      refs.push(parseRef(entry));
    } catch {
      unreadable.push(entry);
    }
  }
  if (refs.length === 0) {
    throw new Error(
      unreadable.length > 0
        ? `${url} offered ${unreadable.length} room${unreadable.length === 1 ? "" : "s"} this ` +
          `version cannot open — it may need a newer build`
        : `${url} handed back no rooms`,
    );
  }

  const resume = (body as { resume?: unknown }).resume;
  return { refs, unreadable, ...(typeof resume === "string" ? { resume } : {}) };
}

/** The body, with a ceiling on it. Same discipline as the address book's, for
 *  the same reason: `response.json()` has no size limit of its own. */
async function capped(response: Response, url: string): Promise<unknown> {
  const text = await response.text();
  if (text.length > FACTORY_CAP) throw new Error(`${url} answered more than a room's worth of data`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url} answered something that is not JSON`);
  }
}
