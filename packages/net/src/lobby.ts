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
  VACANCY_RULES,
  makeGenesis,
  seedFrom,
  simbot,
} from "@tessera/sim";
import type { BannerId, BotChoice, DurationRules, EmpireSpec, Genesis } from "@tessera/sim";
import {
  FRAME,
  Identity,
  composeGenesis,
  cleanName,
  fingerprint,
  inspectGenesis,
  proposalId,
  proposalOf,
  randomBytes,
  sealGenesis,
  signConsent,
  toBase64Url,
  verifyConsent,
} from "@tessera/protocol";
import type {
  Frame,
  HelloFrame,
  MemberKey,
  Proposal,
  SignedConsent,
} from "@tessera/protocol";
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

/** Where the arranging has got to.
 *
 *  `composing` and `starting` exist because a consented game has two moments
 *  the old flow did not. A proposal on the table is not yet a game, and a record
 *  sealed for a future instant is a game that has not begun — `targetStep`
 *  clamps at zero, so it sits there correctly with no new simulation code, but a
 *  screen that said "playing" would be showing a frozen board and calling it
 *  live. `onStart` fires on the way out of `starting`, never on the way in. */
export type LobbyPhase =
  | "connecting"
  | "hosting"
  | "waiting"
  | "composing"
  | "starting"
  | "playing"
  | "failed";

