// Getting from "two peers who found each other" to "one agreed game".
//
// It lives here rather than in the client because a headless peer needs exactly
// the same handshake and none of the rest of a page: the observer and the bot
// join a running game the way a reloading tab does, and a second implementation
// of this would be a second implementation of the one part of the protocol
// where a peer decides what it is playing.
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
import type { EmpireSpec, Genesis, MemberSpec } from "@tessera/sim";
import {
  FRAME,
  Identity,
  fingerprint,
  inspectGenesis,
  randomBytes,
  sealGenesis,
  toBase64Url,
} from "@tessera/protocol";
import type { Frame, MemberKey } from "@tessera/protocol";
import { LocalHub } from "./hub.js";
import { PeerMesh, createMesh } from "./mesh.js";
import { checkPlan } from "./teams.js";
import type { Seat } from "./lockstep.js";
import type { FrameHandler, Transport } from "./transport.js";

/** How long a joiner waits for a channel to the host before giving up.
 *
 *  Reaching the broker is not the same as reaching the host. Roughly one peer
 *  pair in five sits behind symmetric NAT and never forms a direct connection,
 *  and that failure is silent — no error arrives, the channel simply never
 *  opens. Without a deadline the joiner waits forever on a screen that says
 *  everything is fine. */
const JOIN_TIMEOUT_MS = 15_000;

export type LobbyPhase = "connecting" | "hosting" | "waiting" | "playing" | "failed";

export interface LobbyMember {
  peer: string;
  key: MemberKey;
}

/** A player as the host's team picker sees them. */
export interface LobbyPlayer {
  /** The mesh peer id. Empty for us: we have no connection to ourselves. */
  peer: string;
  key: MemberKey;
  /** Eight hex characters of the key's digest — short enough to read aloud,
   *  long enough to tell two strangers apart. */
  label: string;
  you: boolean;
}

/** How the host wants the game composed: one entry per human empire, listing
 *  its member keys in seat order, plus however many whole SimBot empires
 *  should be in the world. */
export interface HostPlan {
  empires: MemberKey[][];
  simbots: number;
  /** Bot seats per human empire, parallel to `empires`. */
  bots: number[];
  width: number;
  height: number;
}

/** A bot seat this page is responsible for playing. Only the host builds these:
 *  it minted the keys, so it is the only peer that can sign for them. */
export interface BotSeat {
  identity: Identity;
  seat: Seat;
  transport: Transport;
}

export class Lobby {
  phase: LobbyPhase = "connecting";
  code = "";
  problem = "";
  readonly members = new Map<string, MemberKey>();

  onChange?: () => void;
  /** `seat` is undefined for an observer — a peer whose key is not in the
   *  roster. It follows, verifies and archives the game like anyone else, and
   *  can be voted a seat later by ROSTER_AMEND. */
  onStart?: (
    genesis: Genesis,
    seat: Seat | undefined,
    transport: Transport,
    bots: BotSeat[],
  ) => void;

  private handler?: FrameHandler;
  /** The record we agreed to play, kept so a peer that arrives after the game
   *  started can be told what it is. Every peer keeps it, not only the host:
   *  by the time someone reloads, the host may be long gone. */
  private sealed?: Genesis;
  private readonly backlog: Array<{ from: string; frame: Frame }> = [];
  private watchdog?: ReturnType<typeof setTimeout>;
  /** Key digests, computed once each. Deriving one is async and the panel
   *  renders synchronously, so they are cached as they arrive. */
  private readonly labels = new Map<MemberKey, string>();
  /** Keypairs minted for the bot seats this page will play, by public key.
   *
   *  They are not persisted and never leave the page. A bot's key is its seat,
   *  so losing it loses the seat — which is the honest behaviour: a bot exists
   *  because the host offered to run it, and when the host closes the tab
   *  nobody is running it any more. The empire simply idles, exactly as it does
   *  when a person walks away.
   *
   *  Only the host has them. Every other peer sees an ordinary keyed seat in
   *  the roster and validates its moves like anyone else's. */
  private readonly botKeys = new Map<MemberKey, Identity>();
  /** One connection to the world, several drivers behind it. Built lazily,
   *  because a game with no bot seats needs exactly one port and would rather
   *  not pay for the indirection. */
  private hub?: LocalHub;

