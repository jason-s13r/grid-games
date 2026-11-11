// The game room: the one place a game's moves are put in order.
//
// Every client runs the full simulation on its own clock and validates every
// move, so the room decides nothing about the rules. What it decides is *when*:
// a move is stamped, the moment it arrives, with a step a little ahead of now
// (LEAD_STEPS), and broadcast at once. Nothing is ever stamped below a step
// already handed out, so every step before the current lead is final, and a
// client that simulates up to "now" has every move it needs.
//
// The room acts only when a message arrives. It keeps the log and a snapshot so
// a client arriving late or coming back tomorrow can be caught up, and it runs
// its own copy of the simulation lazily, catching up to now when it needs an
// answer: for a newcomer, a hash comparison, or a seat. Between messages it
// does nothing at all, which is what lets a Durable Object hosting it sleep.
//
// It has no timer, socket or database of its own. Whatever hosts it hands it
// connections and messages, calls `tick()` at `wakeAt()` for a scheduled start,
// and supplies a store.

import {
  CONTROL,
  MEMBER,
  MOVE,
  SEAT_CEILING,
  SIM_VERSION,
  Sim,
  durationRules,
  hex,
  makeGenesis,
  minutes,
  simbot,
  STEPS_PER_SECOND,
} from "@tessera/sim";
import type { BannerId, EmpireSpec, Genesis, Move } from "@tessera/sim";
import { BANNERS, bannerAt, bannerById, flyBanners, isVacant } from "@tessera/sim";
import { thumbnail } from "./thumb.js";
import { FRAME_WIDTH, KEY_EVERY, encodeFrame, frameEvery } from "./frames.js";
import type { Timeline } from "./frames.js";
import type { SignedInvite } from "@tessera/protocol";
import {
  NONCE_BYTES,
  Roster,
  verifyInvite,
  cleanName,
  fromBase64Url,
  inspectGenesis,
  randomBytes,
  sealGenesis,
  toBase64Url,
  verifyHello,
  verifyMove,
} from "@tessera/protocol";
import { SNAPSHOT_EVERY, advanceTo, stepAt } from "./advance.js";
import { CHAT_MODES, decode, encode } from "./messages.js";
import { resultOf, timeOf } from "./record.js";
import type { GameArchive, GameResult, GameSummary, RoomEvents } from "./record.js";
import type {
  Catchup,
  ClaimedFlag,
  GameSettings,
  ChatMode,
  ClientMessage,
  LobbyPlayer,
  ChatLine,
  LobbyView,
  People,
  Phase,
  RoomConfig,
  ServerMessage,
  Stamped,
  You,
} from "./messages.js";
import type { RoomStore } from "./store.js";

/** How far ahead of now a move is stamped: half a second. A client that
 *  simulates up to now therefore has half a second for a move to reach it
 *  before it is needed; one that arrives later than that is replayed. */
export const LEAD_STEPS = 6;

/** One open socket, as the host sees it. */
export interface Connection {
  readonly id: string;
  send(text: string): void;
}

export interface RoomOptions {
  now?: () => number;
  /** Where the room reports listings, players and results. */
  events?: RoomEvents;
}

/** How often a running game with nobody in it wakes to see whether it has
 *  ended: an abandoned table ends on the sim's own clock, and nobody would
 *  otherwise be there to notice. Hourly, so that a wake never has much to
 *  simulate and a snapshot is never far behind for somebody arriving. */
const CHECK_EVERY_MS = 3600_000;

/** The most the room simulates in one go: an hour of game. A host gives each
 *  call a fixed allowance of CPU (a Durable Object, thirty seconds), and on a
 *  large map with bots late in a game twelve hours took most of that on a
 *  fast machine. Going over gets the room thrown away mid-way, so it never
 *  gets any further: its alarm fails until the host gives up on it, and every
 *  hello fails the same way. Anything left over is done on the next wake,
 *  which `wakeAt` asks for straight away. */
export const MAX_ADVANCE = STEPS_PER_SECOND * 3600;

interface Peer {
  conn: Connection;
  nonce: Uint8Array;
  key?: string;
  /** Messages from one socket are handled in arrival order, one at a time. */
  queue: Promise<void>;
}

/** A seat given after the start, in the order it was given. The roster is the
 *  genesis plus these, replayed. */
interface StoredSeating {
  empire: number;
  key: string;
  step: number;
  /** A program playing the seat. Absent in seatings stored before bots. */
  bot?: boolean;
  /** The house a claimant brought to a vacancy, when it was free to fly. */
  banner?: BannerId;
}

interface StoredPlayer {
  key: string;
  name: string;
  /** The house picked in the lobby. */
  banner: BannerId | null;
  /** Said so in its hello: a program, not a person. */
  bot?: boolean;
}

/** A player stored before houses were picked had an empire index instead,
 *  and picked the house at that index, which is the one it was shown. */
function housed(player: StoredPlayer & { empire?: number | null }): StoredPlayer {
  if (player.banner !== undefined) return player;
  const { empire, ...rest } = player;
  const banner = typeof empire === "number" ? (bannerAt(empire + 1)?.id ?? null) : null;
  return { ...rest, banner };
}

/** The listings' map is sent no more often than this while a game runs: it
 *  is a database write each time, and a busy room snapshots every couple of
 *  game minutes. Hourly wakes and the start and end are always sent. */
export const MAP_EVERY_MS = 10 * 60_000;

/** Chat lines kept, for whoever arrives later. */
const KEEP_CHAT = 200;
/** The longest line, in characters, and the shortest gap between one
 *  speaker's lines. */
const CHAT_MAX = 500;
const CHAT_GAP_MS = 400;
/** Lines to everyone come no closer than this from one seat. */
const CHAT_GAP_ALL_MS = 2000;
/** The same line again within this is dropped. */
const REPEAT_MS = 30_000;
/** Steps in a seat before a public game's open chat (two minutes). */
const PUBLIC_CHAT_AFTER = 2 * 60 * 12;

/** Links out of a chat line, `[link]` in their place: anything with a scheme,
 *  a www., or a dotted name ending in a word of letters (example.com/x). */
export function withoutLinks(text: string): string {
  return text
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s,;!?)]+/gi, "[link]")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/[^\s,;!?)]*)?/gi, (match) => (/^\d+(\.\d+)*$/.test(match) ? match : "[link]"));
}

/** Recent checkpoint hashes kept for comparison. */
const KEEP_CHECKPOINTS = 64;

export class Room {
  private readonly now: () => number;
  private readonly events: RoomEvents;
  private readonly config: RoomConfig;
  private readonly peers = new Map<string, Peer>();

