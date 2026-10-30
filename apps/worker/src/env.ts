import type { GameRoom } from "./game-room.js";

export interface Env {
  ASSETS: Fetcher;
  GAMES: DurableObjectNamespace<GameRoom>;
  /** Listings, players and results. Optional so a Worker without the
   *  database still runs games; it just lists nothing. */
  DB?: D1Database;
  /** Archives of finished games. Optional like DB: without it nothing is
   *  archived, and nothing is ever deleted. */
  ARCHIVE?: R2Bucket;
  /** Days a finished game's room keeps its storage after archiving. */
  KEEP_DAYS?: string;
  /** Minutes; 15 when unset. Set in the dashboard, not in wrangler.jsonc. */
  DEFAULT_DURATION_MINUTES?: string;
}
