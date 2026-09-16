// Shared types for the deterministic core.
//
// Constants are `as const` object literals rather than TS enums so the source
// stays erasable-syntax only — it runs under Node's native type stripping and
// under any bundler without a transform step.

export type EmpireId = number; // 0 = neutral, 1..N = empire
export type TileIndex = number;
export type MemberIndex = number;

export const TERRAIN = {
  PLAIN: 0,
  MOUNTAIN: 1,
  LAKE: 2,
  RIVER: 3,
  RIVER_BRIDGED: 4,
  WALL: 5,
  WALL_LADDERED: 6,
} as const;
export type Terrain = (typeof TERRAIN)[keyof typeof TERRAIN];

export const ITEM = {
  NONE: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  DIAMOND: 4,
} as const;
export type Item = (typeof ITEM)[keyof typeof ITEM];

export const MOVE = {
  PASS: 0,
  CLAIM: 1,
  BUY_BRIDGE: 2,
  BUY_LADDER: 3,
  PLACE_BRIDGE: 4,
  PLACE_LADDER: 5,
  ROSTER_AMEND: 6,
  HEARTBEAT: 7,
  /** Claim a tile two steps out, filling the tile in between from the same
   *  population spend. Available once the empire has bought the upgrade. */
  MARCH: 8,
  BUY_MARCH: 9,
  BUY_GROWTH: 10,
} as const;
export type MoveType = (typeof MOVE)[keyof typeof MOVE];

export const MEMBER = { HUMAN: 0, BOT: 1 } as const;
export type MemberKind = (typeof MEMBER)[keyof typeof MEMBER];

export const CONTROL = { HUMAN: 0, SIMBOT: 1 } as const;
export type Control = (typeof CONTROL)[keyof typeof CONTROL];

export const PHASE = { PLAYING: 0, ENDED: 1 } as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

export const ELIMINATION = { CAPITAL: 0, ANNIHILATION: 1 } as const;
export type Elimination = (typeof ELIMINATION)[keyof typeof ELIMINATION];

export const WIN = {
  NONE: 0,
  TIMEOUT: 1,
  LAST_EMPIRE: 2,
  LAST_ROSTER: 3,
} as const;
export type WinReason = (typeof WIN)[keyof typeof WIN];

export interface Rules {
  popMax: number;
  popRateNum: number;
  popRateDen: number;
  maxMultiplier: number;

  cascadeTileCap: number;
  coinIntervalMin: number;
  coinIntervalMax: number;
  coinWeights: Array<[Item, number]>;
  maxItemsOnMap: number;

  bridgeCost: number;
  ladderCost: number;
  /** One purchase, unlocked forever — a march is a change to how the empire
   *  moves, not a thing it carries. Priced accordingly. */
  marchCost: number;
  /** Also a one-off unlock. Population growth is a standing property of a
   *  connected empire, not a potion that wears off. */
  growthCost: number;
  growthAmount: number;

  /** Steps between upkeep passes: one connectivity sweep per empire that both
   *  decays what is cut off and grows what is not. */
  upkeepInterval: number;
  /** Fraction of a disconnected tile's population lost per upkeep pass. */
  decayNum: number;
  decayDen: number;
  decayMin: number;

  /** Percent chance a spawn probe hops off an owned tile rather than landing
   *  uniformly, so coins appear near the fighting. */
  coinNearBias: number;
  coinNearRadius: number;

  /** Superseded by `graceTiles` / `graceSteps` and kept because every record
   *  written before vacancies carries them. Read through the grace fields, which
   *  fall back to these, so a stored game keeps the protection it was composed
   *  with. */
  noobTiles: number;
  noobSteps: number;

  /** How long a new empire's capital cannot be taken, counted **from that
   *  empire's own arrival** rather than from the start of the game.
   *
   *  The distinction is the whole of what makes a vacancy claimable. `noobSteps`
   *  is three minutes from step zero, so a player claiming an empire on day
   *  three would get not a shorter grace but none at all. Grace belongs to the
   *  empire: one seated at genesis has arrived at 0 forever, however many
   *  substitutes it amends in on day six, and a team does not get its capital
   *  immunity back by recruiting.
   *
   *  Optional, and absent falls back to the two above. */
  graceSteps?: number;
  graceTiles?: number;
  /** The two strength bars `graceTiles` alone cannot express.
   *
   *  Forty tiles of one population each is not an established empire, and it is
   *  exactly what a claimant holding a granted pocket looks like on the step
   *  they arrive. Protection ends when an empire is *established*, which is more
   *  than one measure — but see `isProtected` for the shape, because four
   *  conditions OR'd together can only ever shorten protection and that is the
   *  trap this is written to avoid.
   *
   *  Defaulted high enough that a genesis-seated empire crosses the tile bar
   *  first, exactly as it does today. */
  graceCapitalPop?: number;
  gracePopTotal?: number;

