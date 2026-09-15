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
// The lobby also owns the connection's only listener. A joiner cannot build its
// driver until the genesis record arrives, and game frames share the channel
// with it, so anything that turns up in that gap is buffered here and replayed
// into the driver the moment it exists.

import {
  CONTROL,
  MEMBER,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  makeGenesis,
  seedFrom,
  simbot,
} from "@tessera/sim";
import type { BotChoice, DurationRules, EmpireSpec, Genesis } from "@tessera/sim";
import {
  FRAME,
  Identity,
  fingerprint,
  inspectGenesis,
  randomBytes,
  sealGenesis,
  toBase64Url,
} from "@tessera/protocol";
import type { Frame, HelloFrame, MemberKey } from "@tessera/protocol";
import { openConnection } from "./connect.js";
import type { Connection, ConnectOptions, Opener } from "./connect.js";
import { formatRef } from "./ref.js";
import type { ConnectionRef } from "./ref.js";
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
  /** Their peer id on this connection. Empty for us: we have no connection to
   *  ourselves. */
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
  /** One entry per SimBot empire, naming how hard that one plays: a preset, or
   *  a profile the host tuned by hand. Each goes into the genesis record with
   *  everything else, so a game's opponents are a fact of it rather than a
   *  claim about it — a hand-tuned bot is as checkable before the first move as
   *  a named difficulty is.
   *
   *  A profile is safe to pass straight through where `duration` was not, and
   *  the difference is worth stating. Every number in a `BotProfile` is bounded
   *  where the simulation reads it: `popMax` is clamped to `rules.popMax` when
   *  the seat is created, a phase's rate is floored at `rules.botActionInterval`
   *  on every action, and `coins` is a percentage. There is no setting here
   *  that decides a game the way `abandonWindow` could — and a host who makes
   *  the bots brutal has made them brutal to their own empire too. */
  simbots: readonly BotChoice[];
  width: number;
  height: number;
  /** Keys that are here and deliberately not playing — a host peer composing a
   *  game it will only watch. Passed through to `checkPlan`, which otherwise
   *  refuses every plan a headless host can compose: the composer's own key is
   *  always among the members present, and a host peer never seats itself. */
  watching?: readonly MemberKey[];
  /** How long the game runs, and the two windows that scale with it.
   *
   *  Deliberately `DurationRules` and not `Partial<Rules>`. A general
   *  passthrough is a hole: a modified client could compose a game with
   *  `abandonWindow: 12` and be handed WIN.LAST_ROSTER the first time it is
   *  the only empire to have moved inside a second — and the same door lets a
   *  host set popMax, marchCost or coinIntervalMin to whatever wins. A Pick of
   *  three fields refuses all of that in the type.
   *
   *  A type binds our client and not a hostile one, which is why the floor is
   *  also checked in `inspectGenesis`, where every peer already looks. */
  duration?: DurationRules;
}

/** Whether a peer that said hello can play the version at stake — the game's
 *  if one has been adopted, otherwise the one this build would compose.
 *
 *  This is an early-out and a better error message, not the gate. The gate is
 *  `adopt` → `inspectGenesis`, which is the first moment either side knows
 *  what game is being proposed. What this buys is the rejoin: a returning
 *  player on N+1 dialling a room running N is greeted rather than dropped.
 *
 *  A hello with no `supported` came from a build that predates the field, and
 *  reads as a build that plays exactly what it stamps. */
export function canPlay(hello: HelloFrame, stake: number): boolean {
  return (hello.supported ?? [hello.protocol]).includes(stake);
}

/** A list of problem names tells a player nothing they can act on. Where the
 *  protocol is one of them, say which side is behind: below the oldest version
 *  this build plays and their build has moved on without us; above the one it
 *  composes and ours has not caught up. That is the difference between
 *  "update your client" and a shrug. */
export function explain(genesis: Genesis, problems: readonly string[]): string {
  if (!problems.includes("protocol")) return "";
  const oldest = SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1] ?? PROTOCOL_VERSION;
  const side =
    genesis.protocol > PROTOCOL_VERSION
      ? "that game is newer than this build — update to join it"
      : genesis.protocol < oldest
        ? "that game is on a rule set this build no longer plays"
        : "this build does not play that rule set";
  return ` — the game is v${genesis.protocol}, this build plays v${SUPPORTED_PROTOCOLS.join(", v")}; ${side}`;
}

/** A game id is 64 hex characters and no player reads all of them. Twelve is
 *  enough to see that two ids differ, which is the only thing this message is
 *  asking anyone to do. */
const short = (gameId: string | undefined): string =>
  gameId ? `${gameId.slice(0, 12)}\u2026` : "an unsealed record";

export class Lobby {
  phase: LobbyPhase = "connecting";
  problem = "";
  readonly members = new Map<string, MemberKey>();