  private _phase: Phase;
  /** See `behind`. */
  private cutShort = false;
  private players: StoredPlayer[];
  private startsAt: number | undefined;
  private starting = false;

  private genesis?: Genesis;
  private roster?: Roster;
  private sim?: Sim;
  /** The room's own simulation step. */
  private next = 0;
  /** Logged moves the room's simulation has not reached yet. */
  private future: Stamped[] = [];
  /** The highest step handed out. Nothing is stamped below it. */
  private lastStamp = 0;
  private seqs: Record<string, number>;
  private readonly beats = new Map<string, number>();
  private seatings: StoredSeating[];
  private requests: Array<{ key: string; empire: number }>;
  private usedInvites: string[];
  private chat: ChatLine[];
  private readonly spoke = new Map<string, number>();
  private readonly saidLast = new Map<string, { text: string; at: number }>();
  private readonly checkpoints = new Map<number, number>();
  /** The result has been reported. */
  private finished: boolean;

  /** Set up a new room's storage. The room itself is built with `new Room`. */
  static create(store: RoomStore, config: RoomConfig): void {
    if (store.get("config")) throw new Error("room already exists");
    store.put("config", config);
    store.put("phase", "lobby");
    store.put("players", []);
    // A new room reports its players as they arrive.
    store.put("recorded", true);
    if (config.startAt !== undefined) store.put("startsAt", config.startAt);
  }

  constructor(
    private readonly store: RoomStore,
    options: RoomOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.events = options.events ?? {};
    const config = store.get<RoomConfig>("config");
    if (!config) throw new Error("no room in this store");
    this.config = config;
    this._phase = store.get<Phase>("phase") ?? "lobby";
    this.players = (store.get<Array<StoredPlayer & { empire?: number | null }>>("players") ?? []).map(housed);
    this.startsAt = store.get<number | null>("startsAt") ?? undefined;
    this.seqs = store.get<Record<string, number>>("seqs") ?? {};
    this.seatings = store.get<StoredSeating[]>("seatings") ?? [];
    this.requests = store.get<Array<{ key: string; empire: number }>>("requests") ?? [];
    this.usedInvites = store.get<string[]>("invites") ?? [];
    // Not stored on every stamp: the log's last step says the same thing.
    this.lastStamp = Math.max(store.get<number>("lastStamp") ?? 0, store.lastStep());
    this.chat = store.get<ChatLine[]>("chat") ?? [];
    this.finished = store.get<boolean>("finished") ?? false;

    const genesis = store.get<Genesis>("genesis");
    if (genesis) this.load(genesis);
    this.backfillRecords();
  }

  /** Games that began before the records did have nobody in them on record,
   *  so they are missing from their players' lists. Report everyone in the
   *  game once, the first time such a room wakes. */
  private backfillRecords(): void {
    if (!this.events.player || this.store.get<boolean>("recorded")) return;
    this.store.put("recorded", true);
    if (this.finished) return;
    this.events.game?.(this.summary());
    for (const player of this.players) {
      if (this._phase === "lobby" || this.roster?.seatOf(player.key)) this.recordPlayer(player.key);
    }
  }

  get phase(): Phase {
    return this._phase;
  }

  get id(): string {
    return this.config.roomId;
  }

  get step(): number {
    return this.next;
  }

  /** The room's own state hash, for comparison in tests and tools. */
  hash(): number | undefined {
    return this.sim?.hash();
  }

  get ended(): boolean {
    return this.sim?.ended ?? false;
  }

  /** Bring the room's own simulation up to now, or as far towards it as one
   *  call may go (MAX_ADVANCE). The room does this itself whenever it needs
   *  an answer; it is public for tools and tests. */
  catchUp(): number {
    if (this.genesis) this.advance(stepAt(this.genesis.startedAt, this.now()));
    return this.next;
  }

  /** The last advance stopped at MAX_ADVANCE short of where it was going. */
  get behind(): boolean {
    return this.cutShort;
  }

  /** When the room next needs a `tick()`: the scheduled start, if there is
   *  one, and while a game runs, its end and an hourly check for a table that
   *  has ended on its own. On a fixed grid from the start, so the answer does
   *  not move between calls and the host need not reset an alarm on every
   *  message. A room still catching up wants waking again now. */
  wakeAt(): number | undefined {
    if (this._phase === "lobby") return this.startsAt;
    if (this.finished || !this.genesis) return undefined;
    if (this.cutShort) return this.now();
    const start = this.genesis.startedAt;
    const next = start + (Math.floor((this.now() - start) / CHECK_EVERY_MS) + 1) * CHECK_EVERY_MS;
    const end = this.endsAt();
    // And once when the join window closes, to see whether anybody came.
    const joins = this.joinUntil();
    const soon = joins !== undefined && joins > this.now() ? Math.min(next, joins) : next;
    return end === undefined ? soon : Math.min(soon, end + 1000);
  }

  /** When nobody new can take a seat any more: the end of the join window, or
   *  the start for a game without one. Undefined before the game starts. */
  private joinUntil(): number | undefined {
    const genesis = this.genesis;
    if (!genesis) return undefined;
    const window = genesis.rules.joinWindow ?? 0;
    return window > 0 ? timeOf(genesis.startedAt, window) : genesis.startedAt;
  }

  /** Nobody is going to play this game: joining has closed and no person (as
   *  opposed to a bot) holds a seat, or its scheduled start came with nobody
   *  having picked an empire. The host deletes such a game outright; there is
   *  nothing in it worth keeping. */
  deserted(): boolean {
    if (this.finished) return false;
    const now = this.now();
    if (this._phase === "lobby") {
      const at = this.config.startAt;
      return at !== undefined && now >= at && !this.players.some((p) => p.banner !== null && !p.bot);
    }
    const joins = this.joinUntil();
    if (joins === undefined || now < joins || !this.roster) return false;
    return !this.roster.all().some((seat) => !this.isBot(seat.key));
  }

