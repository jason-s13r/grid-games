// Framing. What actually travels along a data channel.
//
// JSON, deliberately: frames are not signed, so nothing here needs a canonical
// encoding, and being able to read a session in a console is worth more during
// Phase C than the bytes it costs. The signed payloads inside are binary and
// canonical — see records.ts — and are always rebuilt from the parsed fields
// before verification, so a frame is untrusted transport and nothing more.
//
// decodeFrame is the only entry point, and it returns null rather than throwing
// on anything it does not fully recognise. A peer can send whatever it likes;
// none of it should be able to raise an exception on the receiving side.

import type { Genesis } from "@tessera/sim";
import type { Proposal } from "./proposal.js";
import type {
  EquivocationProof,
  SignedAmendment,
  SignedConsent,
  SignedApplication,
  SignedClaim,
  SignedCheckpoint,
  SignedMessage,
  SignedDrop,
  SignedMove,
  SignedNaming,
  SignedReady,
} from "./records.js";
import type { MemberKey } from "./identity.js";

export const FRAME = {
  HELLO: "hello",
  WELCOME: "welcome",
  PROOF: "proof",
  GENESIS: "genesis",
  MOVE: "move",
  READY: "ready",
  DROP: "drop",
  MESSAGE: "message",
  CHECKPOINT: "checkpoint",
  AMENDMENT: "amendment",
  CLAIM: "claim",
  APPLICATION: "application",
  PROPOSAL: "proposal",
  CONSENT: "consent",
  NAME: "name",
  EQUIVOCATION: "equivocation",
  SNAPSHOT_REQUEST: "snapshot?",
  SNAPSHOT: "snapshot",
  BYE: "bye",
} as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

/** Opens a connection. `key` is a claim, not yet a fact — the proof exchange
 *  that follows is what settles it. An observer sends no key. */
export interface HelloFrame {
  t: typeof FRAME.HELLO;
  /** The version at stake: the game's if there is one, otherwise the one the
   *  sender would compose. An old build reads only this and reaches the right
   *  answer from it, which is why it stays a bare number. */
  protocol: number;
  /** Every version the sender can play. Absent from an older build, and read
   *  as `[protocol]` when it is. */
  supported?: number[];
  gameId: string;
  key?: MemberKey;
  /** What they would like to be called, before there is a game to sign it
   *  against. It **proves nothing at all** — the same standing as the key
   *  beside it, which is "a claim, not yet a fact". Once a genesis exists,
   *  seats re-assert their names as signed records and the claim becomes
   *  attributable; a seatless peer's name stays unverified for the whole game,
   *  because `verifyNaming` runs through the roster and an observer is not in
   *  one. */
  name?: string;
  nonce: string;
}

export interface WelcomeFrame {
  t: typeof FRAME.WELCOME;
  key?: MemberKey;
  nonce: string;
  /** Signature over (their nonce, our nonce). Absent from an observer. */
  proof?: string;
}

export interface ProofFrame {
  t: typeof FRAME.PROOF;
  proof: string;
}

/** The full record, so a joiner can compute the game id itself rather than
 *  taking the host's word for it. */
export interface GenesisFrame {
  t: typeof FRAME.GENESIS;
  genesis: Genesis;
}

export interface MoveFrame {
  t: typeof FRAME.MOVE;
  signed: SignedMove;
}

/** Cumulative: a later READY supersedes an earlier one, so losing one costs a
 *  moment of pipeline depth rather than correctness. */
export interface ReadyFrame {
  t: typeof FRAME.READY;
  signed: SignedReady;
}

/** Rebroadcast as it gains endorsements, so a partial tally reaches everyone
 *  without a coordinator. */
export interface DropFrame {
  t: typeof FRAME.DROP;
  signed: SignedDrop;
}

export interface MessageFrame {
  t: typeof FRAME.MESSAGE;
  signed: SignedMessage;
}

export interface CheckpointFrame {
  t: typeof FRAME.CHECKPOINT;
  signed: SignedCheckpoint;
}

export interface AmendmentFrame {
  t: typeof FRAME.AMENDMENT;
  signed: SignedAmendment;
}

/** Somebody arriving at an empire nobody took. One signature, not a tally: it is
 *  signed by the key it seats, which is the whole of its authority. */
export interface ClaimFrame {
  t: typeof FRAME.CLAIM;
  signed: SignedClaim;
}

/** Somebody asking an empire for a seat. One signature, and no scheduling
 *  weight: it names no step the pipeline must reach. */
export interface ApplicationFrame {
  t: typeof FRAME.APPLICATION;
  signed: SignedApplication;
}

/** A world somebody is suggesting, which anybody may suggest.
 *
 *  `by` is attribution and not authority: nothing arbitrates between two
 *  proposals, because nothing has to — a proposal with no signatures on it dies
 *  of that. A later `rev` from the same `by` supersedes the earlier one, so
 *  "make it three days" stops being a thing you say in chat and hope for and
 *  becomes a revision with one field changed that everybody can see and sign. */
export interface ProposalFrame {
  t: typeof FRAME.PROPOSAL;
  proposal: Proposal;
  /** Monotonic per proposer. */
  rev: number;
  by: MemberKey;
}

/** One signature over one proposal id. Not a vote and not a tally: the set of
 *  these *is* the roster, so there is no threshold to reach. */
export interface ConsentFrame {
  t: typeof FRAME.CONSENT;
  signed: SignedConsent;
}

/** Somebody saying what to call them. Signed by the seat, never hashed, and
 *  re-sent on a slow timer: a name is persistent UI state, so a peer that
 *  missed the one broadcast would show a bare fingerprint for the rest of the
 *  game and never recover. */