  onChange?: () => void;
  /** `seat` is undefined for an observer — a peer whose key is not in the
   *  roster. It follows, verifies and archives the game like anyone else, and
   *  can be voted a seat later by ROSTER_AMEND. */
  onStart?: (genesis: Genesis, seat: Seat | undefined, transport: Transport) => void;

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

  private constructor(
    readonly identity: Identity,
    readonly connection: Connection,
    /** Where we are, resolved: what the joiner typed, or — for a host — the
     *  room the broker has just handed us. Known only after the connection is
     *  open, which is why it is a constructor argument and not a parse
     *  result. */
    readonly ref: ConnectionRef,
    /** Whether we arrived at somebody else's room, and therefore whether
     *  somebody is going to send us a genesis record. Not `!!ref`: a host has a
     *  ref too — the one the broker just gave it, or the room it is serving. */
    private readonly joined: boolean,
    /** The game we came here for, if we were told one. */
    private readonly expect?: string,
  ) {
    this.phase = joined ? "waiting" : "hosting";
    this.connection.listen((from, frame) => this.route(from, frame));
    void this.label(identity.key);

    if (joined) {
      this.watchdog = setTimeout(() => {
        if (this.phase !== "waiting" || this.connection.peers().length > 0) return;
        this.fail(
          `no answer from ${this.shareable}. Either the code is wrong, the host has closed ` +
            `the game, or your networks cannot reach each other directly.`,
        );
      }, JOIN_TIMEOUT_MS);
    }
  }

  /** The room token: a peer id on WebRTC, a room name on a socket. Shown where
   *  a short thing is wanted, and fed to the map seed. */
  get code(): string {
    return this.ref.kind === "rtc" ? this.ref.code : this.ref.room;
  }

  /** What a player actually sends to somebody else. Identical to `code` for a
   *  WebRTC room, and a whole link for a socket one. */
  get shareable(): string {
    return formatRef(this.ref);
  }

  /** Open a lobby on the connection a ref names. A transport arrives here on
   *  demand — a solo game downloads neither PeerJS nor anything else — and this
   *  resolves once the connection has an id, because until then there is no
   *  room to put on screen.
   *
   *  **`undefined` means host**, because a ref is a string somebody typed and
   *  nobody types "host": absent a ref we are the room. That is WebRTC's shape,
   *  where a peer id *is* a room code.
   *
   *  A socket room is hosted by the peer serving it, which is a thing a ref
   *  cannot express — so `hosting` says it instead. It means "nobody is going to
   *  send me a genesis record": no watchdog, phase `hosting`, and the ref kept as
   *  given so `code` and `shareable` stay right. Without it a host peer running
   *  its own bus would be killed by the joiner's watchdog fifteen seconds into
   *  waiting for the players it exists to wait for.
   *
   *  `expect` is the game we came here for. Until the address book there was
   *  nothing to say: a ref arrived from a person who had just been told what was
   *  behind it, so "the record checks out" and "the record is the one I was
   *  promised" were the same sentence. A ref looked up in a directory splits
   *  them, and only the caller that did the lookup knows which game it asked
   *  for. */
  static async open(
    identity: Identity,
    ref?: ConnectionRef,
    options: ConnectOptions & { connect?: Opener; hosting?: boolean; expect?: string } = {},
  ): Promise<Lobby> {
    let lobby: Lobby | undefined;
    const connection = await (options.connect ?? openConnection)(ref, {
      ...options,
      onJoin: (peer) => lobby?.welcome(peer),
      onLeave: (peer) => {
        lobby?.members.delete(peer);
        lobby?.changed();
      },
      // One line, because the transport already turned its own vocabulary into
      // a sentence. A transport that cannot is a transport with no error
      // messages, which is the pressure this boundary is meant to apply.
      onError: (error) => lobby?.fail(error.message),
    });
    const here: ConnectionRef = ref ?? { kind: "rtc", code: connection.id };
    const hosting = options.hosting ?? ref === undefined;
    lobby = new Lobby(identity, connection, here, !hosting, options.expect);

    // Anybody already in the room, greeted now rather than waited for.
    //
    // A mesh introduces peers as they dial, so every arrival is an event and
    // `onJoin` is the whole story. A room on a relay is a place you arrive *into*:
    // its membership is state, and the roster that carries it arrives with the
    // welcome — which is to say, while this function is still awaiting the
    // connection and before there is a lobby for `onJoin` to reach. Without this,
    // a joiner silently never greets the peers that were already there, so the
    // host never learns its key and can never seat it.
    for (const peer of connection.peers()) lobby.welcome(peer);
    return lobby;
  }

