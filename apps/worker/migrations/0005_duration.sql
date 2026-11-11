-- How long a game runs once started, ms: so a listing can say how long a game
-- is before it starts, when it has no end time yet. Null for rows written
-- before it was kept, until their room next reports.
ALTER TABLE games ADD COLUMN duration_ms INTEGER;
