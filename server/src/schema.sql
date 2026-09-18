-- Starting schema. Adjust freely; the app re-runs these statements on boot
-- and they are all CREATE TABLE IF NOT EXISTS, so editing is safe.

CREATE TABLE IF NOT EXISTS series (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(100)  NOT NULL UNIQUE,
  name         VARCHAR(255)  NOT NULL,
  channel      VARCHAR(100)  NULL,
  archive_url  VARCHAR(500)  NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shows (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  content_id  BIGINT        NOT NULL UNIQUE,   -- ERR's own episode id: the natural key
  series_id   INT           NOT NULL,
  title       VARCHAR(500)  NOT NULL,
  show_date   DATE          NULL,
  url         VARCHAR(500)  NULL,
  track_count INT           NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_shows_series FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  INDEX idx_shows_date (show_date),
  INDEX idx_shows_series_date (series_id, show_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS artists (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(400) NOT NULL,             -- as printed by ERR
  name_norm  VARCHAR(400) NOT NULL UNIQUE,      -- lowercased/trimmed, for matching
  INDEX idx_artists_name (name(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tracks (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  show_id   INT          NOT NULL,
  artist_id INT          NULL,                  -- NULL where ERR left the artist blank
  title     VARCHAR(500) NOT NULL,
  position  INT          NOT NULL,              -- order within the show, 1-based
  CONSTRAINT fk_tracks_show   FOREIGN KEY (show_id)   REFERENCES shows(id)   ON DELETE CASCADE,
  CONSTRAINT fk_tracks_artist FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL,
  UNIQUE KEY uq_track_position (show_id, position),
  INDEX idx_tracks_title (title(64)),
  INDEX idx_tracks_artist (artist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS imports (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  filename        VARCHAR(300) NOT NULL,
  kind            VARCHAR(20)  NOT NULL,        -- 'tracks' | 'shows' | 'unknown'
  series_slug     VARCHAR(100) NULL,
  rows_read       INT NOT NULL DEFAULT 0,
  shows_upserted  INT NOT NULL DEFAULT 0,
  tracks_inserted INT NOT NULL DEFAULT 0,
  artists_created INT NOT NULL DEFAULT 0,
  skipped         INT NOT NULL DEFAULT 0,
  ok              TINYINT(1) NOT NULL DEFAULT 1,
  message         TEXT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
