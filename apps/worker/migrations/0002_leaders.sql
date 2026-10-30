-- What the leaderboard ranks besides wins: an empire's peak population, and
-- each seat's largest coin cascade. Results written before this read as 0.
ALTER TABLE results ADD COLUMN peak_pop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN cascade_tiles INTEGER NOT NULL DEFAULT 0;
