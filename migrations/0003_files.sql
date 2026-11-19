CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  width INTEGER,
  height INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'uploading', 'ready', 'deleting')),
  created_at TEXT NOT NULL,
  ready_at TEXT
) STRICT;

CREATE INDEX files_chronology ON files (created_at DESC, id DESC);

CREATE TABLE post_files (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  PRIMARY KEY (post_id, file_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX post_files_by_file ON post_files (file_id, post_id);

CREATE TRIGGER post_files_require_ready BEFORE INSERT ON post_files
WHEN (SELECT state FROM files WHERE id = NEW.file_id) IS NOT 'ready'
BEGIN
  SELECT RAISE(ABORT, 'Referenced file is no longer ready');
END;
