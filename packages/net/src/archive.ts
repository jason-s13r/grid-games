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
import { verifyClaim } from "@tessera/protocol";
import type {
  Message,
  Seat,
  SignedAmendment,
  SignedClaim,
  SignedMessage,
  SignedMove,
} from "@tessera/protocol";
import { isClaim, mergeSeatings, seatingOf } from "./seating.js";

/** Bumped when the shape below changes in a way a reader must know about.
 *  A reader that does not recognise the number should refuse rather than guess:
 *  a misread archive is a wrong hash, and a wrong hash looks like cheating.
 *
 *  **2 adds `claims`.** An archive is the one artefact where an old reader
 *  neither refuses nor desyncs: handed a game somebody claimed a vacancy in, a
 *  v1 reader replays it against a roster missing a seat, reaches a different
 *  hash, and reports it as corruption somewhere else entirely. The number is
 *  what turns that into a refusal. Compare the genesis record, which a v3 build
 *  declines on its own because a vacancy is an empty members array and that was
 *  always an error — and compare `LAYOUT_VERSION`, which does not move at all,
 *  because the shield layer is derived and never written. Three artefacts, three
 *  verdicts, each legible from what an old reader would otherwise do. */
export const ARCHIVE_FORMAT = 2;

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
  /** Vacancies somebody claimed. Apart from the amendments because the two
   *  verify by completely different rules — a quorum of an empire's existing
   *  seats against one signature from the key being seated — and merged back
   *  into one sequence by `seatingOrder` when the log is replayed. */
  claims?: SignedClaim[];
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
  /** Steps where the log jumps because this peer adopted a state rather than
   *  simulating into it. `from` already makes every reader refuse — including one
   *  built before this field existed — and this says *where*, so a reader that
   *  cares can name the hole rather than only report that the log begins late. */
  gaps?: number[];
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
  | { k: "claim"; claim: SignedClaim }
  | { k: "chat"; message: SignedMessage }
  /** The simulation jumped to an adopted state, so the inputs between the last
   *  recorded step and this one were never seen by this peer. Written down
   *  because an unrecorded jump is the one thing that turns an archive into a
   *  file that claims to replay and does not. */
  | { k: "gap"; to: number };

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
  onClaimed?: (claim: SignedClaim) => void;
  onAdopted?: (step: number) => void;
}

export class Archive {
  private readonly entries: Array<SignedMove | Move> = [];
  private readonly amended: SignedAmendment[] = [];
  private readonly claimed: SignedClaim[] = [];
  private readonly said: SignedMessage[] = [];
  private readonly jumped: number[] = [];
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
    const claimed = driver.onClaimed;
    const adopted = driver.onAdopted;

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
    driver.onClaimed = (claim) => {
      claimed?.(claim);
      this.claim(claim);
    };
    driver.onAdopted = (step) => {
      adopted?.(step);
      this.gap(step);
    };

    return () => {
      driver.onApplied = applied;
      driver.onMessage = message;
      driver.onAmended = amended;
      driver.onClaimed = claimed;
      driver.onAdopted = adopted;
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

  claim(claim: SignedClaim): void {
    this.record({ k: "claim", claim });
  }

  chat(message: SignedMessage): void {
    this.record({ k: "chat", message });
  }

  /** The simulation jumped rather than advanced. From here the log is a fragment
   *  and says so — `from` is what makes every reader refuse it, including one
   *  written before gaps existed. */
  gap(step: number): void {
    this.jumped.push(step);
    this.record({ k: "gap", to: step });
  }

  /** Where this archive's log becomes replayable-from-the-start, or 0 if it
   *  always was. A peer that adopted a state has a hole behind it whatever it saw
   *  first. */
  get begins(): number {
    return this.jumped.length > 0 ? this.jumped[this.jumped.length - 1]! : 0;
  }

  /** Every step this archive jumped at, oldest first. */
  get gaps(): readonly number[] {
    return this.jumped;
  }

  private record(record: ArchiveRecord): void {
    if (record.k === "move") this.counted++;
    if (this.retain) {
      if (record.k === "move") this.entries.push(record.entry);
      else if (record.k === "amend") this.amended.push(record.amendment);
      else if (record.k === "claim") this.claimed.push(record.claim);
      else if (record.k === "chat") this.said.push(record.message);
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
      ...(this.claimed.length > 0 ? { claims: [...this.claimed] } : {}),
      messages: [...this.said],
      steps: this.steps,
      hash: hex(this.source.hash()),
      ...(this.jumped.length > 0 ? { from: this.begins, gaps: [...this.jumped] } : {}),
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
  // A newer format is refused; an older one is read, because everything v1
  // described is still described the same way and a game with no claims in it is
  // byte-for-byte a v1 game. Refusing those would be refusing every archive
  // written before vacancies existed, which is the opposite of what the number
  // is for.
  if (game.format > ARCHIVE_FORMAT || !(game.format >= 1)) {
    problems.push(`unknown archive format ${game.format}`);
  }
  if ((game.format ?? 0) < 2 && (game.claims?.length ?? 0) > 0) {
    // A v1 archive that carries claims is a file whose own header says its
    // reader will get the roster wrong.
    problems.push("archive claims to be format 1 but carries claimed empires");
  }

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

  // Seatings first, because a move signed by a substitute or a claimant is only
  // verifiable once the roster knows about the seat that record created.
  //
  // In **one merged order**, `seatingOrder`, shared with the driver's
  // `seatArrivals`. Two arrays each walked in their own order diverge the moment
  // a claim and an amendment land on the same step, and the divergence is a
  // different member index — which is a `keyOf` miss on every later move that
  // seat signed, surfacing as a hash mismatch that describes nothing.
  const seatedAt = new Map<string, number>();
  const seatings = mergeSeatings(game.amendments, game.claims);
  for (const signed of seatings) {
    const { empire, key, kind, step } = seatingOf(signed);
    if (isClaim(signed)) {
      // A claim authorises seating an empty empire and nothing else, and
      // "empty" is a fact about where in this walk we are. Same guard the
      // driver applies, for the same reason and against the same roster.
      if (roster.size(empire) > 0) {
        problems.push(`a claim for empire ${empire} arrived after it was taken`);
        continue;
      }
      if (!(await verifyClaim(gameId, signed))) {
        problems.push(`the claim for empire ${empire} is not signed by the key it seats`);
        continue;
      }
    } else if (!(await verifyAmendment(roster, gameId, signed))) {
      problems.push(`amendment for empire ${empire} lacks a quorum`);
      continue;
    }
    const member = roster.amend(empire, key, kind, step);
    seatedAt.set(`${empire}:${member}`, step);
  }

  const amendedAt = new Set(seatings.map((one) => seatingOf(one).step));

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
