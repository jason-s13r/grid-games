// The durable half of an observer.
//
// A peer already holds everything an archive needs: the genesis record it
// agreed to play, and every move it handed to the simulation. What no peer does
// today is write any of it down, so closing the tab takes the game's history
// with it. This is the sink that keeps it.
//
// The format is deliberately the one `pnpm replay --log` has read since Phase
// B, so an archived game is checked by the tool that has been guarding
// determinism all along rather than by something written for the occasion.
//
// Signatures are kept rather than stripped. A log without them is a claim; a
// log with them can be handed to a stranger who rebuilds the roster from the
// genesis record and checks every move against it — which is the whole
// difference between a leaderboard that is reported and one that is checkable.

import { MOVE, Sim, hex } from "@tessera/sim";
import type { EmpireSummary, Genesis, Move } from "@tessera/sim";
import { Roster, inspectGenesis, verifyAmendment, verifyMessage, verifyMove } from "@tessera/protocol";
import type { Message, Seat, SignedAmendment, SignedMessage, SignedMove } from "@tessera/protocol";

/** Bumped when the shape below changes in a way a reader must know about.
 *  A reader that does not recognise the number should refuse rather than guess:
 *  a misread archive is a wrong hash, and a wrong hash looks like cheating. */
export const ARCHIVE_FORMAT = 1;

/** A game, written down.
 *
 *  `moveLog` is every move that went into `sim.advance`, in the order it went
 *  in — signed ones still in their envelopes, and the rest bare. The bare ones
 *  are not an omission: a ROSTER_AMEND move is synthesised locally from an
 *  endorsed amendment, so its authority is in `amendments` rather than in a
 *  signature of its own. Replay does not care which is which; verification
 *  does, and that is why both are here. */
export interface ArchivedGame {
  format: number;
  genesis: Genesis;
  moveLog: Array<SignedMove | Move>;
  amendments: SignedAmendment[];
  /** Chat is ordered, signed and attributable, and deliberately outside the
   *  state hash. It is archived as it crossed the wire, which means a team line
   *  stays ciphertext here exactly as it was to every peer but its recipients. */
  messages: SignedMessage[];
  /** The step the world had reached, which is not the step of the last move: a
   *  game whose players stopped clicking an hour ago has gone on spawning coins
   *  and decaying territory ever since. */
  steps: number;
  hash: string;
  /** The step the log begins at. Zero, and usually absent, for a peer that
   *  watched from the start — the only case in which a log replays from the
   *  genesis record. A peer that joined an hour in holds a fragment, and saying
   *  so is the difference between an honest partial archive and a hash mismatch
   *  nobody can account for. */
  from?: number;
}

/** Where the archive reads the step and hash it is claiming. A `Sim` is one and
 *  so is a `Lockstep`, which is why `attach` needs nothing further. */
export interface ArchiveSource {
  readonly step: number;
  hash(): number;
}

/** Emitted as the game happens, for an archive that would rather append to a
 *  file than hold a multi-day game in memory. */
export type ArchiveRecord =
  | { k: "move"; entry: SignedMove | Move }
  | { k: "amend"; amendment: SignedAmendment }
  | { k: "chat"; message: SignedMessage };

export interface ArchiveOptions {
  /** Keep every record in memory as well as emitting it. True is right for a
   *  browser tab, which has nowhere else to put them and wants to offer the log
   *  as a download; a peer writing an append-only file sets it false and lets
   *  the file be the archive. */
  retain?: boolean;
}

/** What a driver has to expose for `attach` to wire itself in. Declared
 *  structurally rather than importing Lockstep, because the dependency runs the
 *  other way: an archive is something you point at a driver. */
interface Archivable extends ArchiveSource {
  onApplied?: (step: number, moves: readonly Move[], signed: readonly SignedMove[]) => void;
  onMessage?: (message: Message, text: string | null, signed?: SignedMessage) => void;
  onAmended?: (amendment: SignedAmendment) => void;
}

export class Archive {
  private readonly entries: Array<SignedMove | Move> = [];
  private readonly amended: SignedAmendment[] = [];
  private readonly said: SignedMessage[] = [];
  private readonly retain: boolean;
  private reached = 0;
  private counted = 0;