  /** The game as a listing shows it. */
  summary(): GameSummary {
    const { config } = this;
    const summary: GameSummary = {
      roomId: config.roomId,
      creator: config.creator,
      public: config.public ?? false,
      phase: this.finished ? "ended" : this._phase,
      createdAt: config.createdAt ?? 0,
      map: config.map,
      empires: config.empires,
      seatsPerEmpire: this.seatsPerEmpire(),
      bots: config.bots.length,
      // Seats taken: in the lobby, those who have picked a house, not
      // everybody who has looked in.
      players: this.roster
        ? this.players.filter((p) => this.roster!.has(p.key)).length
        : this.players.filter((p) => p.banner !== null).length,
    };
    if (this.startsAt !== undefined && this._phase === "lobby") summary.startsAt = this.startsAt;
    if (this._phase === "lobby") summary.lobby = this.players.length;
    const genesis = this.genesis;
    if (genesis) {
      summary.startedAt = genesis.startedAt;
      summary.simVersion = SIM_VERSION;
      const window = genesis.rules.joinWindow ?? 0;
      if (window > 0) summary.joinUntil = timeOf(genesis.startedAt, window);
      const end = this.endsAt();
      if (end !== undefined) summary.endsAt = end;
      if (this.finished && this.sim) summary.endedAt = timeOf(genesis.startedAt, this.sim.step);
    }
    return summary;
  }

  private endsAt(): number | undefined {
    const genesis = this.genesis;
    if (!genesis || genesis.rules.endStep <= 0) return undefined;
    return timeOf(genesis.startedAt, genesis.rules.endStep);
  }

  // --- connections -----------------------------------------------------------

  connect(conn: Connection): void {
    const nonce = randomBytes(NONCE_BYTES);
    this.peers.set(conn.id, { conn, nonce, queue: Promise.resolve() });
    this.sendTo(conn, { t: "challenge", nonce: toBase64Url(nonce) });
  }

  /** Take back a socket that was already open before this room object existed:
   *  a Durable Object woken from hibernation has its sockets but not their
   *  state. A socket that had proved its key keeps it; one that had not is
   *  challenged again. */
  reattach(conn: Connection, key?: string): void {
    if (!key) return this.connect(conn);
    this.peers.set(conn.id, { conn, nonce: randomBytes(NONCE_BYTES), key, queue: Promise.resolve() });
  }

  /** The key a socket has proved, if it has. A host persists this beside the
   *  socket so `reattach` can restore it. */
  keyOf(id: string): string | undefined {
    return this.peers.get(id)?.key;
  }

  disconnect(id: string): void {
    const peer = this.peers.get(id);
    this.peers.delete(id);
    if (!peer?.key) return;
    if (this._phase === "lobby") this.broadcastLobby();
    else if (!this.connectedKeys().has(peer.key)) this.broadcastPeople();
  }

  /** Handle one message from one socket. Resolves once it has been handled;
   *  messages from the same socket are handled in order. */
  receive(id: string, text: unknown): Promise<void> {
    const peer = this.peers.get(id);
    if (!peer) return Promise.resolve();
    const message = decode<ClientMessage>(text);
    if (!message) return Promise.resolve();
    peer.queue = peer.queue.then(() => this.handle(peer, message)).catch(() => {});
    return peer.queue;
  }

  private async handle(peer: Peer, message: ClientMessage): Promise<void> {
    if (message.t === "hello") return this.hello(peer, message);
    if (!peer.key) return;
    switch (message.t) {
      case "lobby":
        return this.lobbyChoice(peer.key, message);
      case "leave":
        return this.leave(peer);
      case "start":
        if (peer.key !== this.config.creator) return this.error(peer, "only the creator can start");
        return this.start(peer);
      case "move":
        return this.move(peer, message);
      case "hash":
        return this.compare(peer, message.step, message.hash);
      case "resume":
        if (this.genesis) this.sendTo(peer.conn, { t: "resync", game: this.catchup(message.have) });
        return;
      case "claim":
        return this.claim(peer, message.empire, message.banner);
      case "ask":
        return this.ask(peer, message.empire);
      case "withdraw":
        return this.dropRequest(peer.key);
      case "approve":
        return this.answer(peer, message.key, true);
      case "decline":
        return this.answer(peer, message.key, false);
      case "redeem":
        return this.redeem(peer, message.invite);
      case "name":
        return this.rename(peer.key, message.name);
      case "say":
        return this.say(peer, message.channel, message.text);
      case "public":
        return this.setPublic(peer, message.public);
      case "chat-mode":
        return this.setChatMode(peer, message.mode);
    }
  }

  private async hello(peer: Peer, message: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (peer.key) return;
    const theirs = fromBase64Url(message.nonce);
    if (!theirs || theirs.length !== NONCE_BYTES || typeof message.key !== "string") {
      return this.error(peer, "malformed hello");
    }
    const ok = await verifyHello(message.key, this.config.roomId, peer.nonce, theirs, message.proof);
    if (!ok) return this.error(peer, "hello proof did not verify");

    const bot = message.bot === true ? { bot: true } : {};
    if (this._phase === "lobby") {
      peer.key = message.key;
      const name = cleanName(message.name);
      const known = this.players.find((p) => p.key === message.key);
      if (known) {
        if (name) known.name = name;
        Object.assign(known, bot);
      } else {
        this.players.push({ key: message.key, name, banner: null, ...bot });
        this.recordPlayer(message.key);
        this.events.game?.(this.summary());
      }
      this.store.put("players", this.players);
      this.sendTo(peer.conn, {
        t: "welcome",
        phase: "lobby",
        you: this.you(message.key),
        lobby: this.lobbyView(),
      });
      this.sendChatHistory(peer);
      this.broadcastLobby();
      return;
    }

    // The key is set after the catch-up, so this client is not sent moves it
    // has no state to apply them to.
    this.catchUp();
    peer.key = message.key;
    const name = cleanName(message.name);
    const known = this.players.find((p) => p.key === message.key);
    if (!known) this.players.push({ key: message.key, name, banner: null, ...bot });
    else {
      if (name) known.name = name;
      Object.assign(known, bot);
    }
    this.store.put("players", this.players);
    this.sendTo(peer.conn, {
      t: "welcome",
      phase: "playing",
      you: this.you(message.key),
      game: this.catchup(message.have),
    });
    this.sendChatHistory(peer);
    this.broadcastPeople();
  }

  // --- the lobby -------------------------------------------------------------

  private lobbyChoice(key: string, message: Extract<ClientMessage, { t: "lobby" }>): void {
    if (this._phase !== "lobby") return;
    const player = this.players.find((p) => p.key === key);
    if (!player) return;
    if (message.name !== undefined) player.name = cleanName(message.name);
    const before = player.banner;
    const wanted =
      message.banner !== undefined
        ? message.banner
        : message.empire === null
          ? null
          : Number.isInteger(message.empire)
            ? bannerAt((message.empire as number) + 1)?.id
            : undefined;
    if (wanted === null) player.banner = null;
    else if (wanted !== undefined && this.canFly(key, wanted)) player.banner = wanted;
    this.store.put("players", this.players);
    if (player.banner !== before) {
      // The listing counts seats taken, and the player's own record says which.
      this.recordPlayer(key);
      this.events.game?.(this.summary());
    }
    this.broadcastLobby();
  }

