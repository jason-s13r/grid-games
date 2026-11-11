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
  pattern: Pattern;
}

/** How a tile of the empire's ground is drawn. Each is a CSS gradient on the
 *  same two colours; `star` and `spiral` are the prototype's. */
export type Pattern =
  | "star"
  | "spiral"
  | "arrow"
  | "saltire"
  | "stripes"
  | "bars"
  | "checker"
  | "chevron"
  | "ring"
  | "dots"
  | "diamond"
  | "rays"
  | "bend"
  | "frame"
  | "quarters"
  | "pales"
  | "fess"
  | "tierce"
  | "gyronny";

export const PATTERNS: readonly Pattern[] = [
  "star",
  "spiral",
  "arrow",
  "saltire",
  "stripes",
  "bars",
  "checker",
  "chevron",
  "ring",
  "dots",
  "diamond",
  "rays",
  "bend",
  "frame",
  "quarters",
  "pales",
  "fess",
  "tierce",
  "gyronny",
];

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
  { id: "vermilion", name: "Vermilion", c1: "#0d0606", c2: "#ff1f3d", pattern: "star" },
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
  // The first houses with flags of their own rather than the prototype's two.
  { id: "peony", name: "Peony", c1: "#ff7eb6", c2: "#4a0b2a", pattern: "arrow" },
  { id: "ink", name: "Ink", c1: "#1c1b24", c2: "#e8c547", pattern: "saltire" },
  { id: "plum", name: "Plum", c1: "#a23b7e", c2: "#22051a", pattern: "stripes" },
  { id: "tide", name: "Tide", c1: "#5ec8ff", c2: "#062a40", pattern: "bars" },
  { id: "zest", name: "Zest", c1: "#c6f000", c2: "#263000", pattern: "checker" },
  { id: "kestrel", name: "Kestrel", c1: "#7a2e12", c2: "#f1d9a6", pattern: "chevron" },
  { id: "lagoon", name: "Lagoon", c1: "#0a5c4f", c2: "#9fe8d0", pattern: "ring" },
  { id: "orchid", name: "Orchid", c1: "#e83ad6", c2: "#3a0636", pattern: "dots" },
  { id: "mint", name: "Mint", c1: "#7ff0b0", c2: "#053320", pattern: "diamond" },
  { id: "lumen", name: "Lumen", c1: "#ffe14d", c2: "#3a3000", pattern: "rays" },
  // A red star on black: the flag Vermilion flew until it turned inside out
  // (a black star on red), kept as a house of its own.
  { id: "sping", name: "Sping", c1: "#ff2600", c2: "#1a0400", pattern: "star" },
  // From the maritime signal flags, each kept to two colours. Oscar is also
  // the semaphore flag.
  { id: "oscar", name: "Oscar", c1: "#e3242b", c2: "#ffd100", pattern: "bend" },
  { id: "papa", name: "Papa", c1: "#173f8f", c2: "#f4f1e6", pattern: "frame" },
  { id: "uniform", name: "Uniform", c1: "#d7262f", c2: "#f4f1e6", pattern: "quarters" },
  { id: "golf", name: "Golf", c1: "#ffd100", c2: "#0d1a3a", pattern: "pales" },
  { id: "echo", name: "Echo", c1: "#ef3340", c2: "#2a5bd7", pattern: "fess" },
  { id: "tango", name: "Tango", c1: "#c8102e", c2: "#f4f1e6", pattern: "tierce" },
  { id: "zulu", name: "Zulu", c1: "#111111", c2: "#4fb3ff", pattern: "gyronny" },
  // The signal flags again in other colours, named for more of the alphabet.
  { id: "romeo", name: "Romeo", c1: "#7b3fe4", c2: "#f4f1e6", pattern: "bend" },
  { id: "quebec", name: "Quebec", c1: "#9ccc1c", c2: "#f4f1e6", pattern: "bend" },
  { id: "bravo", name: "Bravo", c1: "#00b8d4", c2: "#f4f1e6", pattern: "bend" },
  { id: "sierra", name: "Sierra", c1: "#ffd100", c2: "#f4f1e6", pattern: "frame" },
  { id: "whiskey", name: "Whiskey", c1: "#a3122a", c2: "#f4f1e6", pattern: "frame" },
  { id: "november", name: "November", c1: "#138a4a", c2: "#f4f1e6", pattern: "quarters" },
  { id: "lima", name: "Lima", c1: "#1d4fa8", c2: "#f4f1e6", pattern: "quarters" },
  { id: "alpha", name: "Alpha", c1: "#ffb000", c2: "#f4f1e6", pattern: "pales" },
  { id: "charlie", name: "Charlie", c1: "#6d3b1e", c2: "#f4f1e6", pattern: "pales" },
  { id: "delta", name: "Delta", c1: "#3a2c91", c2: "#111111", pattern: "fess" },
  { id: "hotel", name: "Hotel", c1: "#ec4899", c2: "#ffd100", pattern: "fess" },
  { id: "juliet", name: "Juliet", c1: "#2f6bff", c2: "#f4f1e6", pattern: "tierce" },
  { id: "foxtrot", name: "Foxtrot", c1: "#6a2c91", c2: "#f4f1e6", pattern: "tierce" },
  { id: "mike", name: "Mike", c1: "#00897b", c2: "#ffd100", pattern: "gyronny" },
  { id: "xray", name: "X-ray", c1: "#f57c00", c2: "#ffd100", pattern: "gyronny" },
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

