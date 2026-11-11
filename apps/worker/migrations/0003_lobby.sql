-- Everybody in a game's lobby, picked or not, beside `players`, which is the
-- seats taken. 0 for games listed before it and once a game has started.
ALTER TABLE games ADD COLUMN lobby INTEGER NOT NULL DEFAULT 0;