/** A world on the table, as a screen wants to read it. */
export interface Tabled {
  id: string;
  proposal: Proposal;
  /** Monotonic per proposer; a later one supersedes. */
  rev: number;
  by: MemberKey;
  /** Keys that have signed this exact world. */
  signers: MemberKey[];
  /** Whether we are among them. */
  mine: boolean;
}

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
  /** What they would like to be called, **unverified**.
   *
   *  A lobby hello proves nothing beyond "here is a key to seat me under", and
   *  a name on one has exactly the same standing as the key beside it: a claim,
   *  not yet a fact. There is no game id to sign against — this is the one
   *  moment in the protocol where that is true. Once a record is sealed, seats
   *  re-assert their names as signed records and the claim becomes
   *  attributable; until then a screen showing this must say so.
   *
   *  Cleaned on arrival like any other string off the wire. */
  name: string;
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
  /** Empires left unclaimed, for somebody to arrive into once the game is
   *  running. A count rather than an empty entry in `empires`, so that an empty
   *  entry stays the mistake it always was. */
  vacancies?: number;
  /** Which house each empire flies, parallel to the composed empire order.
   *  Presentation only — the simulation never reads it — but it rides in the
   *  genesis because every peer must present the *same* board. */
  banners?: readonly (BannerId | undefined)[];
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
  /** The record was adopted: here is the game, your seat in it, and the wire.
   *
   *  Fires the moment a record is accepted, **including one sealed for an
   *  instant that has not arrived**. A driver built early is correct — it sits
   *  at step 0 because `targetStep` clamps there, it archives, it serves the
   *  room, and a host process that waited for the instant before coming up
   *  would be a room nobody could reach during the countdown.
   *
   *  What must not happen early is a *screen* claiming the game is running. That
   *  is `phase` — `starting` until the instant, `playing` after — and `onBegin`
   *  below, which is the moment a view swaps.
   *
   *  `seat` is undefined for an observer — a peer whose key is not in the
   *  roster. It follows, verifies and archives the game like anyone else, and
   *  can be voted a seat later by ROSTER_AMEND. */
  onStart?: (genesis: Genesis, seat: Seat | undefined, transport: Transport) => void;
  /** The agreed instant arrived and the game is live. Fires immediately after
   *  `onStart` for a record sealed for now, which is every record composed
   *  before 0009 and every one the old `host` path still produces. */
  onBegin?: () => void;

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
  /** Unverified lobby names, by key. Cleared into nothing at the seal — the
   *  driver's signed namings take over, and holding both would leave a screen
   *  showing a claim after there was something better to show. */
  private readonly claimed = new Map<MemberKey, string>();
  /** What we would like to be called, sent on every hello. */
  private mine = "";

  /** Worlds on the table, by proposer. One each: a later `rev` from the same
   *  key supersedes, and a different proposer is a different proposal that the
   *  screen shows alongside. Nothing arbitrates between them, because nothing
   *  has to — a proposal nobody signs dies of that. */
  private readonly tabled = new Map<MemberKey, { id: string; proposal: Proposal; rev: number }>();
  /** Signatures held per proposal id. Nobody's copy is authoritative; a sealer
   *  seals the set it happens to hold, and everyone verifies the result. */
  private readonly signatures = new Map<string, Map<MemberKey, SignedConsent>>();
  /** Every world we have put our own name to.
   *
   *  A set rather than a single id, and that matters: we may consent to rev 4,
   *  the proposer may revise, and a sealer may legitimately seal the earlier
   *  world with the signatures it had. What we must never accept is a record we
   *  are seated in having signed nothing that composes to it. */
  private readonly signed = new Set<string>();
  /** The instant a sealed record begins, while we are waiting for it. */
  private countdown?: ReturnType<typeof setTimeout>;

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

  /** Whether this peer is the room rather than a guest in one.
   *
   *  Not derivable from `phase`, which says where the arranging has got to and
   *  becomes `playing` for everybody; not derivable from `ref` either, since a
   *  host has one of those too. It is the same fact the constructor took as
   *  `joined`, said the way a caller wants to ask it: whoever announces a door
   *  to an address book is promising to keep it open, and a guest cannot
   *  promise that about somebody else's room. */
  get hosting(): boolean {
    return !this.joined;
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
    // Pre-game arrival, which in a persistent room is the interesting case: the
    // proposal went out before this peer was here, and a broadcast reaches
    // whoever happened to be connected in that instant. Re-sent for the same
    // reason `sealed` is — somebody who cannot see the world on the table cannot
    // sign it, and would sit in a room watching nothing happen.
    for (const [by, one] of this.tabled) {
      this.connection.send(peer, { t: FRAME.PROPOSAL, proposal: one.proposal, rev: one.rev, by });
      for (const signed of this.signatures.get(one.id)?.values() ?? []) {
        this.connection.send(peer, { t: FRAME.CONSENT, signed });
      }
    }
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
      name: this.mine,
      you: true,
    };
    const others = [...this.members.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([peer, key]) => ({
        peer,
        key,
        label: this.labels.get(key) ?? peer.slice(0, 8),
        name: this.claimed.get(key) ?? "",
        you: false,
      }));
    return [mine, ...others];
  }

  /** What to call us in this room, before there is a game to sign it against.
   *  Re-greets everybody already here, because a hello is the only thing
   *  carrying it and one was already sent to each of them. */
  setName(name: string): void {
    const clean = cleanName(name);
    if (clean === this.mine) return;
    this.mine = clean;
    if (clean) this.claimed.set(this.identity.key, clean);
    else this.claimed.delete(this.identity.key);
    for (const peer of this.connection.peers()) this.greet(peer);
    this.changed();
  }

  /** What we are calling ourselves here. */
  get name(): string {
    return this.mine;
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
      ...(this.mine ? { name: this.mine } : {}),
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
        const claimed = cleanName(frame.name);
        if (claimed) this.claimed.set(frame.key, claimed);
        void this.label(frame.key);
        this.changed();
      }
      return;
    }
    if (frame.t === FRAME.PROPOSAL) {
      void this.tableFrom(frame.proposal, frame.rev, frame.by);
      return;
    }
    if (frame.t === FRAME.CONSENT) {
      void this.take(frame.signed);
      return;
    }
    if (frame.t === FRAME.GENESIS && this.phase !== "playing" && this.phase !== "starting") {
      void this.adopt(frame.genesis);
      return;
    }

    if (this.handler) this.handler(from, frame);
    else if (this.backlog.length < 4096) this.backlog.push({ from, frame });
  }

  // --- composing together --------------------------------------------------

  /** Put a world on the table. Anybody may; nothing arbitrates.
   *
   *  A revision is a counter-proposal — "make it three days" stops being a thing
   *  you say in chat and hope for, and becomes a rev with one field changed that
   *  everybody can see and sign. Revising abandons the signatures over the
   *  previous world, which is correct: they were signatures over a different
   *  game.
   *
   *  Consents to our own proposal are ours to give like anybody's. The proposer
   *  is not a host and does not sign by proposing — somebody putting a world up
   *  to see who wants it is a legitimate thing to do. */
  async propose(proposal: Proposal): Promise<string | undefined> {
    let id: string;
    try {
      id = await proposalId(proposal);
    } catch {
      // A non-finite number somewhere in the world. Unhashable is unsignable.
      this.problem = "that game cannot be described in a record";
      this.changed();
      return undefined;
    }
    const before = this.tabled.get(this.identity.key);
    const rev = before ? before.rev + 1 : 0;
    this.tabled.set(this.identity.key, { id, proposal, rev });
    if (this.phase === "hosting" || this.phase === "waiting") this.phase = "composing";
    this.connection.broadcast({ t: FRAME.PROPOSAL, proposal, rev, by: this.identity.key });
    this.changed();
    return id;
  }

  /** Sign a world, meaning *I will play this*.
   *
   *  One signature, and there is no second to collect. It carries no game id
   *  because there is no game: the proposal hash stands in that slot, which
   *  works only because a proposal cannot recur — the seed is random, so two
   *  identical-looking worlds in two rooms are distinct objects and a consent
   *  cannot be lifted out of one into the other. */
  async consent(id: string): Promise<boolean> {
    const table = [...this.tabled.values()].find((one) => one.id === id);
    if (!table) return false;
    const signed = await signConsent(this.identity, id);
    this.signed.add(id);
    this.hold(signed);
    this.connection.broadcast({ t: FRAME.CONSENT, signed });
    this.changed();
    return true;
  }

  /** Every world on the table, newest proposer order aside, with who has signed
   *  each. What a screen renders, and the only reason `tabled` is private. */
  proposals(): Tabled[] {
    return [...this.tabled.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([by, one]) => ({
        id: one.id,
        proposal: one.proposal,
        rev: one.rev,
        by,
        signers: [...(this.signatures.get(one.id)?.keys() ?? [])].sort(),
        mine: this.signed.has(one.id),
      }));
  }

  /** Compose the record from a world and whoever signed it, and broadcast it.
   *
   *  This is the one clerical act. What the sealer demonstrably cannot do is
   *  change a rule, seat a non-signer, invent a player or reorder the roster —
   *  every one of those fails `checkConsent` at every peer that reads the
   *  record. What is left to it is deciding who was late, which is the one power
   *  a doorman is supposed to have.
   *
   *  It seals the set it holds. Two peers holding different sets seal different
   *  games, which is why somebody has to say "sealed" and why it does not matter
   *  much who. */
  async seal(id?: string): Promise<boolean> {
    const table = id
      ? [...this.tabled.values()].find((one) => one.id === id)
      : this.tabled.get(this.identity.key);
    if (!table) {
      this.problem = "there is no proposal to seal";
      this.changed();
      return false;
    }
    const consents = [...(this.signatures.get(table.id)?.values() ?? [])];
    if (consents.length === 0) {
      this.problem = "nobody has signed that game";
      this.changed();
      return false;
    }

    const sealed = await sealGenesis(composeGenesis(table.proposal, consents));
    this.connection.broadcast({ t: FRAME.GENESIS, genesis: sealed });
    await this.adopt(sealed);
    return this.phase === "playing" || this.phase === "starting";
  }

  /** Somebody else's world, taken onto the table.
   *
   *  The id is recomputed here rather than trusted: a proposer that named an id
   *  its own proposal does not hash to would have every consent signed against a
   *  world nobody can reconstruct. `decodeFrame` has already refused the numbers
   *  that would make this throw, and it is wrapped anyway — the cost of being
   *  wrong is an unhandled rejection in a receive path. */
  private async tableFrom(proposal: Proposal, rev: number, by: MemberKey): Promise<void> {
    const before = this.tabled.get(by);
    // Supersede by revision, and never backwards: a replayed earlier proposal
    // must not unseat the one everybody is signing.
    if (before && rev <= before.rev) return;
    let id: string;
    try {
      id = await proposalId(proposal);
    } catch {
      return;
    }
    this.tabled.set(by, { id, proposal, rev });
    if (this.phase === "hosting" || this.phase === "waiting") this.phase = "composing";
    void this.label(by);
    this.changed();
  }

  /** Keep a consent if it is one, ignore it if it is not. Verified against the
   *  proposal it names before it is held, so a sealer never seals junk and a
   *  screen never shows a signer who did not sign. */
  private async take(signed: SignedConsent): Promise<void> {
    if (!signed || typeof signed.proposalId !== "string") return;
    // Signatures for a world nobody here has proposed are kept anyway: the
    // proposal and the consents race, and a room is a place people arrive into.
    if (!(await verifyConsent(signed, signed.proposalId))) return;
    this.hold(signed);
    this.changed();
  }

  private hold(signed: SignedConsent): void {
    let held = this.signatures.get(signed.proposalId);
    if (!held) this.signatures.set(signed.proposalId, (held = new Map()));
    held.set(signed.key, signed);
    void this.label(signed.key);
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
    // Parallel to the composed order below: human empires, then vacancies, then
    // SimBots. A slot that is empty means fall back to the index, which is what
    // every record written before banners existed means.
    const banners = plan.banners ?? [];
    let at = 0;
    const flag = (): BannerId | undefined => banners[at++];

    const empires: EmpireSpec[] = plan.empires.map((keys) => {
      const banner = flag();
      return {
        control: CONTROL.HUMAN,
        // Omitted when unset and never `null`: `canonicalJson` keeps `null` and
        // drops `undefined`, so the two spellings would hash to different game
        // ids while meaning the same thing.
        ...(banner ? { banner } : {}),
        members: keys.map((key) => ({ kind: MEMBER.HUMAN, key })),
      };
    });
    const vacancies = plan.vacancies ?? 0;
    // Empires the map generator will place and nobody has claimed. Territory
    // rather than players: they get a capital and separation from the shared
    // seed, before anyone knows who will sit there, which is precisely what
    // makes arriving into one fair — a claimant takes the ground the map gave
    // that empire, not the best ground still going.
    //
    // An empty members array and nothing else, deliberately. That is already an
    // error to every build written before vacancies, so an older peer handed
    // this record declines rather than desyncing — the outcome a version bump
    // exists to produce, which is why this needs none.
    for (let i = 0; i < vacancies; i++) {
      // A vacancy is **not pre-branded**. Its banner arrives with whoever
      // claims it, in the claim record, which is the difference between "you
      // may play as Sping if the composer happened to seal Sping" and "you play
      // as Sping, in whichever house is empty".
      flag();
      empires.push({ control: CONTROL.HUMAN, members: [] });
    }
    for (const level of plan.simbots) empires.push(simbot(level, flag()));

    const genesis = makeGenesis({
      seed: seedFrom(`${this.code}:${Date.now()}`),
      // Every peer derives the step number from this and its own clock, so a
      // peer whose clock runs fast simply waits for the others. Skew costs
      // responsiveness, never agreement.
      startedAt: Date.now(),
      map: { width: plan.width, height: plan.height },
      // The vacancy rules travel with the vacancies and never without them.
      //
      // Two of them change `isProtected` for any game at all, and a field in
      // `rules` is read straight past by an older build — so a game with no
      // unclaimed empires carries none of them, and its rules are byte-identical
      // to what every build before this one composed. A game *with* them carries
      // an empty members array too, which that older build refuses outright, so
      // it is never in the position of half-agreeing. See `VACANCY_RULES`.
      ...(plan.duration || vacancies > 0
        ? { rules: { ...(vacancies > 0 ? VACANCY_RULES : {}), ...plan.duration } }
        : {}),
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
    // `starting` counts: the record was accepted, and a game sealed for an
    // instant that has not arrived is adopted rather than refused.
    return this.phase === "playing" || this.phase === "starting";
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

    // The half `inspectGenesis` cannot do.
    //
    // It is stateless, so it can ask "does every signature in this list cover
    // the world this record composes" and it cannot ask "was *I* meant to be in
    // this". And the gap matters: sealing a subset of the consents is a valid
    // record — it is exactly the power the sealer is granted — so a peer left
    // out of one would pass every check and quietly become an observer of the
    // game it had agreed to play. Only the peer that signed can notice its own
    // absence, which is why this lives here and not in the verifier.
    if (this.signed.size > 0) {
      const world = proposalOf(genesis);
      const id = world ? await this.hashOf(world) : undefined;
      if (id !== undefined && this.signed.has(id)) {
        const listed = (genesis.consent ?? []).some((one) => one.key === this.identity.key);
        if (!listed) {
          this.fail(
            "the sealed game does not carry your signature — you agreed to that world, " +
              "and the record that came back seats somebody else in it",
          );
          return;
        }
      }
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

    // A record sealed for a future instant is a game that has not begun, and
    // the two halves of that come apart here. The driver is built now — it sits
    // at step 0 because `targetStep` clamps there, and a peer that waited would
    // be a room nobody could reach during the countdown. The *phase* is what
    // holds: `starting` until the instant, so nothing tells a player a frozen
    // board is live.
    const wait = genesis.startedAt - this.now();
    this.phase = wait > 0 ? "starting" : "playing";
    this.changed();
    this.onStart?.(genesis, seat, this.baseTransport());

    if (wait <= 0) {
      this.onBegin?.();
      return;
    }
    this.countdown = setTimeout(() => this.begin(), wait);
    this.countdown.unref?.();
  }

  /** The instant a game sealed for later actually starts. */
  private begin(): void {
    this.countdown = undefined;
    if (this.phase !== "starting") return;
    this.phase = "playing";
    this.changed();
    this.onBegin?.();
  }

  /** How long until a game sealed for a future instant begins, in
   *  milliseconds, or 0 when it already has. What a countdown renders. */
  get startsIn(): number {
    return Math.max(0, (this.sealed?.startedAt ?? 0) - this.now());
  }

  /** Wall clock, in one place so a test can hold it still. */
  private now(): number {
    return Date.now();
  }

  private async hashOf(world: Proposal): Promise<string | undefined> {
    try {
      return await proposalId(world);
    } catch {
      return undefined;
    }
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
    if (this.countdown !== undefined) clearTimeout(this.countdown);
    this.countdown = undefined;
    this.connection.close();
  }
}