  /** Whether `key` may pick `banner`: a house that exists, with a seat left in
   *  it, and — if nobody has picked it yet — a human empire left on the map to
   *  be. Moving from a house you have to yourself frees its empire first. */
  private canFly(key: string, banner: unknown): banner is BannerId {
    if (typeof banner !== "string" || !bannerById(banner)) return false;
    const others = this.players.filter((p) => p.key !== key && p.banner !== null);
    const here = others.filter((p) => p.banner === banner).length;
    if (here >= this.seatsPerEmpire()) return false;
    if (here > 0) return true;
    return new Set(others.map((p) => p.banner)).size < this.config.empires;
  }

  /** The houses picked, in the order their players arrived. Each is one
   *  empire, numbered in this order at the start. */
  private picked(): BannerId[] {
    const order: BannerId[] = [];
    for (const p of this.players) if (p.banner !== null && !order.includes(p.banner)) order.push(p.banner);
    return order;
  }

  /** Out of a game that has not started, altogether: its lobby, its count and
   *  the player's list of games. Coming back is joining again. A started game
   *  keeps its seats; leaving one is just closing the tab. */
  private leave(peer: Peer): void {
    if (this._phase !== "lobby" || !peer.key) return;
    const key = peer.key;
    const at = this.players.findIndex((p) => p.key === key);
    if (at < 0) return;
    this.players.splice(at, 1);
    this.store.put("players", this.players);
    peer.key = undefined;
    this.events.left?.(this.config.roomId, key);
    this.events.game?.(this.summary());
    this.broadcastLobby();
  }

  private seatsPerEmpire(): number {
    return Math.max(1, Math.min(this.config.seatsPerEmpire, SEAT_CEILING));
  }

  private lobbyView(): LobbyView {
    const online = this.connectedKeys();
    const players: LobbyPlayer[] = this.players.map((p) => ({
      ...p,
      connected: online.has(p.key),
    }));
    return {
      creator: this.config.creator,
      empires: this.config.empires,
      seatsPerEmpire: this.seatsPerEmpire(),
      bots: this.config.bots.length,
      players,
      ...(this.startsAt !== undefined ? { startsAt: this.startsAt } : {}),
    };
  }

