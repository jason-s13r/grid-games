// The Worker's records: public listings, one player's games, the leaderboard.
// Shapes match apps/worker/src/records.ts.

export interface ListedGame {
  id: string;
  phase: "lobby" | "playing" | "ended";
  createdAt: number;
  startsAt: number | null;
  startedAt: number | null;
  joinUntil: number | null;
  endsAt: number | null;
  endedAt: number | null;
  width: number;
  height: number;
  empires: number;
  seatsPerEmpire: number;
  bots: number;
  players: number;
  winner: number | null;
}

export interface PlayerGame extends ListedGame {
  empire: number | null;
  place: number | null;
  won: number | null;
}

export interface PlayerStats {
  key: string;
  name: string | null;
  played: number;
  won: number;
  bestPlace: number | null;
  tilesTaken: number;
  games: PlayerGame[];
}

export interface Leader {
  key: string;
  name: string;
  played: number;
  won: number;
  score: number;
}

export type Listing = "open" | "running" | "ended";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return (await response.json()) as T;
}

export const listGames = (which: Listing): Promise<ListedGame[]> =>
  get<{ games: ListedGame[] }>(`/api/games?list=${which}`).then((body) => body.games);

export const playerStats = (key: string): Promise<PlayerStats> =>
  get<PlayerStats>(`/api/players/${encodeURIComponent(key)}`);

export const leaderboard = (): Promise<Leader[]> =>
  get<{ leaders: Leader[] }>(`/api/leaderboard`).then((body) => body.leaders);
