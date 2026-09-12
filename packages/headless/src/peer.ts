// A peer with no page around it.
//
// Everything below the lobby already ran under Node — that is what the whole
// test harness is — so this is thinner than it looks: install a WebRTC
// implementation where PeerJS expects one, join the way a reloading tab joins,
// and call pump() on a timer instead of on an animation frame.
//
// What it buys is the durability gap Phase D names. A mesh with nobody awake in
// it is a mesh that has stopped; one process on a small VPS, holding no
// authority and no seat, is enough for a three-day game to survive everybody
// going to bed. It cannot cheat, because it has nothing to cheat with: no seat,
// no vote that is not counted like everyone else's, and every frame it forwards
// is signed by somebody else.

import { STEPS_PER_SECOND, Sim } from "@tessera/sim";
import type { Genesis } from "@tessera/sim";
import { Roster } from "@tessera/protocol";
import type { Identity } from "@tessera/protocol";
import { Lobby, Lockstep, parseRef } from "@tessera/net";
import type { ConnectionRef, HostPlan, LobbyPlayer, Opener, Seat, Transport } from "@tessera/net";
import { installWebRTC, shutdownWebRTC } from "./webrtc.js";

/** How often to pump. One step's worth: the driver simulates up to the step the
 *  wall clock says it should be at, so a slower timer means catching up in
 *  bursts rather than falling behind, and a faster one is spent looking. */
const PUMP_MS = 1000 / STEPS_PER_SECOND;

/** A game that has not begun by now is not going to. Longer than the client's
 *  fifteen seconds because a daemon is not staring at a spinner and would
 *  rather retry a slow host than give up on it. */
const JOIN_TIMEOUT_MS = 45_000;

export interface JoinOptions {
  /** Where the game is: a room code, or a room link. A string rather than a
   *  parsed ref because both callers are command lines, and parsing it here
   *  means one error message for both of them. */
  ref: string;
  identity: Identity;
  /** Replaces PeerJS's own STUN and TURN servers rather than adding to them —
   *  the same trap the mesh documents. Leave it unset unless you run a relay. */
  iceServers?: RTCIceServer[];
  /** Claim this peer id rather than taking whatever the broker offers. An
   *  always-on peer wants a stable address: a room code is a peer id, so a game
   *  whose original host has gone home is reachable at this one or nowhere. */
  id?: string;
  /** Milliseconds between pumps. Only a test has a reason to change it. */
  interval?: number;
  joinTimeoutMs?: number;
  /** Called before the driver starts, which is the only moment an archive can
   *  attach without missing a step. */
  onDriver?: (driver: Lockstep, genesis: Genesis, seat?: Seat) => void;
}

export interface JoinedGame {
  lobby: Lobby;
  driver: Lockstep;
  genesis: Genesis;
  /** Undefined for an observer, which is what a peer is until an empire votes
   *  it a seat. The driver's own `seat` is the live answer; this is the one it
   *  started with. */
  seat?: Seat;
  /** The step the simulation has reached, for a caller printing progress. */
  readonly step: number;
  stop(): Promise<void>;
}

export interface HostOptions {
  identity: Identity;
  /** Where the room is. A host serving its own bus passes the ref it is serving;
   *  one hosting a WebRTC room passes nothing and is handed a code. */
  ref?: ConnectionRef;
  /** Open the connection. A host serving its own relay attaches in process, so
   *  this is how it hands the lobby a transport over `localPair` rather than a
   *  socket to itself. */
  connect?: Opener;
  /** The peer id to claim. On WebRTC this is also the room code. */
  id?: string;
  iceServers?: RTCIceServer[];
  /** Decide the game, when the room is ready. Returning null means "not yet":
   *  the host keeps waiting and is asked again as people arrive.
   *
   *  The composer's own key is always among the members present and a host peer
   *  never seats itself, so every plan it composes must list that key under
   *  `watching` — otherwise `checkPlan` refuses it as "somebody here has no
   *  seat", which is the guard that stops a browser host sealing a game with
   *  somebody's name missing from it. */
  compose: (players: LobbyPlayer[]) => HostPlan | null;
  interval?: number;
  onDriver?: (driver: Lockstep, genesis: Genesis, seat?: Seat) => void;
  /** The room filled up or the deadline passed and nothing could be composed. */
  onWaiting?: (players: LobbyPlayer[]) => void;
}

export interface HostedGame extends JoinedGame {
  /** What to give somebody who wants in: a room code, or a whole link. */
  shareable: string;
}

/** Open a room, compose a game in it, and keep simulating it until told to stop.
 *
 *  The host is a client with a job and never a server of truth. It seals the
 *  genesis — which is all a host has ever done — and then holds no seat, signs no
 *  checkpoints, casts no vote, and counts for nothing in the abandonment rule,
 *  which counts empires by their silence and a peer with no empire is not in the
 *  sum. Its presence changes no hash. */