  private constructor(
    readonly identity: Identity,
    readonly mesh: PeerMesh,
    readonly join?: string,
  ) {
    this.code = join ?? mesh.id;
    this.phase = join ? "waiting" : "hosting";
    this.mesh.listen((from, frame) => this.route(from, frame));
    void this.label(identity.key);

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
    // Mid-game arrival: someone reloaded, or opened the room again from another
    // device. They cannot ask for the genesis, because until they have it they
    // do not know the game id every other frame is signed against.
    if (this.sealed) this.mesh.send(peer, { t: FRAME.GENESIS, genesis: this.sealed });
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

  /** Everyone the host can seat, us first and the rest in peer-id order.
   *  The order has to be stable, or a team picker rearranges itself under the
   *  host's cursor every time somebody joins. */
  players(): LobbyPlayer[] {
    const mine: LobbyPlayer = {
      peer: "",
      key: this.identity.key,
      label: this.labels.get(this.identity.key) ?? "you",
      you: true,
    };
    const others = [...this.members.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([peer, key]) => ({
        peer,
        key,
        label: this.labels.get(key) ?? peer.slice(0, 8),
        you: false,
      }));
    return [mine, ...others];
  }

  private async label(key: MemberKey): Promise<void> {
    if (this.labels.has(key)) return;
    this.labels.set(key, await fingerprint(key));
    this.changed();
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
        void this.label(frame.key);
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

  /** Compose the game and tell everyone.
   *
   *  Teams are the host's to arrange, because the host is the one composing the
   *  genesis record — and once it is sealed and broadcast, every peer verifies
   *  it for itself and the host has no further authority over anything.
   *
   *  An empire is a set of seats sharing territory, with a population timer
   *  each. That is what makes three people on one empire meaningfully stronger
   *  than one, and it is what shift rotation is for: the incoming player simply
   *  has their own timer, and needs no handover mechanism at all. */
  async host(plan: HostPlan): Promise<boolean> {
    const problem = checkPlan(plan, [this.identity.key, ...this.members.values()]);
    if (problem) {
      this.problem = problem;
      this.changed();
      return false;
    }

    // Human seats first, then bot seats, so a member index means the same
    // thing on every peer regardless of the mix: e1m0 is whoever the host
    // listed first, bot or not, and the roster is what says which.
    const empires: EmpireSpec[] = [];
    for (const [offset, keys] of plan.empires.entries()) {
      const members: MemberSpec[] = keys.map((key) => ({ kind: MEMBER.HUMAN, key }));
      for (let i = 0; i < (plan.bots[offset] ?? 0); i++) {
        const bot = await Identity.generate();
        this.botKeys.set(bot.key, bot);
        members.push({ kind: MEMBER.BOT, key: bot.key });
      }
      empires.push({ control: CONTROL.HUMAN, members });
    }
    for (let i = 0; i < plan.simbots; i++) {
      empires.push({ control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] });
    }

    const genesis = makeGenesis({
      seed: seedFrom(`${this.code}:${Date.now()}`),
      // Every peer derives the step number from this and its own clock, so a
      // peer whose clock runs fast simply waits for the others. Skew costs
      // responsiveness, never agreement.
      startedAt: Date.now(),
      map: { width: plan.width, height: plan.height },
      empires,
    });

    const sealed = await sealGenesis(genesis);
    this.mesh.broadcast({ t: FRAME.GENESIS, genesis: sealed });
    await this.adopt(sealed);
    return true;
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

    // No seat is not a failure. Anyone may connect and watch: an observer
    // validates and stores the game exactly as a player does, and simply holds
    // nothing, which is why an uninvited peer is harmless without any mechanism
    // for keeping it out. It can be voted a seat later, and that is how someone
    // joins a game already in progress.
    this.clearWatchdog();
    this.sealed = genesis;
    this.phase = "playing";
    this.changed();

    // The player's own port first, so a page with no bots in it gets the mesh
    // id it would have had anyway and behaves exactly as it did before.
    const hub = (this.hub ??= new LocalHub(this.baseTransport()));
    const mine = hub.port();
    const bots = this.botSeats(genesis).map((found) => ({ ...found, transport: hub.port() }));
    this.onStart?.(genesis, seat, mine, bots);
  }

  /** Seats in the sealed record whose keys this page minted. Read back out of
   *  the genesis rather than remembered alongside it, so the seat numbers are
   *  the ones every other peer will be validating against. */
  private botSeats(genesis: Genesis): Array<{ identity: Identity; seat: Seat }> {
    const found: Array<{ identity: Identity; seat: Seat }> = [];
    genesis.empires.forEach((empire, offset) => {
      empire.members.forEach((member, index) => {
        const identity = member.key ? this.botKeys.get(member.key) : undefined;
        if (identity) found.push({ identity, seat: { empire: offset + 1, member: index } });
      });
    });
    return found;
  }

  /** The page's one view of the mesh, which the hub then divides. Its listener
   *  is routed through the lobby so frames that arrived early are not lost. */
  private baseTransport(): Transport {
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
    this.hub?.close();
    this.hub = undefined;
    this.mesh.close();
  }
}
