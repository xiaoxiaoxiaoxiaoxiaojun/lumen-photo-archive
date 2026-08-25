CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '旅途',
  location TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  owner_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS photos_created_at_idx ON photos (created_at);