export async function hostGame(options: HostOptions): Promise<HostedGame> {
  if (options.ref?.kind !== "socket") await installWebRTC();

  let driving: Lockstep | undefined;
  const lobby = await Lobby.open(options.identity, options.ref, {
    hosting: true,
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.id ? { id: options.id } : {}),
    ...(options.iceServers ? { iceServers: options.iceServers } : {}),
    onReconnect: () => driving?.requestSnapshot(),
  });

  const started = new Promise<{ genesis: Genesis; seat?: Seat; transport: Transport }>((resolve) => {
    lobby.onStart = (genesis, seat, transport) => resolve({ genesis, seat, transport });
  });

  let sealing = false;
  lobby.onChange = () => {
    if (sealing || lobby.phase === "playing") return;
    const plan = options.compose(lobby.players());
    if (!plan) {
      options.onWaiting?.(lobby.players());
      return;
    }
    // One at a time: `host` is async, and a second arrival landing inside it
    // would compose a second genesis for the same room.
    sealing = true;
    void lobby.host(plan).then((sealed) => {
      if (!sealed) sealing = false;
    });
  };
  lobby.onChange();

  const joined = await started;
  return { ...run(options, lobby, joined, (driver) => (driving = driver)), shareable: lobby.shareable };
}

/** Join a running game and keep simulating it until told to stop. */
export async function joinGame(options: JoinOptions): Promise<JoinedGame> {
  const ref = parseRef(options.ref);
  // A socket peer has no use for a native WebRTC stack, and this is the only
  // place in the repository that loads one. node-datachannel is the single
  // genuinely unpleasant dependency here — prebuilt binaries per platform,
  // where everything else is portable TypeScript — so a socket-only deployment
  // getting to skip it is not a micro-optimisation, it is the difference
  // between an install that works on a small VPS and one that does not.
  if (ref.kind === "rtc") await installWebRTC();

  // Set once the driver exists, and read only by callbacks that fire later. A
  // reconnecting socket has to be able to reach the driver, and the connection
  // is necessarily older than the game it ends up carrying.
  let driving: Lockstep | undefined;

  let lobby: Lobby;
  try {
    lobby = await Lobby.open(options.identity, ref, {
      // The outbound buffer means nothing of ours was lost across the gap, but
      // nothing replays what everyone else said while we were away.
      onReconnect: () => driving?.requestSnapshot(),
      ...(options.iceServers ? { iceServers: options.iceServers } : {}),
      ...(options.id ? { id: options.id } : {}),
    });
  } catch (error) {
    // The broker was unreachable, which is not the same as the game being
    // absent. Either way libdatachannel is up by now and would hold the process
    // open long after there was anything to hold it open for.
    await shutdownWebRTC();
    throw error;
  }
  const started = new Promise<{ genesis: Genesis; seat?: Seat; transport: Transport }>(
    (resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`no game under ${options.ref} after ${JOIN_TIMEOUT_MS / 1000}s`));
      }, options.joinTimeoutMs ?? JOIN_TIMEOUT_MS);

      lobby.onStart = (genesis, seat, transport) => {
        clearTimeout(deadline);
        resolve({ genesis, seat, transport });
      };
      // The lobby reports its own failures through phase rather than by
      // throwing, because in a browser they are things to put on a screen.
      lobby.onChange = () => {
        if (lobby.phase !== "failed") return;
        clearTimeout(deadline);
        reject(new Error(lobby.problem));
      };
    },
  );

  let joined: { genesis: Genesis; seat?: Seat; transport: Transport };
  try {
    joined = await started;
  } catch (error) {
    lobby.close();
    await shutdownWebRTC();
    throw error;
  }

  return run(options, lobby, joined, (driver) => (driving = driver));
}

/** Build the driver, pump it, and hand back the handle. Shared by joining and
 *  hosting, because the only difference between those two is how the genesis
 *  record arrived: after it, a host is an ordinary peer. */
function run(
  options: { identity: Identity; interval?: number; onDriver?: JoinOptions["onDriver"] },
  lobby: Lobby,
  joined: { genesis: Genesis; seat?: Seat; transport: Transport },
  hold: (driver: Lockstep) => void,
): JoinedGame {
  const { genesis, seat, transport } = joined;
  const driver = new Lockstep({
    genesis,
    sim: new Sim(genesis),
    roster: Roster.fromGenesis(genesis),
    transport,
    identity: options.identity,
    seat,
  });
  hold(driver);

  /** Repair a disagreement by rebuilding from somebody else's state.
   *
   *  `Lockstep` does not do this of its own accord — the web client always has,
   *  which is why a browser recovers from a desync within a step or two and a
   *  headless peer never did. A headless *seat* was dropped by quorum on
   *  schedule, which at least ended visibly. A headless *observer* was worse: it
   *  holds no seat, so it broadcasts no checkpoints, so no peer can see that it
   *  disagrees — it simply kept archiving a game that did not happen, and the
   *  archive is self-consistent, so verifying it returns VERIFIED.
   *
   *  Idempotent enough to be safe here: a peer that is not behind gets a
   *  snapshot it discards, and the request is one small broadcast. */
  driver.onDesync = (step) => driver.requestSnapshot(step);

  // Before start(), so an archive attached here sees the first step rather than
  // whichever one it happened to arrive for.
  options.onDriver?.(driver, genesis, seat);
  driver.start();

  // Deliberately not unref'd: the timer is what keeps the process alive, so
  // stopping the peer is the whole of stopping the program. A daemon whose
  // liveness depended on a socket handle would exit on a dropped connection
  // that PeerJS was about to retry.
  const timer = setInterval(() => driver.pump(), options.interval ?? PUMP_MS);

  let stopped = false;
  return {
    lobby,
    driver,
    genesis,
    seat,
    get step(): number {
      return driver.step;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      driver.stop();
      lobby.close();
      await shutdownWebRTC();
    },
  };
}
