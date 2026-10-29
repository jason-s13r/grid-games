-- Listings, players and results, written by each game's Durable Object.
--
-- The rooms are the source of truth for a game in progress; these tables are
-- what outlives a room and what can be asked across games: which are open,
-- what one player has played, who has won the most.

CREATE TABLE games (
  id               TEXT PRIMARY KEY,
  creator          TEXT    NOT NULL,
  public           INTEGER NOT NULL DEFAULT 0,
  phase            TEXT    NOT NULL,            -- lobby | playing | ended
  created_at       INTEGER NOT NULL,
  starts_at        INTEGER,
  started_at       INTEGER,
  join_until       INTEGER,
  ends_at          INTEGER,
  ended_at         INTEGER,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  empires          INTEGER NOT NULL,
  seats_per_empire INTEGER NOT NULL,
  bots             INTEGER NOT NULL,
  players          INTEGER NOT NULL DEFAULT 0,
  sim_version      TEXT,
  winner           INTEGER,
  win_reason       INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX games_listing ON games (public, phase, updated_at DESC);

-- Everyone who joined a game, and where they ended up sitting.
CREATE TABLE seats (
  game_id   TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  empire    INTEGER,                            -- null: undecided, or watching
  bot       INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, key)
);
CREATE INDEX seats_by_key ON seats (key, joined_at DESC);

-- One row per seat in a finished game.
CREATE TABLE results (
  game_id     TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  empire      INTEGER NOT NULL,
  place       INTEGER NOT NULL,
  won         INTEGER NOT NULL,
  empires     INTEGER NOT NULL,                 -- how many were placed
  tiles       INTEGER NOT NULL,
  peak_tiles  INTEGER NOT NULL,
  moves       INTEGER NOT NULL,
  tiles_taken INTEGER NOT NULL,
  bot         INTEGER NOT NULL DEFAULT 0,
  ended_at    INTEGER NOT NULL,
  PRIMARY KEY (game_id, key)
);
CREATE INDEX results_by_key ON results (key, ended_at DESC);

-- The latest name each key went by.
CREATE TABLE players (
  key        TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
