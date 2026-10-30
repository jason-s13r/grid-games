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

export type LeaderStat = "won" | "area" | "population" | "cascade";
export type LeaderScope = "game" | "total";

export interface Leader {
  key: string;
  name: string;
  played: number;
  value: number;
}

export type Listing = "open" | "running" | "ended";

async function get<T>(path: string): Promise<T> {
  // Revalidated each time: the start page should show a game made public, or
  // joined, a moment ago.
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`the server said ${response.status}`);
  return (await response.json()) as T;
}

export const listGames = (which: Listing): Promise<ListedGame[]> =>
  get<{ games: ListedGame[] }>(`/api/games?list=${which}`).then((body) => body.games);

export const playerStats = (key: string): Promise<PlayerStats> =>
  get<PlayerStats>(`/api/players/${encodeURIComponent(key)}`);

export const leaderboard = (scope: LeaderScope): Promise<Partial<Record<LeaderStat, Leader[]>>> =>
  get<{ lists: Partial<Record<LeaderStat, Leader[]>> }>(`/api/leaderboard?scope=${scope}`).then((body) => body.lists);
