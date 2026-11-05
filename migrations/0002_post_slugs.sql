ALTER TABLE posts ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX posts_slug ON posts (slug);
