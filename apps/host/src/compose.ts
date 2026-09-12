// How a process decides what game to seal.
//
// Two modes, both explicit, because the failure shapes are different: `--plan`
// names the keys and therefore knows when everybody it seated is here, while
// `--auto n` counts arrivals and has no idea who they are. Neither has a default,
// since a host that seals a game nobody asked it to seal is worse than one that
// waits.
//
// Whichever mode a room used is visible in the record it produced. Nothing about
// the seal changes: the host composes, everybody else verifies and refuses.

import { MAX_SEATS } from "@tessera/net";
import type { HostPlan, LobbyPlayer } from "@tessera/net";
import type { BotChoice, DurationRules } from "@tessera/sim";

/** A file handed to `--plan`. Keys rather than names, because a key is the seat:
 *  the roster names public keys and nothing else. */
export interface PlanFile {
  empires: string[][];
  simbots?: BotChoice[];
  width?: number;
  height?: number;
  duration?: DurationRules;
}

export interface Composer {
  /** The plan to seal, or null to keep waiting. */
  (players: LobbyPlayer[]): HostPlan | null;
  /** What the host is waiting for, for the line it prints. */
  readonly wants: string;
}

export function fromPlan(file: PlanFile): Composer {
  const seated = file.empires.flat();
  const composer = (players: LobbyPlayer[]): HostPlan | null => {
    const here = new Set(players.map((player) => player.key));
    // Every seated key has to be present, and not because of a policy: a plan
    // that seats an absent key is "a stranger is seated" to `checkPlan` until
    // they arrive, so this is the only reading of `--plan` the check accepts.
    if (!seated.every((key) => here.has(key))) return null;
    return plan(file, file.empires, players);
  };
  return Object.assign(composer, {
    wants: `${seated.length} named player${seated.length === 1 ? "" : "s"}`,
  });
}

export function fromAuto(count: number, file: PlanFile): Composer {
  const composer = (players: LobbyPlayer[]): HostPlan | null => {
    const guests = players.filter((player) => !player.you);
    if (guests.length < count) return null;
    // One empire each. Seats *within* an empire are a team's business — an empire
    // arrives at an extra pair of hands by voting one in, and nobody composes
    // somebody else's team.
    return plan(file, guests.map((guest) => [guest.key]), players);
  };
  return Object.assign(composer, { wants: `${count} player${count === 1 ? "" : "s"}` });
}

/** Seal with whoever is here, for `--wait`'s deadline. One is the floor, and only
 *  because `simbots` can make up the rest: a game needs two empires, since one
 *  empire is last-empire-standing on the first step. */
export function sealWith(file: PlanFile, present: number): Composer | null {
  if (present < 1) return null;
  return fromAuto(present, file);
}

function plan(file: PlanFile, empires: string[][], players: LobbyPlayer[]): HostPlan {
  return {
    empires: empires.map((keys) => keys.slice(0, MAX_SEATS)),
    simbots: file.simbots ?? [],
    // Everybody here who is not seated, which is this process and nobody else
    // today. Without it `checkPlan` refuses every plan a host composes, because
    // the composer's own key is always among the members present.
    watching: players.filter((player) => !empires.flat().includes(player.key)).map((p) => p.key),
    width: file.width ?? 48,
    height: file.height ?? 48,
    ...(file.duration ? { duration: file.duration } : {}),
  };
}
