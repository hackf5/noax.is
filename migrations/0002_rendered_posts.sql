-- A disposable cache of each post's rendered Markdown, so public reads do no Markdown work.
-- A row whose render_version differs from RENDER_VERSION in src/render.ts, including NULL,
-- is rebuilt and saved the next time it's read.
ALTER TABLE posts ADD COLUMN html TEXT;
ALTER TABLE posts ADD COLUMN title TEXT;
ALTER TABLE posts ADD COLUMN summary TEXT;
ALTER TABLE posts ADD COLUMN render_version INTEGER;
