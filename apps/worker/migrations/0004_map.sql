-- A game's map, small, for the listings: JSON with the grid's size, the house
-- each empire flies, and its cells deflated and base64 encoded. With the time it
-- was taken. Null for games that have not started, and for games that ended
-- before maps were kept.
ALTER TABLE games ADD COLUMN map TEXT;
ALTER TABLE games ADD COLUMN map_at INTEGER;
