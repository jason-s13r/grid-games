// Banners: the house an empire flies.
//
// An empire's identity used to be a position in an array — `EMPIRE_THEMES[(id
// - 1) % 6]` in the web client — so "I play as Vermilion" meant "I was seated
// first", and there was no way to be the same thing twice. A banner is the
// other shape: a house you belong to, available in a game or not, and yours
// when it is.
//
// **None of this is consensus data and none of it needs to become consensus
// data.** The simulation has never heard of an empire's colours: `createState`
// copies no such field, `snapshot()` encodes no genesis field at all, and
// `hashState` cannot see one. What is missing is only that every peer must
// present the *same* thing — two players comparing screenshots have to be
// looking at the same board — so the binding from empire id to banner rides in
// the one record every peer already agrees on byte for byte, and nowhere else.
//
// It lives in `sim` rather than in the client for the reason `specs.ts` does:
// this is data used to *compose* a genesis that the simulation itself never
// reads, and a headless peer wants to say "Sping won" rather than "empire 4
// won".

/** A stable slug, and **never a display name in a record**.
 *
 *  The genesis is hashed, so anything in it is frozen into the game id forever.
 *  Put the string "Vermilion" in a record and a later rename forks history: old
 *  archives say Vermilion, new games say something else, and the two stop being
 *  comparable. Put the id in, and a rename is a one-line edit to the table below
 *  that every archive ever written picks up on its next replay. */
export type BannerId = string;

export interface Banner {
  id: BannerId;
  name: string;
  /** Foreground and background. Two colours, because the flag patterns are
   *  conic gradients parameterised on exactly two. */
  c1: string;
  c2: string;
  pattern: "star" | "spiral";
}

/** The houses, **append-only and never reordered**.
 *
 *  The first six are the themes the web client shipped with, in the order it
 *  had them, and their positions are load-bearing rather than tidy: a record
 *  written before banners existed carries no banner field and falls back to its
 *  empire index, so moving an entry repaints every archived game.
 *
 *  `banners.test.ts` pins the order against a stored fixture. That test is the
 *  thing that makes "growing the table is a pure data change" true rather than
 *  aspirational. */
export const BANNERS: readonly Banner[] = [
  { id: "vermilion", name: "Vermilion", c1: "#ff2600", c2: "#1a0400", pattern: "star" },
  { id: "verdant", name: "Verdant", c1: "#72e21f", c2: "#044012", pattern: "spiral" },
  { id: "cobalt", name: "Cobalt", c1: "#3d8bff", c2: "#04173f", pattern: "star" },
  { id: "amber", name: "Amber", c1: "#ffb300", c2: "#3d2400", pattern: "spiral" },
  { id: "amethyst", name: "Amethyst", c1: "#b45cff", c2: "#26043f", pattern: "star" },
  { id: "cyan", name: "Cyan", c1: "#00d5c8", c2: "#00332f", pattern: "spiral" },
  // Appended. Everything from here is new ground, and the six above must keep
  // their positions forever.
  { id: "marigold", name: "Marigold", c1: "#ff7a1a", c2: "#3b1500", pattern: "star" },
  { id: "rose", name: "Rose", c1: "#ff5fa2", c2: "#3d0620", pattern: "spiral" },
  { id: "slate", name: "Slate", c1: "#9aa7b8", c2: "#141b24", pattern: "star" },
  { id: "moss", name: "Moss", c1: "#4e9d6b", c2: "#0a2416", pattern: "spiral" },
  { id: "indigo", name: "Indigo", c1: "#6f6bff", c2: "#101041", pattern: "star" },
  { id: "sand", name: "Sand", c1: "#e0cfa0", c2: "#3a3122", pattern: "spiral" },
];

/** How many empires a game may have, which is how many banners there are.
 *
 *  A real cap rather than a wrap. Every layer that draws an empire is sized
 *  from this, and a game with more empires than banners is refused at
 *  composition instead of drawn wrong. */
export const MAX_EMPIRES = BANNERS.length;

const BY_ID = new Map(BANNERS.map((banner) => [banner.id, banner]));

export const bannerById = (id: BannerId | undefined): Banner | undefined =>
  id === undefined ? undefined : BY_ID.get(id);

/** The banner an empire flies when its record does not say.
 *
 *  **Indexes; it does not wrap.** The old `(id - 1) % length` made the fallback
 *  a function of the table's *length*, so appending a banner would have
 *  repainted every record ever written — empire 7 was banner 1 and would have
 *  become banner 7. That is precisely the failure "store the id, never the name"
 *  exists to prevent, arriving through the other door.
 *
 *  Undefined past the end, which is a game that should have been refused at
 *  composition. */
export const bannerAt = (empire: number): Banner | undefined => BANNERS[empire - 1];
