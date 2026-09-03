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
import { Lobby, Lockstep } from "@tessera/net";
import type { Seat, Transport } from "@tessera/net";
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
  /** The room code: the host's peer id, as printed by the client. */
  code: string;
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

/** Join a running game and keep simulating it until told to stop. */
export async function joinGame(options: JoinOptions): Promise<JoinedGame> {
  await installWebRTC();

  let lobby: Lobby;
  try {
    lobby = await Lobby.open(options.identity, options.code, {
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
        reject(new Error(`no game under ${options.code} after ${JOIN_TIMEOUT_MS / 1000}s`));
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

  const { genesis, seat, transport } = joined;
  const driver = new Lockstep({
    genesis,
    sim: new Sim(genesis),
    roster: Roster.fromGenesis(genesis),
    transport,
    identity: options.identity,
    seat,
  });

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