/** The banner every empire in a game flies, in empire order.
 *
 *  A house is chosen rather than handed out, so an empire's banner comes from
 *  one of three places, and the order they are settled in is what keeps two
 *  empires off one flag:
 *
 *  1. **Sealed** in the genesis (`EmpireSpec.banner`): what its players picked
 *     in the lobby, or what a bot was given.
 *  2. **Claimed** with a vacancy, in log order: `claimed` maps an empire to the
 *     house its claimant brought. A house already flown is not taken twice;
 *     that empire falls through to the third rule instead.
 *  3. **Lent** to everybody else — vacancies nobody has claimed, and every
 *     empire in a record written before banners existed. Its index banner when
 *     that is free, which is what keeps every old record painted as it was, and
 *     otherwise the first house nobody is flying.
 *
 *  A lent banner is a picture, not a promise: a claimant may bring the house a
 *  vacancy was wearing, and the vacancy moves to another. */
export function flyBanners(
  empires: ReadonlyArray<{ banner?: BannerId }>,
  claimed: ReadonlyMap<number, BannerId> = new Map(),
): Banner[] {
  const flown: Array<Banner | undefined> = new Array(empires.length);
  const taken = new Set<BannerId>();
  const take = (at: number, banner: Banner | undefined): void => {
    if (!banner || taken.has(banner.id) || flown[at]) return;
    flown[at] = banner;
    taken.add(banner.id);
  };

  empires.forEach((empire, at) => take(at, bannerById(empire.banner)));
  for (const [empire, banner] of claimed) {
    if (empire >= 1 && empire <= empires.length) take(empire - 1, bannerById(banner));
  }
  for (let at = 0; at < empires.length; at++) {
    if (flown[at]) continue;
    take(at, bannerAt(at + 1));
    take(at, BANNERS.find((banner) => !taken.has(banner.id)));
    // More empires than houses: a game that should have been refused at
    // composition, drawn rather than crashed.
    flown[at] ??= bannerAt(at + 1) ?? BANNERS[0]!;
  }
  return flown as Banner[];
}

/** How much of a tile each pattern paints in its first colour, roughly. */
const FIRST_SHARE: Record<Pattern, number> = {
  star: 0.45,
  spiral: 0.5,
  arrow: 0.72,
  saltire: 0.78,
  stripes: 0.62,
  bars: 0.72,
  checker: 0.5,
  chevron: 0.72,
  ring: 0.7,
  dots: 0.6,
  diamond: 0.62,
  rays: 0.62,
  bend: 0.5,
  frame: 0.79,
  quarters: 0.5,
  pales: 0.5,
  fess: 0.5,
  tierce: 0.67,
  gyronny: 0.5,
};

/** The one colour a house is drawn in where its pattern is too small to see:
 *  the zoomed-out map, the minimap, a swatch. Its two colours mixed as its
 *  pattern mixes them, so a black star on red reads as a dark red rather than
 *  as the red alone — and two houses sharing a colour, in different patterns
 *  or with different partners, still read apart. */
export function mapColour(banner: Banner): string {
  const share = FIRST_SHARE[banner.pattern] ?? 0.5;
  const channel = (hex: string, at: number): number => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
  let out = "#";
  for (let at = 0; at < 3; at++) {
    const mixed = Math.round(channel(banner.c1, at) * share + channel(banner.c2, at) * (1 - share));
    out += mixed.toString(16).padStart(2, "0");
  }
  return out;
}