export interface NameFrame {
  t: typeof FRAME.NAME;
  signed: SignedNaming;
}

export interface EquivocationFrame {
  t: typeof FRAME.EQUIVOCATION;
  proof: EquivocationProof;
}

export interface SnapshotRequestFrame {
  t: typeof FRAME.SNAPSHOT_REQUEST;
  step: number;
}

/** Content-addressed by `hash`, so it is safe to accept from anyone: the
 *  recipient restores it, hashes it, and discards it if the number disagrees.
 *  base64url is a placeholder — a binary channel should carry the buffer raw. */
export interface SnapshotFrame {
  t: typeof FRAME.SNAPSHOT;
  step: number;
  hash: number;
  data: string;
  /** The roster amendments already applied to that state, in the order they
   *  were applied.
   *
   *  The snapshot carries the simulation, and the simulation knows members by
   *  index and nothing about keys — so a peer that adopted one across an
   *  amendment would hold a state with a seat in it and no idea whose key sits
   *  there, and would reject that player's every move. These are the records
   *  themselves rather than a list of keys, so the receiver re-checks each
   *  quorum for itself: a snapshot stays safe to take from anyone. */
  amendments?: SignedAmendment[];
  /** Claims behind the state, apart from the amendments because they verify by a
   *  different rule. Absent in every snapshot a pre-vacancy build sent. */
  claims?: SignedClaim[];
  /** The seats already dropped from that game, with the records that dropped
   *  them. Not part of the state hash — an ejection changes who a peer waits
   *  for, not what the world looks like — but a peer that adopted a snapshot
   *  without them would sit waiting on a seat everyone else stopped waiting for
   *  long ago, which is indistinguishable from being broken. */
  drops?: SignedDrop[];
}

export interface ByeFrame {
  t: typeof FRAME.BYE;
  reason?: string;
}

export type Frame =
  | HelloFrame
  | WelcomeFrame
  | ProofFrame
  | GenesisFrame
  | MoveFrame
  | ReadyFrame
  | DropFrame
  | MessageFrame
  | CheckpointFrame
  | AmendmentFrame
  | ClaimFrame
  | ApplicationFrame
  | ProposalFrame
  | ConsentFrame
  | NameFrame
  | EquivocationFrame
  | SnapshotRequestFrame
  | SnapshotFrame
  | ByeFrame;

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isStep = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function decodeFrame(text: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isString(parsed.t)) return null;

  switch (parsed.t) {
    case FRAME.HELLO:
      return typeof parsed.protocol === "number" &&
        isString(parsed.gameId) &&
        isString(parsed.nonce) &&
        (parsed.key === undefined || isString(parsed.key)) &&
        (parsed.name === undefined || isString(parsed.name)) &&
        (parsed.supported === undefined ||
          (Array.isArray(parsed.supported) &&
            parsed.supported.every((v) => typeof v === "number")))
        ? (parsed as unknown as HelloFrame)
        : null;

    case FRAME.WELCOME:
      return isString(parsed.nonce) &&
        (parsed.key === undefined || isString(parsed.key)) &&
        (parsed.proof === undefined || isString(parsed.proof))
        ? (parsed as unknown as WelcomeFrame)
        : null;

    case FRAME.PROOF:
      return isString(parsed.proof) ? (parsed as unknown as ProofFrame) : null;

    case FRAME.GENESIS:
      // Only the shape is checked here; inspectGenesis decides whether it is a
      // game this build will join.
      return isObject(parsed.genesis) ? (parsed as unknown as GenesisFrame) : null;

    case FRAME.MOVE:
    case FRAME.READY:
    case FRAME.DROP:
    case FRAME.MESSAGE:
    case FRAME.CHECKPOINT:
    case FRAME.AMENDMENT:
    case FRAME.CLAIM:
    case FRAME.APPLICATION:
    case FRAME.CONSENT:
    case FRAME.NAME:
      // Field-level checking belongs to the verifier, which has to re-derive
      // the payload anyway. Here it is enough that there is something to verify.
      return isObject(parsed.signed) ? (parsed as unknown as Frame) : null;

    case FRAME.PROPOSAL:
      // The only frame whose *contents* get hashed on arrival, so the only one
      // whose numbers have to be checked here. `canonicalJson` throws on a
      // non-finite number, and hashing an arbitrary peer's proposal would
      // otherwise put that throw inside a receive path — reachable by anyone
      // who can send a frame. Refused cheaply, before the hash.
      return isObject(parsed.proposal) &&
        isStep((parsed.proposal as Record<string, unknown>).seed) &&
        isStep((parsed.proposal as Record<string, unknown>).startedAt) &&
        isStep((parsed.proposal as Record<string, unknown>).vacancies) &&
        isStep(parsed.rev) &&
        isString(parsed.by)
        ? (parsed as unknown as ProposalFrame)
        : null;

    case FRAME.EQUIVOCATION:
      return isObject(parsed.proof) ? (parsed as unknown as EquivocationFrame) : null;

    case FRAME.SNAPSHOT_REQUEST:
      return isStep(parsed.step) ? (parsed as unknown as SnapshotRequestFrame) : null;

    case FRAME.SNAPSHOT:
      return isStep(parsed.step) &&
        typeof parsed.hash === "number" &&
        isString(parsed.data) &&
        (parsed.amendments === undefined || Array.isArray(parsed.amendments))
        ? (parsed as unknown as SnapshotFrame)
        : null;

    case FRAME.BYE:
      return parsed.reason === undefined || isString(parsed.reason)
        ? (parsed as unknown as ByeFrame)
        : null;

    default:
      return null;
  }
}
