CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  album TEXT NOT NULL,
  album_key TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS track_artists (
  name_key TEXT NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  name TEXT NOT NULL,
  PRIMARY KEY (name_key, track_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS plays (
  source INTEGER NOT NULL CHECK (source IN (0, 1)),
  time INTEGER NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  ms INTEGER,
  PRIMARY KEY (source, time, track_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS plays_track ON plays(track_id, time);

CREATE TABLE IF NOT EXISTS archive_imports (
  id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  next INTEGER NOT NULL DEFAULT 0,
  first INTEGER NOT NULL,
  last INTEGER NOT NULL,
  full INTEGER NOT NULL CHECK (full IN (0, 1)),
  CHECK (next BETWEEN 0 AND n)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS feed_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER,
  floor INTEGER,
  started INTEGER,
  success INTEGER,
  error INTEGER NOT NULL DEFAULT 0
);

CREATE VIEW IF NOT EXISTS effective_plays AS
SELECT source, time, track_id, ms FROM plays AS p
WHERE p.source = 0 OR (
  NOT EXISTS (
    SELECT 1 FROM archive_imports AS a
    WHERE a.full = 1 AND a.next = a.n AND p.time BETWEEN a.first AND a.last
  ) AND NOT EXISTS (
    SELECT 1 FROM plays AS a WHERE a.source = 0 AND a.time = p.time AND a.track_id = p.track_id
  )
);
