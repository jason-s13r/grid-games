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
import { proposalFrom, randomBytes } from "@tessera/protocol";
import type { Proposal } from "@tessera/protocol";
import { DEFAULT_RULES, DIFFICULTY, VACANCY_RULES, checkProfile } from "@tessera/sim";
import type { BotChoice, DurationRules } from "@tessera/sim";

/** A file handed to `--plan`. Keys rather than names, because a key is the seat:
 *  the roster names public keys and nothing else. */
export interface PlanFile {
  empires: string[][];
  simbots?: BotChoice[];
  /** Empires to leave unclaimed, for somebody to arrive into once the game is
   *  running. The reason a host peer is the natural place to ask for one: a
   *  vacancy is only useful in a game that is still there when the person who
   *  wants it turns up, and a process is what keeps a game there. */
  vacancies?: number;
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
    ...(file.vacancies ? { vacancies: file.vacancies } : {}),
    // Everybody here who is not seated, which is this process and nobody else
    // today. Without it `checkPlan` refuses every plan a host composes, because
    // the composer's own key is always among the members present.
    watching: players.filter((player) => !empires.flat().includes(player.key)).map((p) => p.key),
    width: file.width ?? 48,
    height: file.height ?? 48,
    ...(file.duration ? { duration: file.duration } : {}),
  };
}

/** The world a `--propose` room puts on the table.
 *
 *  The same plan file, read for everything except the roster — because a
 *  proposal names nobody, and the roster is whoever signs it. `--vacancies`,
 *  `--plan`'s map and duration and its bot list all mean exactly what they mean
 *  in the composing path; `empires` is the one field that stops applying, and
 *  that is the point.
 *
 *  `startedAt` is a future instant rather than `Date.now()`, so the deadline for
 *  signing is a fact of the record everyone can read rather than a convention
 *  held by this process. A random seed, not one derived from the room code and
 *  the clock: two identical-looking worlds in two rooms must be distinct
 *  objects, or a consent could be lifted out of one into the other. */
export function worldFrom(file: PlanFile, opensIn: number): Proposal {
  const bots = file.simbots ?? [];
  for (const one of bots) {
    if (typeof one === "string") continue;
    const wrong = checkProfile(one, { ...DEFAULT_RULES, ...file.duration });
    if (wrong) throw new Error(`a bot in this plan cannot be played: ${wrong}`);
  }
  return proposalFrom({
    seed: randomSeed(),
    startedAt: Date.now() + Math.max(0, opensIn) * 1000,
    map: { width: file.width ?? 48, height: file.height ?? 48 },
    ...(file.duration || file.vacancies
      ? { rules: { ...(file.vacancies ? VACANCY_RULES : {}), ...file.duration } }
      : {}),
    simbots: bots.map((one) => (typeof one === "string" ? DIFFICULTY[one] : one)),
    ...(file.vacancies ? { vacancies: file.vacancies } : {}),
  });
}

/** Whether enough people have signed to stop waiting. `--auto n` supplies the
 *  number; without one the room waits for the instant in the record. */
export function sealAt(count: number | undefined): ((signers: readonly string[]) => boolean) | undefined {
  if (count === undefined) return undefined;
  return (signers) => signers.length >= count;
}

function randomSeed(): number {
  const bytes = randomBytes(4);
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}