  /** Told about every record as it happens. */
  onRecord?: (record: ArchiveRecord) => void;

  constructor(
    readonly genesis: Genesis,
    private readonly source: ArchiveSource,
    options: ArchiveOptions = {},
  ) {
    this.retain = options.retain ?? true;
  }

  /** How many moves have passed through, retained or not. */
  get size(): number {
    return this.counted;
  }

  /** The furthest step the archive knows the world reached. Read from the
   *  source, because a step with no input in it still happened. */
  get steps(): number {
    return Math.max(this.reached, this.source.step);
  }

  /** Wire into a driver, and return the way back out. Existing handlers are
   *  chained rather than replaced: the client sets `onMessage` to draw the chat
   *  log long before anybody asks for an archive, and quietly stealing that
   *  callback would empty the panel. */
  attach(driver: Archivable): () => void {
    const applied = driver.onApplied;
    const message = driver.onMessage;
    const amended = driver.onAmended;

    driver.onApplied = (step, moves, signed) => {
      applied?.(step, moves, signed);
      this.applied(step, moves, signed);
    };
    driver.onMessage = (heard, text, envelope) => {
      message?.(heard, text, envelope);
      if (envelope) this.chat(envelope);
    };
    driver.onAmended = (amendment) => {
      amended?.(amendment);
      this.amend(amendment);
    };

    return () => {
      driver.onApplied = applied;
      driver.onMessage = message;
      driver.onAmended = amended;
    };
  }

  /** The shape of `Lockstep.onApplied`, so it can be handed over directly. */
  applied(step: number, moves: readonly Move[], signed: readonly SignedMove[]): void {
    // The driver hands the same move object twice — once bare in `moves` and
    // once inside its envelope — so identity is enough to pair them, and is
    // cheaper and more exact than comparing seven fields.
    const envelopes = new Map<Move, SignedMove>(signed.map((one) => [one.move, one]));
    for (const move of moves) this.record({ k: "move", entry: envelopes.get(move) ?? move });
    this.reached = Math.max(this.reached, step + 1);
  }

  amend(amendment: SignedAmendment): void {
    this.record({ k: "amend", amendment });
  }

  chat(message: SignedMessage): void {
    this.record({ k: "chat", message });
  }

  private record(record: ArchiveRecord): void {
    if (record.k === "move") this.counted++;
    if (this.retain) {
      if (record.k === "move") this.entries.push(record.entry);
      else if (record.k === "amend") this.amended.push(record.amendment);
      else this.said.push(record.message);
    }
    this.onRecord?.(record);
  }

  /** The game as a file. Meaningless on an archive that is not retaining —
   *  there the records went to the sink and the sink is the archive. */
  toJSON(): ArchivedGame {
    return {
      format: ARCHIVE_FORMAT,
      genesis: this.genesis,
      moveLog: [...this.entries],
      amendments: [...this.amended],
      messages: [...this.said],
      steps: this.steps,
      hash: hex(this.source.hash()),
    };
  }
}

export interface Verdict {
  ok: boolean;
  /** The hash this engine reached replaying the log, which is the number the
   *  archive is really claiming. */
  hash: string;
  steps: number;
  moves: number;
  /** Moves that carried a signature this roster accepts. */
  verified: number;
  /** Everything wrong with it, empty when nothing is. */
  problems: string[];
  /** The empire that won, or zero for a game that has not ended — and for the
   *  rare one that ended with nobody left. Read off the replay rather than off
   *  the archive, so it is a result nobody had the chance to assert. */
  winner: number;
  /** The result of the game the replay just played, from the same hashed state
   *  the hash above was taken from. Here rather than in a second pass because
   *  a ranking wants both, and replaying a multi-day log twice to get them is
   *  a waste of the only expensive thing in this file. */
  summary: EmpireSummary[];
}

function unwrap(entry: SignedMove | Move): Move {
  return "move" in entry ? entry.move : entry;
}

/** Check an archive the way a stranger would.
 *
 *  Nothing here trusts the archive: the genesis record is re-hashed to confirm
 *  it is the game it claims to be, the roster is rebuilt from it, every
 *  signature is checked against that roster, and the log is replayed through a
 *  fresh simulation to see whether it arrives at the hash on the tin. A file
 *  that survives all four was produced by the game it says it was — which is
 *  what makes a ranking checkable by anyone holding it, with no peer to ask and
 *  nobody to believe. */