  private broadcastLobby(): void {
    const lobby = this.lobbyView();
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, { t: "lobby", lobby });
    }
  }

  // --- starting --------------------------------------------------------------

  /** Seal the genesis record from the lobby and start the clock. `by` is the
   *  socket that asked, for error reporting; a scheduled start has none. */
  private async start(by?: Peer): Promise<void> {
    if (this._phase !== "lobby" || this.starting) return;
    this.starting = true;
    try {
      const genesis = await this.compose();
      if (typeof genesis === "string") {
        if (by) this.error(by, genesis);
        // A scheduled start that cannot happen stays a lobby, and stops trying.
        this.startsAt = undefined;
        this.store.put("startsAt", null);
        this.broadcastLobby();
        return;
      }

      this.store.put("genesis", genesis);
      this.store.put("phase", "playing");
      this._phase = "playing";
      this.load(genesis);
      this.keepSnapshot();
      if (this.framing()) this.recordFrame();

      for (const peer of this.peers.values()) {
        if (peer.key) {
          this.sendTo(peer.conn, { t: "start", genesis, you: this.you(peer.key), now: this.now() });
        }
      }
      this.broadcastPeople();
      for (const player of this.players) if (this.roster!.has(player.key)) this.recordPlayer(player.key);
      this.events.game?.(this.summary());
    } finally {
      this.starting = false;
    }
  }

  private async compose(): Promise<Genesis | string> {
    const { config } = this;
    const empires: EmpireSpec[] = [];
    // One empire per house picked, flying it. The players' choice is sealed
    // into the record; the empire number is only where on the map it sits.
    const houses = this.picked().slice(0, config.empires);
    for (const banner of houses) {
      const members = this.players
        .filter((p) => p.banner === banner)
        .map((p) => ({ kind: MEMBER.HUMAN, key: p.key }));
      empires.push({ control: CONTROL.HUMAN, members, banner });
    }
    if (houses.length < 1) return "nobody has picked a house";
    if (houses.length + config.bots.length < 2) return "a game needs at least two empires playing";
    // The rest are left open: placed by the map generator like any other, and
    // claimable during the join window. A vacancy is not given a house; its
    // claimant brings one, and until then it wears whatever is free.
    for (let i = houses.length; i < config.empires; i++) empires.push({ control: CONTROL.HUMAN, members: [] });
    // Bots fly houses nobody picked, from the far end of the table, so the
    // houses a newcomer is likeliest to want are still free to claim.
    const spare = BANNERS.filter((b) => !houses.includes(b.id)).reverse();
    config.bots.forEach((level, at) => empires.push(simbot(level, spare[at]?.id)));

    const seed = new DataView(randomBytes(4).buffer).getUint32(0);
    const genesis = await sealGenesis(
      makeGenesis({
        seed,
        startedAt: this.now(),
        map: config.map,
        rules: {
          ...durationRules(config.duration, config.joinShare),
          maxSeats: this.seatsPerEmpire(),
          // Presence, as the room stamps it for a connected seat. Every beat is
          // a row in the room's log, and the only thing that needs one this
          // often is the empire list's "live" dot; abandonment is measured in
          // hours. The sim's defaults (30s, 2min) were set for a mesh where
          // every peer paid for its own beats.
          heartbeatInterval: minutes(3),
          livenessWindow: minutes(5),
        },
        empires,
      }),
    );
    const problems = await inspectGenesis(genesis);
    if (problems.length) return `the game could not be composed: ${problems.join(", ")}`;
    return genesis;
  }

  /** Build the simulation for a started game from its snapshot, with the moves
   *  logged since waiting to be simulated. It is brought up to date when an
   *  answer needs it, not here: a room woken by one message often needs none.
   *
   *  The sequence numbers and heartbeat times kept since the snapshot are
   *  recovered from those same moves, which is what lets the room write them
   *  only with the snapshot rather than on every move. */
  private load(genesis: Genesis): void {
    this.genesis = genesis;
    this.roster = Roster.fromGenesis(genesis);
    for (const seating of this.seatings) {
      this.roster.amend(seating.empire, seating.key, seating.bot ? MEMBER.BOT : MEMBER.HUMAN, seating.step);
    }
    const sim = new Sim(genesis);
    const snapshot = this.store.latestSnapshot();
    let tail: Stamped[] = [];
    if (snapshot) {
      sim.restore(snapshot.bytes.slice().buffer);
      tail = this.store.movesFrom(snapshot.step);
    }
    this.sim = sim;
    this.next = sim.step;
    this.future = tail.filter((s) => s.move.step >= sim.step);

    for (const seat of this.roster.all()) this.beats.set(seat.key, sim.step);
    const presence = this.movesArePresence();
    for (const { move, sig } of tail) {
      const key = this.roster.keyOf(move.empire, move.member);
      if (!key) continue;
      if (move.type === MOVE.HEARTBEAT || (sig && presence)) {
        this.beats.set(key, Math.max(this.beats.get(key) ?? 0, move.step));
      }
      if (sig && move.seq > (this.seqs[key] ?? -1)) this.seqs[key] = move.seq;
    }
  }

  /** Whether the sim counts any move as its seat's presence: v4 on. */
  private movesArePresence(): boolean {
    return (this.genesis?.protocol ?? 0) >= 4;
  }

  /** The state at the room's step, and the sequence numbers that go with it. */
  private keepSnapshot(): void {
    const sim = this.sim!;
    this.store.putSnapshot({ step: sim.step, hash: sim.hash(), bytes: new Uint8Array(sim.snapshot()) });
    this.store.put("seqs", this.seqs);
    this.sendMap();
  }

  /** Whether this room keeps a timeline: a store that can hold one. */
  private framing(): boolean {
    return typeof this.store.putFrame === "function";
  }

  /** The last frame recorded, for the next to be a delta of. Held in memory
   *  only: a rebuilt room starts again with a key frame, and re-simulating
   *  from its snapshot rewrites frames it already had with the same cells,
   *  so the chain of deltas stays whole. One row written per frame. */
  private lastFrame: { step: number; cells: Uint8Array; sinceKey: number } | undefined;

  private recordFrame(): void {
    const sim = this.sim!;
    if (this.lastFrame?.step === sim.step) return;
    const cells = thumbnail(sim.state, [], sim.step, FRAME_WIDTH).cells;
    const last = this.lastFrame && this.lastFrame.sinceKey + 1 < KEY_EVERY ? this.lastFrame : undefined;
    this.store.putFrame!({ step: sim.step, bytes: encodeFrame(cells, last?.cells) });
    this.lastFrame = { step: sim.step, cells, sinceKey: last ? last.sinceKey + 1 : 0 };
  }

  /** The frames as an archive carries them. */
  private timeline(): Timeline | undefined {
    const frames = this.store.frames?.() ?? [];
    if (!frames.length || !this.sim || !this.genesis) return undefined;
    const size = thumbnail(this.sim.state, [], 0, FRAME_WIDTH);
    const claimed = new Map(this.claimedFlags().map((f) => [f.empire, f.banner] as const));
    return {
      width: size.width,
      height: size.height,
      every: frameEvery(this.genesis),
      banners: flyBanners(this.genesis.empires, claimed).map((b) => b.id),
      frames: frames.map((frame) => [frame.step, toBase64Url(frame.bytes)]),
    };
  }

  /** The map for the listings, if it is due: at the start and the end, and
   *  otherwise once `MAP_EVERY_MS` has passed since the last. */
  private sendMap(): void {
    if (!this.events.map || !this.sim || !this.genesis) return;
    const sim = this.sim;
    const now = this.now();
    const last = this.store.get<number>("mapAt");
    const due = last === undefined || sim.step === 0 || sim.ended || now - last >= MAP_EVERY_MS;
    if (!due) return;
    const claimed = new Map(this.claimedFlags().map((f) => [f.empire, f.banner] as const));
    const banners = flyBanners(this.genesis.empires, claimed).map((b) => b.id);
    this.store.put("mapAt", now);
    this.events.map(this.config.roomId, thumbnail(sim.state, banners, sim.step), now);
  }

  // --- moves -----------------------------------------------------------------

  private async move(peer: Peer, message: Extract<ClientMessage, { t: "move" }>): Promise<void> {
    if (this._phase !== "playing" || !this.genesis || !this.roster || this.ended) return;
    const key = peer.key!;
    const seat = this.roster.seatOf(key);
    if (!seat) return this.error(peer, "you hold no seat");
    const body = message.move;
    if (!body || typeof message.sig !== "string") return;
    const { seq, type, x, y } = body;
    if (![seq, type, x, y].every((n) => Number.isInteger(n))) return;
    // A seat's own heartbeat is the room's to send, and a seat is never amended
    // by its holder.
    if (type === MOVE.HEARTBEAT || type === MOVE.ROSTER_AMEND) return;

    const move: Move = { step: 0, empire: seat.empire, member: seat.member, seq, type, x, y };
    if (!(seq > (this.seqs[key] ?? -1))) return this.error(peer, "stale seq");
    const ok = await verifyMove(this.roster, this.genesis.gameId!, { move, sig: message.sig });
    if (!ok) return this.error(peer, "move did not verify");
    // Checked again: another socket holding the same key may have spent this
    // number while the signature was being checked.
    if (!(seq > (this.seqs[key] ?? -1))) return this.error(peer, "stale seq");

    this.seqs[key] = seq;
    this.stamp([{ move, sig: message.sig }], key);
  }

  // --- the clock -------------------------------------------------------------

  /** Called by the host at `wakeAt()`: starts a scheduled game when it is due. */
  async tick(): Promise<void> {
    if (this._phase === "lobby" && this.startsAt !== undefined && this.now() >= this.startsAt) {
      await this.start();
    } else if (this._phase === "playing") {
      this.catchUp();
    }
  }

  /** The lowest step a move stamped now may land on. Every step below it is
   *  final: nothing can be stamped there any more. */
  private openStep(): number {
    return Math.max(stepAt(this.genesis!.startedAt, this.now()) + LEAD_STEPS, this.lastStamp);
  }

  /** Put moves in the log at the open step, with a heartbeat for `key`'s seat
   *  if one is due, and tell everybody. */
  private stamp(moves: Stamped[], key?: string, at?: number): number {
    const step = at ?? this.openStep();
    const all = [...moves];
    // A seat's own move is its presence (from v4), so it resets the beat
    // rather than bringing one along.
    if (key && moves.length && this.movesArePresence()) this.beats.set(key, step);
    const beat = key ? this.heartbeat(key, step) : undefined;
    if (beat) all.push(beat);
    if (!all.length) return step;

    for (const stamped of all) stamped.move.step = step;
    this.lastStamp = step;
    this.store.append(all);
    this.future.push(...all);

    const message: ServerMessage = { t: "moves", moves: all, now: this.now() };
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, message);
    }
    return step;
  }

  /** Simulate up to `to`, never past a step that could still receive a move. */
  private advance(to: number): void {
    const sim = this.sim;
    if (!sim || !this.genesis) return;
    const wanted = Math.min(to, this.openStep());
    const bound = Math.min(wanted, sim.step + MAX_ADVANCE);
    // Behind until an advance reaches now. A short one (to answer a client's
    // hash report, say) neither starts nor ends that.
    if (bound < wanted) this.cutShort = true;
    else if (bound >= stepAt(this.genesis.startedAt, this.now())) this.cutShort = false;
    if (bound <= sim.step || sim.ended) return;

    const from = sim.step;
    // In pieces that stop at each frame, so the map is recorded on its own
    // steady pace however the room is woken: an hour's catch-up records its
    // thirty-odd frames as surely as a busy room records each as it passes.
    const moves = this.future.map((s) => s.move);
    const every = this.framing() ? frameEvery(this.genesis) : 0;
    const checkpoints: Array<{ step: number; hash: number }> = [];
    while (sim.step < bound && !sim.ended) {
      const next = every ? Math.min(bound, (Math.floor(sim.step / every) + 1) * every) : bound;
      checkpoints.push(...advanceTo(sim, next, moves).checkpoints);
      if (every && (sim.step % every === 0 || sim.ended)) this.recordFrame();
    }
    this.future = this.future.filter((s) => s.move.step >= sim.step);
    for (const { step, hash } of checkpoints) this.checkpoints.set(step, hash);
    for (const step of this.checkpoints.keys()) {
      if (this.checkpoints.size <= KEEP_CHECKPOINTS) break;
      this.checkpoints.delete(step);
    }

    this.next = sim.step;
    if (sim.ended) this.cutShort = false;
    if (Math.floor(this.next / SNAPSHOT_EVERY) > Math.floor(from / SNAPSHOT_EVERY) || sim.ended) {
      this.keepSnapshot();
    }
    if (sim.ended) this.finish();
  }

  /** Report the result, once. */
  private finish(): void {
    if (this.finished || !this.sim || !this.roster) return;
    this.finished = true;
    this.store.put("finished", true);
    this.events.ended?.(this.result());
    this.events.game?.(this.summary());
  }

  private result(): GameResult {
    const bySeat = new Map<string, { key: string; bot: boolean }>();
    for (const player of this.players) {
      const seat = this.roster!.seatOf(player.key);
      if (seat) {
        bySeat.set(`${seat.empire}:${seat.member}`, { key: player.key, bot: this.isBot(player.key) });
      }
    }
    return resultOf(this.sim!, this.config.roomId, (e, m) => bySeat.get(`${e}:${m}`));
  }

  /** The whole game, once it has ended: for an archive. Reads the entire
   *  log, which is the one time anything does. */
  archive(): GameArchive | undefined {
    if (!this.finished || !this.sim || !this.genesis || !this.roster) return undefined;
    const players = this.players.flatMap((p) => {
      const seat = this.roster!.seatOf(p.key);
      // No names: a name belongs to the records, where its owner can take it
      // out again, and a replay looks names up there by key.
      return seat ? [{ key: p.key, empire: seat.empire, member: seat.member, bot: this.isBot(p.key) }] : [];
    });
    return {
      format: "tessera/archive/1",
      roomId: this.config.roomId,
      genesis: this.genesis,
      players,
      moveLog: this.store.movesFrom(0).filter((s) => s.move.step < this.sim!.step),
      ...(this.claimedFlags().length ? { flags: this.claimedFlags() } : {}),
      ...(this.timeline() ? { timeline: this.timeline()! } : {}),
      steps: this.sim.step,
      hash: hex(this.sim.hash()),
      result: this.result(),
    };
  }

  /** Report one player's place in the game. */
  private recordPlayer(key: string): void {
    if (!this.events.player) return;
    const player = this.players.find((p) => p.key === key);
    if (!player) return;
    // In the lobby, the empire a house would be if the game started now.
    const empire = this.roster
      ? (this.roster.seatOf(key)?.empire ?? null)
      : player.banner === null
        ? null
        : this.picked().indexOf(player.banner) + 1;
    this.events.player({
      roomId: this.config.roomId,
      key,
      name: player.name,
      empire,
      bot: player.bot === true,
      at: this.now(),
    });
  }

  /** A HEARTBEAT for `key`'s seat, once per heartbeat interval, issued when
   *  that seat's client says anything at all. Unsigned: presence is something
   *  the room observes, not something a seat claims. */
  private heartbeat(key: string, step: number): Stamped | undefined {
    const seat = this.roster?.seatOf(key);
    if (!seat || !this.genesis) return undefined;
    const last = this.beats.get(key);
    if (last !== undefined && step - last < this.genesis.rules.heartbeatInterval) return undefined;
    this.beats.set(key, step);
    return {
      move: { step, empire: seat.empire, member: seat.member, seq: 0, type: MOVE.HEARTBEAT, x: 0, y: 0 },
    };
  }

  // --- seats after the start -------------------------------------------------

  /** Seat `key` in `empire` with a ROSTER_AMEND the room issues under member
   *  `by` (whoever approved or invited, or 0 for an empire nobody holds), if
   *  the simulation will accept it: the join window, the seat cap and a living
   *  empire are all its rules. The amendment gets a step of its own, and the
   *  room catches up to it first, so it is judged against the state it will
   *  land in. */
  private seatNow(
    peer: Peer | undefined,
    empire: number,
    key: string,
    by: number,
    flying: { banner?: BannerId } = {},
  ): boolean {
    const sim = this.sim!;
    const roster = this.roster!;
    if (roster.has(key)) return false;
    const step = Math.max(this.openStep(), this.lastStamp + 1);
    this.lastStamp = step;
    this.advance(step);

    // A bot is seated as one. The simulation lets a bot seat in after the join
    // window has closed, because a bot is cover for an empire's own players
    // rather than a new player arriving.
    const bot = this.isBot(key);
    const kind = bot ? MEMBER.BOT : MEMBER.HUMAN;
    const move: Move = { step, empire, member: by, seq: 0, type: MOVE.ROSTER_AMEND, x: kind, y: 0 };
    if (sim.step !== step || !sim.validate(move)) {
      if (peer) this.error(peer, "that seat cannot be given now");
      return false;
    }
    roster.amend(empire, key, kind, step);
    this.seatings.push({ empire, key, step, ...(bot ? { bot } : {}), ...flying });
    this.requests = this.requests.filter((r) => r.key !== key);
    this.store.put("seatings", this.seatings);
    this.store.put("requests", this.requests);
    this.stamp([{ move }], undefined, step);

    for (const other of this.peers.values()) {
      if (other.key === key) this.sendTo(other.conn, { t: "seated", you: this.you(key) });
    }
    this.broadcastPeople();
    this.recordPlayer(key);
    this.events.game?.(this.summary());
    return true;
  }

  private canJoin(peer: Peer): boolean {
    if (this._phase !== "playing" || !this.sim || this.ended) return false;
    if (this.roster!.has(peer.key!)) {
      this.error(peer, "you already hold a seat");
      return false;
    }
    return true;
  }

  private isBot(key: string): boolean {
    return this.players.find((p) => p.key === key)?.bot === true;
  }

  private claim(peer: Peer, empireId: unknown, banner: unknown): void {
    if (!this.canJoin(peer) || !Number.isInteger(empireId)) return;
    // An empire with nobody in it is a player's to take. A bot is cover for
    // people who are already there, so it comes in by invite or approval.
    if (this.isBot(peer.key!)) return this.error(peer, "a bot joins by invite or approval");
    const empire = this.sim!.state.empires[(empireId as number) - 1];
    if (!empire || !isVacant(empire) || empire.control !== CONTROL.HUMAN) {
      return this.error(peer, "that empire cannot be taken");
    }
    // A house somebody already flies is not refused, only not flown: refusing
    // a whole claim over a colour would let a squatter deny somebody a seat.
    const flying = this.flies(banner) ? { banner: banner as BannerId } : {};
    this.seatNow(peer, empireId as number, peer.key!, 0, flying);
  }

  /** Whether a claimant may bring `banner`: a house no empire has sealed or
   *  claimed. One a vacancy is only wearing is free. */
  private flies(banner: unknown): boolean {
    if (typeof banner !== "string" || !bannerById(banner)) return false;
    if (this.genesis!.empires.some((e) => e.banner === banner)) return false;
    return !this.seatings.some((s) => s.banner === banner);
  }

  /** Houses brought to vacancies, in the order they were claimed. */
  private claimedFlags(): ClaimedFlag[] {
    return this.seatings.flatMap((s) => (s.banner ? [{ empire: s.empire, banner: s.banner }] : []));
  }

  private ask(peer: Peer, empireId: unknown): void {
    if (!this.canJoin(peer) || !Number.isInteger(empireId)) return;
    const empire = this.sim!.state.empires[(empireId as number) - 1];
    if (!empire || isVacant(empire) || !empire.alive || empire.control !== CONTROL.HUMAN) {
      return this.error(peer, "that empire cannot seat anybody");
    }
    this.requests = this.requests.filter((r) => r.key !== peer.key);
    this.requests.push({ key: peer.key!, empire: empireId as number });
    this.store.put("requests", this.requests);
    this.broadcastPeople();
  }

  private dropRequest(key: string): void {
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.key !== key);
    if (this.requests.length === before) return;
    this.store.put("requests", this.requests);
    this.broadcastPeople();
  }

  /** A member of the asked-for empire says yes or no. */
  private answer(peer: Peer, key: unknown, yes: boolean): void {
    const request = this.requests.find((r) => r.key === key);
    if (!request) return;
    const seat = this.roster?.seatOf(peer.key!);
    if (!seat || seat.empire !== request.empire) return this.error(peer, "only that empire can answer");
    if (yes) this.seatNow(peer, request.empire, request.key, seat.member);
    else this.dropRequest(request.key);
  }

  private async redeem(peer: Peer, signed: SignedInvite): Promise<void> {
    if (!this.canJoin(peer) || !this.genesis) return;
    const ok = await verifyInvite(this.genesis.gameId!, signed);
    if (!ok) return this.error(peer, "that invite did not verify");
    const { invite } = signed;
    if (invite.expires * 1000 < this.now()) return this.error(peer, "that invite has expired");
    if (this.usedInvites.includes(invite.id)) return this.error(peer, "that invite has been used");
    const inviter = this.roster!.seatOf(invite.by);
    if (!inviter || inviter.empire !== invite.empire) {
      return this.error(peer, "whoever signed that invite is not in that empire");
    }
    if (this.seatNow(peer, invite.empire, peer.key!, inviter.member)) {
      this.usedInvites.push(invite.id);
      this.store.put("invites", this.usedInvites);
    }
  }

  /** List or unlist the game. The creator's call, at any point: it changes
   *  who can find the game, not the game. */
  private setPublic(peer: Peer, value: unknown): void {
    if (typeof value !== "boolean") return;
    if (peer.key !== this.config.creator) return this.error(peer, "only the game's creator can change that");
    if ((this.config.public ?? false) === value) return;
    this.config.public = value;
    this.store.put("config", this.config);
    const message: ServerMessage = { t: "settings", settings: this.settings() };
    for (const other of this.peers.values()) {
      if (other.key) this.sendTo(other.conn, message);
    }
    this.events.game?.(this.summary());
  }

  private settings(): GameSettings {
    return { creator: this.config.creator, public: this.config.public ?? false, chat: this.config.chat ?? "open" };
  }

  private setChatMode(peer: Peer, mode: unknown): void {
    if (!CHAT_MODES.includes(mode as ChatMode)) return;
    if (peer.key !== this.config.creator) return this.error(peer, "only the game's creator can change that");
    if ((this.config.chat ?? "open") === mode) return;
    this.config.chat = mode as ChatMode;
    this.store.put("config", this.config);
    const message: ServerMessage = { t: "settings", settings: this.settings() };
    for (const other of this.peers.values()) {
      if (other.key) this.sendTo(other.conn, message);
    }
  }

  /** Take a member's name out of this game: the player list, the chat it has
   *  kept and so the archive it will write. Asked for by the member, through
   *  the Worker, which has checked the request is signed by its key. The
   *  member is shown by its key's fingerprint from then on. True if there was
   *  anything to forget. */
  forget(key: string): boolean {
    let changed = false;
    for (const player of this.players) {
      if (player.key === key && player.name) {
        player.name = "";
        changed = true;
      }
    }
    let said = false;
    for (const line of this.chat) {
      if (line.key === key && line.name) {
        line.name = "";
        said = true;
      }
    }
    if (said) this.store.put("chat", this.chat);
    if (!changed) return said;
    this.store.put("players", this.players);
    if (this._phase === "lobby") this.broadcastLobby();
    else this.broadcastPeople();
    return true;
  }

  private rename(key: string, raw: string): void {
    const name = cleanName(raw);
    const player = this.players.find((p) => p.key === key);
    if (!player || !name || player.name === name) return;
    player.name = name;
    this.store.put("players", this.players);
    if (this._phase === "lobby") this.broadcastLobby();
    else this.broadcastPeople();
  }

  // --- chat ------------------------------------------------------------------

  /** Chat is the room's to carry and nothing in the game depends on it, so it
   *  is neither signed nor stamped: a line is a line as soon as the room has
   *  it. Team lines reach the speaker's empire and nobody else. */
  private say(peer: Peer, channel: unknown, raw: unknown): void {
    const key = peer.key!;
    if (typeof raw !== "string") return;
    const mode = this.config.chat ?? "open";
    if (mode === "off") return this.error(peer, "chat is off in this game");
    // Control characters out (bidi overrides included), whitespace collapsed,
    // and links out: in a game anybody can join, a link is the one thing in a
    // line that can take a reader somewhere else.
    const text = withoutLinks(
      raw
        .normalize("NFC")
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ).slice(0, CHAT_MAX);
    if (!text) return;

    const empire = this.roster?.seatOf(key)?.empire ?? 0;
    const team = channel === "team" && empire > 0;
    if (!team && mode === "team") return this.error(peer, "chat is team only in this game");
    if (!team && this.config.public && this._phase === "playing") {
      // A public game's open chat is for the people playing it, and for those
      // who have been at it a little while: a key costs nothing to make, so
      // this is what keeps a fresh one from arriving to shout.
      if (empire === 0) return this.error(peer, "take a seat to chat to everyone; watchers read along");
      const seatedAt = this.seatings.find((s) => s.key === key)?.step ?? 0;
      if (this.next - seatedAt < PUBLIC_CHAT_AFTER) {
        return this.error(peer, "in a public game you can chat to everyone after two minutes in your seat; your team can hear you now");
      }
    }

    const now = this.now();
    // Slower to everyone than to a team, and the same line twice in a row is
    // dropped.
    const gap = team ? CHAT_GAP_MS : CHAT_GAP_ALL_MS;
    if (now - (this.spoke.get(key) ?? 0) < gap) return;
    const last = this.saidLast.get(key);
    if (last && last.text === text && now - last.at < REPEAT_MS) return;
    this.spoke.set(key, now);
    this.saidLast.set(key, { text, at: now });

    const line: ChatLine = {
      key,
      name: this.players.find((p) => p.key === key)?.name ?? "",
      empire,
      channel: team ? "team" : "all",
      text,
      at: now,
    };
    this.chat.push(line);
    if (this.chat.length > KEEP_CHAT) this.chat.splice(0, this.chat.length - KEEP_CHAT);
    this.store.put("chat", this.chat);
    for (const peer of this.peers.values()) {
      if (peer.key && this.hears(peer.key, line)) this.sendTo(peer.conn, { t: "chat", lines: [line] });
    }
  }

  private hears(key: string, line: ChatLine): boolean {
    if (line.channel === "all") return true;
    return this.roster?.seatOf(key)?.empire === line.empire;
  }

  private sendChatHistory(peer: Peer): void {
    this.sendTo(peer.conn, { t: "settings", settings: this.settings() });
    const lines = this.chat.filter((line) => this.hears(peer.key!, line));
    if (lines.length) this.sendTo(peer.conn, { t: "chat", lines });
  }

  private peopleView(): People {
    const online = this.connectedKeys();
    const names = new Map(this.players.map((p) => [p.key, p.name]));
    const seen = new Set<string>();
    const people = [];
    for (const seat of this.roster?.all() ?? []) {
      seen.add(seat.key);
      people.push({
        key: seat.key,
        name: names.get(seat.key) ?? "",
        connected: online.has(seat.key),
        seat: { empire: seat.empire, member: seat.member },
        ...(seat.kind === MEMBER.BOT ? { bot: true } : {}),
      });
    }
    for (const key of online) {
      if (!seen.has(key)) people.push({ key, name: names.get(key) ?? "", connected: true });
    }
    const requests = this.requests.map((r) => ({ ...r, name: names.get(r.key) ?? "" }));
    const flags = this.claimedFlags();
    return { people, requests, ...(flags.length ? { flags } : {}) };
  }

  private broadcastPeople(): void {
    if (this._phase !== "playing") return;
    const people = this.peopleView();
    for (const peer of this.peers.values()) {
      if (peer.key) this.sendTo(peer.conn, { t: "people", people });
    }
  }

  // --- catching up -----------------------------------------------------------

  /** Everything a client needs to reach `next`, from its own state when the
   *  room can vouch for it and from the snapshot otherwise. */
  private catchup(have?: { step: number; hash: number }): Catchup {
    const genesis = this.genesis!;
    const known = have ? this.checkpoints.get(have.step) : undefined;
    const usable =
      have &&
      Number.isInteger(have.step) &&
      have.step <= this.next &&
      have.step >= (this.store.latestSnapshot()?.step ?? 0) &&
      (known === undefined || known === have.hash);
    if (usable) {
      return { genesis, tail: this.store.movesFrom(have.step), upTo: this.next, now: this.now() };
    }
    const snapshot = this.store.latestSnapshot()!;
    return {
      genesis,
      snapshot: { step: snapshot.step, hash: snapshot.hash, data: toBase64Url(snapshot.bytes) },
      tail: this.store.movesFrom(snapshot.step),
      upTo: this.next,
      now: this.now(),
    };
  }

  /** A client's hash at a checkpoint. A mismatch sends it the room's state. */
  private compare(peer: Peer, step: number, hash: number): void {
    // Reports come every few seconds from every client, which makes them the
    // natural carrier for a seat's heartbeat.
    this.stamp([], peer.key);
    if (!Number.isInteger(step)) return;
    if (step > this.next) this.advance(step + 1);
    const ours = this.checkpoints.get(step);
    if (ours === undefined || ours === hash) return;
    this.sendTo(peer.conn, { t: "resync", game: this.catchup() });
  }

  // --- small things ----------------------------------------------------------

  private you(key: string): You {
    const seat = this.roster?.seatOf(key);
    return {
      key,
      ...(seat ? { seat: { empire: seat.empire, member: seat.member } } : {}),
      nextSeq: (this.seqs[key] ?? -1) + 1,
    };
  }

  private connectedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const peer of this.peers.values()) if (peer.key) keys.add(peer.key);
    return keys;
  }

  private sendTo(conn: Connection, message: ServerMessage): void {
    try {
      conn.send(encode(message));
    } catch {
      // A socket that fails to send is about to close; its disconnect cleans up.
    }
  }

  private error(peer: Peer, message: string): void {
    this.sendTo(peer.conn, { t: "error", message });
  }
}
