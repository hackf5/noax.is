import { parsePost, slugCandidate, slugifyTitle } from "./post-metadata.ts";
import type { Post } from "./types";

export type SlugQuery = <Row>(sql: string, params: (string | number)[]) => Promise<Row[]>;

export async function backfillSlugs(query: SlugQuery): Promise<number> {
  let updated = 0;
  for (;;) {
    const [post] = await query<Pick<Post, "id" | "markdown" | "version">>(
      "SELECT id, markdown, version FROM posts WHERE slug IS NULL ORDER BY created_at, id LIMIT 1", [],
    );
    if (!post) return updated;
    const base = slugifyTitle(parsePost(post.markdown).title);
    for (let attempt = 1; ; attempt++) {
      const candidate = slugCandidate(base, attempt);
      const changed = await query<{ id: string }>(
        "UPDATE posts SET slug = ? WHERE id = ? AND version = ? AND slug IS NULL AND NOT EXISTS (SELECT 1 FROM posts WHERE slug = ?) RETURNING id",
        [candidate, post.id, post.version, candidate],
      );
      if (changed.length) {
        updated++;
        break;
      }
      const [current] = await query<Pick<Post, "slug" | "version">>("SELECT slug, version FROM posts WHERE id = ?", [post.id]);
      // Re-read the heading after a concurrent edit; leave completed/deleted rows alone.
      if (!current || current.slug !== null || current.version !== post.version) break;
    }
  }
}