export async function verifyArchive(game: ArchivedGame): Promise<Verdict> {
  const problems: string[] = [];

  if (!game || typeof game !== "object" || !game.genesis || !Array.isArray(game.moveLog)) {
    return {
      ok: false,
      hash: "",
      steps: 0,
      moves: 0,
      verified: 0,
      problems: ["not an archive"],
      winner: 0,
      summary: [],
    };
  }
  if (game.format !== ARCHIVE_FORMAT) problems.push(`unknown archive format ${game.format}`);

  const { genesis } = game;
  for (const wrong of await inspectGenesis(genesis)) problems.push(`genesis: ${wrong}`);
  if (game.from) {
    // Everything below still runs: the signatures on a fragment are as real as
    // any others, and knowing who played is worth having even when the hash
    // cannot be reproduced. It is the replay that is meaningless, and it says so
    // here rather than in the mismatch it is about to produce.
    problems.push(`archive begins at step ${game.from}, so it cannot be replayed from the start`);
  }

  const gameId = genesis.gameId ?? "";
  const roster = Roster.fromGenesis(genesis);

  // Amendments first, because a move signed by a substitute is only verifiable
  // once the roster knows about the seat that endorsement created.
  const seatedAt = new Map<string, number>();
  for (const signed of game.amendments ?? []) {
    if (!(await verifyAmendment(roster, gameId, signed))) {
      problems.push(`amendment for empire ${signed.amendment?.empire} lacks a quorum`);
      continue;
    }
    const { empire, key, kind, step } = signed.amendment;
    const member = roster.amend(empire, key, kind, step);
    seatedAt.set(`${empire}:${member}`, step);
  }

  const amendedAt = new Set((game.amendments ?? []).map((one) => one.amendment.step));

  let verified = 0;
  for (const entry of game.moveLog) {
    const move = unwrap(entry);
    if (!("move" in entry)) {
      // The only move a peer is allowed to have invented is the seat arrival an
      // endorsed amendment produces. Anything else unsigned is somebody's
      // addition to the log after the fact.
      if (move.type !== MOVE.ROSTER_AMEND || !amendedAt.has(move.step)) {
        problems.push(`unsigned move at step ${move.step}`);
      }
      continue;
    }
    if (!(await verifyMove(roster, gameId, entry))) {
      problems.push(`bad signature at step ${move.step} from ${move.empire}:${move.member}`);
      continue;
    }
    // A valid signature from a seat that did not exist yet is still a forgery:
    // the key is real, the moment is not.
    const joined = seatedAt.get(`${move.empire}:${move.member}`);
    if (joined !== undefined && move.step < joined) {
      problems.push(`move at step ${move.step} predates seat ${move.empire}:${move.member}`);
      continue;
    }
    verified++;
  }

  for (const message of game.messages ?? []) {
    if (!(await verifyMessage(roster, gameId, message))) {
      problems.push(`bad signature on a message at step ${message.message?.step}`);
    }
  }

  // The hash is the point. Everything above says the inputs are genuine; this
  // says they produce the world the archive claims they do.
  const moves = game.moveLog.map(unwrap);
  const last = moves.reduce((max, move) => Math.max(max, move.step), 0);
  const steps = game.steps ?? last + 1;
  const sim = new Sim(genesis);
  sim.fastForward(steps, moves);
  const hash = hex(sim.hash());
  if (game.hash && game.hash !== hash) {
    problems.push(`hash mismatch: the log reaches ${hash}, the archive claims ${game.hash}`);
  }

  return {
    ok: problems.length === 0,
    hash,
    steps,
    moves: moves.length,
    verified,
    problems,
    winner: sim.state.winner,
    summary: sim.summary(),
  };
}

/** Seats that ever held the game, for a ranking to attribute results to. Read
 *  off the archive rather than off a live roster, because by the time anyone
 *  counts a leaderboard there is no live anything. */
export function seatsOf(game: ArchivedGame): Seat[] {
  return Roster.fromGenesis(game.genesis).all();
}