  private welcome(peer: string): void {
    this.clearWatchdog();
    this.greet(peer);
    // Mid-game arrival: someone reloaded, or opened the room again from another
    // device. They cannot ask for the genesis, because until they have it they
    // do not know the game id every other frame is signed against.
    if (this.sealed) this.connection.send(peer, { t: FRAME.GENESIS, genesis: this.sealed });
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
    this.connection.send(peer, {
      t: FRAME.HELLO,
      // The version at stake, not the version of this build: once a game is
      // adopted the stake is the game's, for its whole life.
      protocol: this.sealed?.protocol ?? PROTOCOL_VERSION,
      supported: [...SUPPORTED_PROTOCOLS],
      gameId: "",
      key: this.identity.key,
      nonce: toBase64Url(randomBytes(16)),
    });
  }

  private route(from: string, frame: Frame): void {
    if (frame.t === FRAME.HELLO) {
      // Not "were we built the same day" but "can they play this game" — the
      // one we are in, or the one this build would compose if we are not in
      // one yet.
      if (!canPlay(frame, this.sealed?.protocol ?? PROTOCOL_VERSION)) return;
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

    // Every seat in a human empire is a person who is here. A team that wants
    // an extra pair of hands — a substitute, or a headless bot to hold a seat
    // overnight — votes one in with ROSTER_AMEND once the game is running,
    // which every peer sees and the seat cap limits. The host composing seats
    // nobody else agreed to is precisely what that vote exists to prevent.
    const empires: EmpireSpec[] = plan.empires.map((keys) => ({
      control: CONTROL.HUMAN,
      members: keys.map((key) => ({ kind: MEMBER.HUMAN, key })),
    }));
    for (const level of plan.simbots) empires.push(simbot(level));

    const genesis = makeGenesis({
      seed: seedFrom(`${this.code}:${Date.now()}`),
      // Every peer derives the step number from this and its own clock, so a
      // peer whose clock runs fast simply waits for the others. Skew costs
      // responsiveness, never agreement.
      startedAt: Date.now(),
      map: { width: plan.width, height: plan.height },
      ...(plan.duration ? { rules: plan.duration } : {}),
      empires,
    });

    const sealed = await sealGenesis(genesis);
    this.connection.broadcast({ t: FRAME.GENESIS, genesis: sealed });
    await this.adopt(sealed);
    return true;
  }

  /** Play a record that already exists, rather than composing one.
   *
   *  This is the other half of the rejoin flow (0007). `resolve` ends at a
   *  verified resume point for a game whose doors have all closed, and the
   *  caller then needs a lobby around *that game's* record — not a new one. Only
   *  `host` could produce a playing lobby before this, and `host` composes, so a
   *  tab that had a perfectly good genesis and a quorum of signatures for a
   *  state had no way to sit down in it.
   *
   *  It grants nothing. The record goes through the same `adopt` every joiner's
   *  does — `inspectGenesis`, the `expect` comparison, the seat lookup — and the
   *  state that follows is checked by `Lockstep.resume`, which counts the
   *  witnesses and hashes the bytes. Reviving a game you invented gets you a
   *  room with you in it, which is what hosting already was.
   *
   *  Broadcast as well as adopted, because a reviver is a door: anyone who
   *  dials this room while it is up is owed the record, exactly as they would
   *  be by the peer that originally sealed it. */
  async revive(genesis: Genesis): Promise<boolean> {
    this.connection.broadcast({ t: FRAME.GENESIS, genesis });
    await this.adopt(genesis);
    return this.phase === "playing";
  }

  /** Check the record before agreeing to play it, then find our own seat. An
   *  unkeyed peer, or one whose key is not in the roster, is an observer —
   *  which needs no mechanism beyond not being listed. */
  private async adopt(genesis: Genesis): Promise<void> {
    const problems = await inspectGenesis(genesis);
    if (problems.length > 0) {
      this.fail(`refused the game: ${problems.join(", ")}${explain(genesis, problems)}`);
      return;
    }

    // `inspectGenesis` asks whether a record is *self*-consistent: it hashes to
    // the id it carries. That is the whole question when a human typed the code,
    // and half of it when a directory supplied one. A room that hands us a
    // different game has done nothing malformed — it composed its record
    // correctly — and the only thing that catches it is this comparison against
    // what we looked up.
    if (this.expect && genesis.gameId !== this.expect) {
      this.fail(
        `that room is running a different game — ${this.shareable} was listed as ` +
          `${short(this.expect)} and answered with ${short(genesis.gameId)}`,
      );
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

    this.onStart?.(genesis, seat, this.baseTransport());
  }

  /** The page's one view of the connection. Its listener is routed through the lobby
   *  so frames that arrived early are not lost. */
  private baseTransport(): Transport {
    const connection = this.connection;
    return {
      id: connection.id,
      peers: () => connection.peers(),
      broadcast: (frame) => connection.broadcast(frame),
      send: (to, frame) => connection.send(to, frame),
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
    this.connection.close();
  }
}
