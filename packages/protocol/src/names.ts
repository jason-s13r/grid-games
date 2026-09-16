// Display names: signed, attributable, and never hashed into anything.
//
// A name could not be part of the world even if somebody wanted it there.
// `gameIdOf` hashes the whole genesis minus its own id, so a `name` on
// `MemberSpec` would be *inside the game id*: renaming would be impossible, and
// two peers holding different names for one seat would not merely render
// differently — they would compute different game ids and never meet. So a name
// belongs to the class chat already belongs to, and for a harder reason than
// taste.
//
// Everything here runs on the **reader's** side. The sender is untrusted and a
// hostile client simply does not run our input validation, so trimming,
// normalising, filtering and truncating all happen on the way in from the wire.
// An input field's `maxLength` is a courtesy to whoever is typing.

import type { MemberKey } from "./identity.js";
import { utf8 } from "./bytes.js";

/** The wire cap, in **bytes**.
 *
 *  "24 characters" is three different numbers: `String.length` counts UTF-16
 *  units, the encoder needs a byte count for its length prefix, and what a
 *  reader actually sees is grapheme clusters. Only one of the three can be the
 *  wire's, and it has to be the encoder's — so the cap is bytes, measured after
 *  NFC normalisation, and the UI caps whatever it likes on top. */
export const NAME_BYTES = 64;

/** Characters that must never survive into a rendered name.
 *
 *  `escape()` replaces `&`, `<`, `>` and `"` and nothing else, which is
 *  sufficient against injection and useless here. A name containing U+202E
 *  passes through it untouched and reverses the rendering of everything after
 *  it on that line — **including the fingerprint that exists to make
 *  impersonation visible**. So the filter is its own function, applied before
 *  the string reaches either `escape()` or `textContent`.
 *
 *  Stripped rather than refused: a name is not a signed claim about anything
 *  except who said it, and a reader's job is to render something harmless, not
 *  to adjudicate. */
const FILTER = new RegExp(
  [
    // C0 and C1 controls, including the ones that are not whitespace.
    "[\\u0000-\\u001f\\u007f-\\u009f]",
    // Explicit bidi marks, embeddings and overrides, and the isolates that
    // replaced them. This is the class that reverses a fingerprint.
    "[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
    // Zero-width joiners and spaces, the invisible separators, and the
    // byte-order mark in its reused role as a word joiner.
    "[\\u200b-\\u200d\\u2060-\\u2064\\ufeff]",
    // Interlinear annotation, which some renderers treat as a bracketing pair.
    "[\\ufff9-\\ufffb]",
  ].join("|"),
  "gu",
);

/** What a name is allowed to be, having arrived from a stranger.
 *
 *  Returns "" for anything with nothing left in it, which the caller renders as
 *  a bare fingerprint — the state every seat starts in. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // NFC first: normalising after measuring would let a name cross the cap on
  // the way to being rendered, and normalising after filtering could
  // reconstitute something the filter removed.
  let name = raw.normalize("NFC").replace(FILTER, "");
  // Every kind of space collapses to one, so a name cannot be mostly gap.
  name = name.replace(/\s+/gu, " ").trim();
  if (name === "") return "";

  // Truncate on a code point boundary, then re-trim: cutting mid-character
  // would produce a lone surrogate, which is not a string anybody can render.
  while (utf8(name).length > NAME_BYTES) {
    name = [...name].slice(0, -1).join("");
  }
  return name.trim();
}

/** How a name is shown, everywhere a decision is made.
 *
 *  Nothing stops two players choosing `kestrel`, and nothing should:
 *  uniqueness would need an authority to arbitrate and there is no authority
 *  anywhere in this system by design. So the name is never shown alone. The
 *  eight hex characters are the identity, the prefix is a convenience, and
 *  **impersonation is made visible rather than prevented**.
 *
 *  A UI may abbreviate to the prefix in a chat line where the seat colour
 *  already disambiguates. The roster, the rivals panel and every join or
 *  endorsement prompt show this form. */
export function displayName(name: string, fingerprint: string): string {
  return name ? `${name}#${fingerprint}` : fingerprint;
}

/** One person's name, as this peer currently believes it. */
export interface Named {
  key: MemberKey;
  name: string;
  step: number;
  seq: number;
  /** The signature that carried it, kept only as the tiebreak below. */
  sig: string;
}

/** Latest-wins, keyed by **key rather than seat**.
 *
 *  The signed record names a seat, because a seat is what `roster.keyOf` can
 *  check a signature against. The *store* cannot: within one game a seat index
 *  is not stable across a drop and a return — `eject`'s own comment says a
 *  returning player "is seated again by ROSTER_AMEND at a fresh index" — so a
 *  name stored under `empire:member` follows the chair rather than the person.
 *  Resolving to the key at the moment the record verifies means a name is keyed
 *  by the same thing its fingerprint is derived from, and a player who drops and
 *  comes back keeps their name for free.
 *
 *  (Muting has the same bug for the same reason, and is not this store's to
 *  fix — but it is this store that makes it visible.) */
export class Names {
  private readonly held = new Map<MemberKey, Named>();

  /** Take a verified naming. Returns true if it changed what we show, which is
   *  what a caller redraws on. */
  take(entry: Named): boolean {
    const before = this.held.get(entry.key);
    if (before && !newer(entry, before)) return false;
    if (before && before.name === entry.name) {
      // A re-assert of the same name, which is most of the traffic: keep the
      // newer record so the next comparison is against it, and tell nobody.
      this.held.set(entry.key, entry);
      return false;
    }
    this.held.set(entry.key, entry);
    return true;
  }

  nameOf(key: MemberKey): string {
    return this.held.get(key)?.name ?? "";
  }

  /** Whether we have ever heard from this key — the "first sight" that triggers
   *  answering with our own, which terminates because it fires once. */
  knows(key: MemberKey): boolean {
    return this.held.has(key);
  }

  all(): Named[] {
    return [...this.held.values()];
  }

  clear(): void {
    this.held.clear();
  }
}

/** Whether `a` supersedes `b`.
 *
 *  `(step, seq)` orders almost everything, and two records from one seat at one
 *  slot with different names are not a desync — a name is not hashed — but they
 *  are a **permanent UI split**, with two peers showing different names for the
 *  same person for the rest of the game. Moves have `EquivocationWatch` for
 *  exactly this and it covers moves only, so the tie breaks on the signature
 *  bytes: total, cheap, identical on every peer, and needing no proof record. */
function newer(a: Named, b: Named): boolean {
  if (a.step !== b.step) return a.step > b.step;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.sig > b.sig;
}
