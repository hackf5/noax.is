-- Written with each post so public reads do no Markdown work.
-- Rows from before this migration stay NULL and are rendered on read until edited.
ALTER TABLE posts ADD COLUMN html TEXT;
ALTER TABLE posts ADD COLUMN title TEXT;
ALTER TABLE posts ADD COLUMN summary TEXT;
