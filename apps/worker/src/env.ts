import type { GameRoom } from "./game-room.js";

export interface Env {
  ASSETS: Fetcher;
  GAMES: DurableObjectNamespace<GameRoom>;
  DEFAULT_DURATION_DAYS: string;
}
