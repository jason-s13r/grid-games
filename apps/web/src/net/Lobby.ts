// Getting from "two browser tabs" to "one agreed game".
//
// The lobby exists to answer one question before any simulation starts: who is
// playing, and under which key. Once the host has that, it builds the genesis
// record — whose hash is the game id — and broadcasts it. Every peer then finds
// its own key in the roster and knows which seat it holds. Nothing after that
// point needs a host at all.
//
// The lobby also owns the mesh's only listener. A joiner cannot build its
// driver until the genesis record arrives, and game frames share the channel
// with it, so anything that turns up in that gap is buffered here and replayed
// into the driver the moment it exists.

import { CONTROL, MEMBER, PROTOCOL_VERSION, makeGenesis, seedFrom } from "@tessera/sim";
import type { EmpireSpec, Genesis } from "@tessera/sim";
import {
  FRAME,
  Identity,
  inspectGenesis,
  randomBytes,
  sealGenesis,
  toBase64Url,
} from "@tessera/protocol";
import type { Frame, MemberKey } from "@tessera/protocol";
import { createMesh } from "@tessera/net";
import type { PeerMesh, Transport, FrameHandler, Seat } from "@tessera/net";

const IDENTITY_STORE = "tessera.identity";

/** How long a joiner waits for a channel to the host before giving up.
 *
 *  Reaching the broker is not the same as reaching the host. Roughly one peer
 *  pair in five sits behind symmetric NAT and never forms a direct connection,
 *  and that failure is silent — no error arrives, the channel simply never
 *  opens. Without a deadline the joiner waits forever on a screen that says
 *  everything is fine. */
const JOIN_TIMEOUT_MS = 15_000;

/** The keypair is the seat. Losing it loses the seat, so it is persisted —
 *  and because it is persisted, a private window is a different player. */
export async function myIdentity(): Promise<Identity> {
  const stored = localStorage.getItem(IDENTITY_STORE);
  if (stored) {
    const restored = await Identity.restore(stored);
    if (restored) return restored;
  }
  const fresh = await Identity.generate();
  try {
    localStorage.setItem(IDENTITY_STORE, await fresh.export());
  } catch {
    // A blocked store costs persistence across reloads, not the ability to play.
  }
  return fresh;
}

export type LobbyPhase = "connecting" | "hosting" | "waiting" | "playing" | "failed";

export interface LobbyMember {
  peer: string;
  key: MemberKey;
}

export class Lobby {
  phase: LobbyPhase = "connecting";
  code = "";
  problem = "";
  readonly members = new Map<string, MemberKey>();

  onChange?: () => void;
  onStart?: (genesis: Genesis, seat: Seat, transport: Transport) => void;

  private handler?: FrameHandler;
  private readonly backlog: Array<{ from: string; frame: Frame }> = [];
  private watchdog?: ReturnType<typeof setTimeout>;

  private constructor(
    readonly identity: Identity,
    readonly mesh: PeerMesh,
    readonly join?: string,
  ) {
    this.code = join ?? mesh.id;
    this.phase = join ? "waiting" : "hosting";
    this.mesh.listen((from, frame) => this.route(from, frame));

    if (join) {
      this.watchdog = setTimeout(() => {
        if (this.phase !== "waiting" || this.mesh.peers().length > 0) return;
        this.fail(
          `no answer from ${join}. Either the code is wrong, the host has closed the ` +
            `game, or your networks cannot reach each other directly.`,
        );
      }, JOIN_TIMEOUT_MS);
    }
  }

  /** PeerJS arrives here, on demand: a solo game never downloads it. Resolves
   *  once the broker has assigned an id, because until then there is no room
   *  code to put on screen. */
  static async open(identity: Identity, join?: string): Promise<Lobby> {
    let lobby: Lobby | undefined;
    const mesh = await createMesh({
      join,
      prefix: "tsr-",
      onJoin: (peer) => lobby?.welcome(peer),
      onLeave: (peer) => {
        lobby?.members.delete(peer);
        lobby?.changed();
      },
      onError: (error) => {
        if (!lobby) return;
        // PeerJS tags its errors; the two that matter to a player are being
        // unable to reach the broker at all and naming a room that is not there.
        const type = (error as Error & { type?: string }).type;
        if (type === "peer-unavailable") lobby.fail(`no game is running under ${join}.`);
        else if (type === "network" || type === "server-error") {
          lobby.fail("lost contact with the matchmaking broker.");
        } else lobby.fail(error.message);
      },
    });
    lobby = new Lobby(identity, mesh, join);
    return lobby;
  }

