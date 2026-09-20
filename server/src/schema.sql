-- SQLite schema. Applied once, at build time, by server/src/build-db.js.
-- The running server opens the resulting file read-only and never writes.
-- Foreign keys are enabled in code (see createDatabase), not here: the pragma
-- is per-connection state and is a silent no-op inside a transaction.

CREATE TABLE IF NOT EXISTS series (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  channel     TEXT,
  archive_url TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY,
  content_id  INTEGER NOT NULL UNIQUE,      -- ERR's own episode id: the natural key
  series_id   INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  show_date   TEXT,                          -- YYYY-MM-DD, compared lexicographically
  url         TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shows_date        ON shows(show_date);
CREATE INDEX IF NOT EXISTS idx_shows_series_date ON shows(series_id, show_date);

CREATE TABLE IF NOT EXISTS artists (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,                   -- as printed by ERR
  name_norm TEXT NOT NULL UNIQUE             -- normalize.js norm(), used for matching
);

CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY,
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  title_norm TEXT NOT NULL,                  -- normalize.js norm(), used for search
  position   INTEGER NOT NULL,               -- order within the show, 1-based
  UNIQUE (show_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