  /** No empire may take, march into, or cascade into a tile within this von
   *  Neumann ball of an **unclaimed** capital.
   *
   *  A von Neumann ball rather than a Euclidean disc because that is what
   *  `COIN_RADIUS` already means here, and two radius metrics is one too many.
   *
   *  The number is paid by the people already playing: `ballSize(r) = 2r²+2r+1`,
   *  so four vacancies at radius 14 would close 27% of the default map to
   *  everyone who turned up on time, for as long as the vacancies stand. Six
   *  closes 5.5% each and still costs a camper a ring of 24 tiles to wall.
   *
   *  Absent or 0 is no shield, which is every record written before vacancies. */
  vacancyRadius?: number;

  /** Population put on each neutral tile inside the ball when the vacancy is
   *  claimed, so an arrival is a pocket with a border to push from rather than
   *  one tile inside somebody's wall. 0 grants nothing. */
  vacancyGrant?: number;

  heartbeatInterval: number;
  livenessWindow: number;
  abandonWindow: number;
  elimination: Elimination;
  endStep: number;

  /** Steps after which no human seat may be added; absent or 0 = always open.
   *
   *  Optional because every genesis written before v4 lacks it, and reading it
   *  as 0 is what keeps those games playable rather than retroactively sealed.
   *  Optional also means `DEFAULT_RULES` does not carry it, so a game composed
   *  with no duration is byte-identical to what a v3 build composed. */
  joinWindow?: number;

  /** Default steps between a bot's claims, and the floor a headless bot is
   *  held to. A profile may ask for longer; nothing may ask for shorter, or an
   *  always-on seat would out-reflex the people it plays against. */
  botActionInterval: number;

  /** Seats one empire may ever hold, counted in the genesis record and enforced
   *  again on every ROSTER_AMEND.
   *
   *  This is the whole of team-size fairness. An empire is a set of seats
   *  sharing territory with a population timer each, so a side that can add
   *  seats freely simply out-accrues everyone else — and since a headless bot
   *  is an ordinary peer holding an ordinary seat, "add seats" costs nothing
   *  but processes. The cap is uniform across every empire in a game and it is
   *  in the genesis record, so it is agreed before anybody plays rather than
   *  argued about afterwards. */
  maxSeats: number;
}

export interface MapConfig {
  width: number;
  height: number;
  mountains: number;
  lakes: number;
  rivers: number;
  /** Passable gaps punched through each river. Without them a river seals the
   *  map and an empire is isolated until it can afford a bridge. */
  riverGaps: number;
  walls: number;
  blobMin: number;
  blobMax: number;
}

export interface MemberSpec {
  kind?: MemberKind;
  /** Public key in Phase C. The sim never inspects it; the net layer maps a
   *  verified signature to a member index before the move reaches here. */
  key?: string;
  /** How this seat plays, when a program is playing it. Absent means a person
   *  is, and the seat runs on the plain rules. */
  bot?: BotProfile;
}

/** How long a bot stays in one phase, and how fast it clicks while it is
 *  there.
 *
 *  Speed belongs to the phase rather than to the bot, because the same bot
 *  wants different tempos for different work: quick, cheap claims while it is
 *  spreading into empty ground, and a long bank before it puts something heavy
 *  on a tile it means to hold. `rate` is a span rather than a number, and one
 *  interval is drawn from it per visit to the phase — so two passes through
 *  the same phase are not identical, and neither is a bot spending a draw on
 *  every single claim. */
export interface BotPhase {
  /** Steps this phase lasts. Zero — or absent — means the bot never enters it,
   *  which is how a bot that never sleeps is written. Time in a phase is its
   *  share of the cycle, so duration is the appetite: there is no separate
   *  weight to keep in step with it. */
  steps: number;
  /** Steps between claims while in this phase, as [shortest, longest]. */
  rate: [number, number];
}