  private welcome(peer: string): void {
    this.clearWatchdog();
    this.greet(peer);
    this.changed();
  }

  private fail(problem: string): void {
    if (this.phase === "playing") return; // a live game is not the lobby's to end
    this.clearWatchdog();
    this.phase = "failed";
    this.problem = problem;
    this.changed();
  }

  private clearWatchdog(): void {
    if (this.watchdog === undefined) return;
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  get roster(): LobbyMember[] {
    return [...this.members.entries()].map(([peer, key]) => ({ peer, key }));
  }

  /** Announce who we are. The game id is empty because there is no game yet:
   *  this is the one moment in the protocol where that is true, and it is why
   *  a lobby hello proves nothing beyond "here is a key to seat me under".
   *  Everything that decides anything is signed against a real game id. */
  private greet(peer: string): void {
    this.mesh.send(peer, {
      t: FRAME.HELLO,
      protocol: PROTOCOL_VERSION,
      gameId: "",
      key: this.identity.key,
      nonce: toBase64Url(randomBytes(16)),
    });
  }

  private route(from: string, frame: Frame): void {
    if (frame.t === FRAME.HELLO) {
      if (frame.protocol !== PROTOCOL_VERSION) return; // a build we cannot play with
      if (frame.key) {
        this.members.set(from, frame.key);
        this.changed();
      }
      return;
    }
    if (frame.t === FRAME.GENESIS && this.phase !== "playing") {
      void this.adopt(frame.genesis);
      return;
    }

    if (this.handler) this.handler(from, frame);
    else if (this.backlog.length < 4096) this.backlog.push({ from, frame });
  }

  /** Compose the game and tell everyone. One empire per human, plus however
   *  many SimBot empires the host wants in the world. */
  async host(options: { bots: number; width: number; height: number }): Promise<void> {
    const keys = [this.identity.key, ...this.members.values()];
    const empires: EmpireSpec[] = keys.map((key) => ({
      control: CONTROL.HUMAN,
      members: [{ kind: MEMBER.HUMAN, key }],
    }));
    for (let i = 0; i < options.bots; i++) {
      empires.push({ control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] });
    }

    const genesis = makeGenesis({
      seed: seedFrom(`${this.code}:${Date.now()}`),
      // Every peer derives the step number from this and its own clock, so a
      // peer whose clock runs fast simply waits for the others. Skew costs
      // responsiveness, never agreement.
      startedAt: Date.now(),
      map: { width: options.width, height: options.height },
      empires,
    });

    const sealed = await sealGenesis(genesis);
    this.mesh.broadcast({ t: FRAME.GENESIS, genesis: sealed });
    await this.adopt(sealed);
  }

  /** Check the record before agreeing to play it, then find our own seat. An
   *  unkeyed peer, or one whose key is not in the roster, is an observer —
   *  which needs no mechanism beyond not being listed. */
  private async adopt(genesis: Genesis): Promise<void> {
    const problems = await inspectGenesis(genesis);
    if (problems.length > 0) {
      this.fail(`refused the game: ${problems.join(", ")}`);
      return;
    }

    let seat: Seat | undefined;
    genesis.empires.forEach((empire, offset) => {
      empire.members.forEach((member, index) => {
        if (member.key === this.identity.key) seat = { empire: offset + 1, member: index };
      });
    });
    if (!seat) {
      this.fail("this game's roster does not include you");
      return;
    }

    this.clearWatchdog();
    this.phase = "playing";
    this.changed();
    this.onStart?.(genesis, seat, this.transport());
  }

  /** The driver's view of the mesh. Its listener is routed through the lobby so
   *  frames that arrived early are not lost. */
  private transport(): Transport {
    const mesh = this.mesh;
    return {
      id: mesh.id,
      peers: () => mesh.peers(),
      broadcast: (frame) => mesh.broadcast(frame),
      send: (to, frame) => mesh.send(to, frame),
      listen: (handler) => {
        this.handler = handler;
        const waiting = this.backlog.splice(0, this.backlog.length);
        for (const { from, frame } of waiting) handler(from, frame);
        return () => {
          this.handler = undefined;
        };
      },
    };
  }

  private changed(): void {
    this.onChange?.();
  }

  close(): void {
    this.clearWatchdog();
    this.mesh.close();
  }
}
