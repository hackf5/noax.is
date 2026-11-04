CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  markdown TEXT NOT NULL CHECK (length(trim(markdown)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE INDEX posts_chronology ON posts (created_at DESC, id DESC);