/** What makes one bot different from another.
 *
 *  A bot is not handicapped. It accrues at the same rate as a person — one
 *  population a step, 12 a second — and its coins chain like a person's.
 *  Everything below is a way of *playing* rather than a penalty for being a
 *  program, which is what makes difficulty a scale rather than a discount.
 *
 *  Strength belongs to the bot and speed belongs to the phase. A seat banks a
 *  population a step and a claim spends the lot, so a claim is worth
 *  `min(steps waited, popMax)`: popMax is the most a bot can ever put on one
 *  tile, and the phase decides whether it waits long enough to get there. A
 *  bot capped at 333 that waits the full 83 seconds a person needs for 999
 *  still lands 333 — that is the whole of its weakness, and it is legible on
 *  the board rather than hidden in an accrual table.
 *
 *  Everything here is in the genesis record and therefore agreed before the
 *  game starts. A bot's difficulty is something every peer can check, not
 *  something the peer running it asserts. */
export interface BotProfile {
  /** Population this seat banks to, never above `rules.popMax`. The most
   *  expensive tile it can ever leave behind, and the bot's whole strength. */
  popMax?: number;
  /** The cycle. A bot moves through the phases it has durations for and starts
   *  over — in `MODES` order, which is fixed (`policy.ts`), and never in the
   *  order they happen to be written here. This is a **set of durations, not a
   *  sequence**, and saying otherwise was a promise the simulation has never
   *  kept: `turnOf` builds its cycle with `MODES.map(...)`, and a genesis is
   *  canonicalised with its keys sorted anyway, so a declared order could not
   *  survive the record even if the sim honoured it. Nobody noticed because the
   *  three presets happen to declare their phases in exactly that order. */
  phases?: Partial<Record<BotMode, BotPhase>>;
  /** Percent chance of taking an adjacent coin instead of following the phase.
   *  Coins are the one way in the game to gain ground faster than population
   *  accrues, so this is the appetite for spidering outward. */
  coins?: number;
}

/** What a bot is doing for the next while.
 *
 *  expand   spiral along its own border, so it grows in every direction rather
 *           than growing a finger.
 *  attack   steer at the nearest tile somebody else is holding.
 *  defend   thicken the tiles it already has, starting where they are thinnest
 *           and an enemy is beside them.
 *  fortify  thicken the capital and the ring around it.
 *  heal     reconnect a pocket the capital can no longer reach, before upkeep
 *           decays it away.
 *  sleep    nothing at all. The population still accrues, so a bot coming out
 *           of a sleep phase opens with a full bank — which is exactly what a
 *           person returning from an hour away does. */
export type BotMode = "expand" | "attack" | "defend" | "fortify" | "heal" | "sleep";

export interface EmpireSpec {
  control?: Control;
  members: MemberSpec[];
}

export interface Genesis {
  /** Major of the sim that produced it. A peer refuses a mismatched major
   *  rather than desyncing silently hours later. */
  protocol: number;
  gameId?: string;
  seed: number;
  startedAt: number;
  map: MapConfig;
  rules: Rules;
  empires: EmpireSpec[];
  /** Who agreed to play this world, before it was a game.
   *
   *  Structural rather than imported, exactly as `MemberSpec.key` is: the
   *  simulation never inspects a signature, and `sim` cannot depend on
   *  `protocol` without inverting the one dependency in the tree. The net layer
   *  checks these against the proposal the record recomposes to — see
   *  `protocol/src/proposal.ts`.
   *
   *  Absent from every record composed before consent existed, and that is a
   *  state rather than a failure: a record claims nothing here and is checked
   *  for nothing. `gameIdOf` strips only `gameId`, so where the field *is*
   *  present it is hashed into the game id like everything else — which is
   *  what stops a sealer adding, removing or reordering one after the fact. */
  consent?: readonly { key: string; proposalId: string; sig: string }[];
}

export interface Move {
  step: number;
  empire: EmpireId;
  member: MemberIndex;
  seq: number;
  type: MoveType;
  x: number;
  y: number;
}

export interface Member {
  kind: MemberKind;
  /** This seat's population ceiling. `rules.popMax` for a person and for any
   *  seat that did not ask for less; lower for a bot dialled down. In state
   *  rather than read from the genesis on demand because a seat can arrive by
   *  amendment, and a snapshot has to carry what it grew. */
  popMax: number;
  popTimer: number;
  popAcc: number;
  lastBeat: number;
  joinedAt: number;
  stats: Uint32Array;
}

export interface Empire {
  id: EmpireId;
  control: Control;
  capital: TileIndex;
  bridges: number;
  ladders: number;
  /** 1 once the empire has bought the march upgrade. Permanent, and inherited
   *  by whoever takes the capital. */
  marchUnlocked: number;
  /** 1 once the empire has bought population growth. Permanent, and inherited
   *  by whoever takes the capital. */
  growthUnlocked: number;
  diamonds: number;
  tilesOwned: number;
  popTotal: number;
  alive: number;
  eliminatedAt: number;
  members: Member[];
  stats: Uint32Array;
}
