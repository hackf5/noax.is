import { RENDER_VERSION, renderMarkdown } from "./render";
import { PostError, type Post, type PostPage, type PublishedPost, type Rendered, type SitemapBucket, type SitemapPost } from "./types";

export const PAGE_SIZE = 20;
export const MAX_MARKDOWN_LENGTH = 64_000;
export const SITEMAP_SIZE = 1000;

// Naming these keeps the rendered columns out of MCP responses.
const POST_COLUMNS = "id, markdown, created_at, updated_at, version";

type StoredPost = Post & { [key in keyof Rendered]: string | null } & { render_version: number | null };

export function validateMarkdown(markdown: string): void {
  if (!markdown.trim()) throw new PostError("validation", "Post Markdown must not be empty.");
  if (markdown.length > MAX_MARKDOWN_LENGTH) {
    throw new PostError("validation", `Post Markdown must be at most ${MAX_MARKDOWN_LENGTH} characters.`);
  }
}

function decodeCursor(cursor: string): { created_at: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "string" || typeof parsed[1] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[0]) ||
      !/^[0-9a-f-]{36}$/.test(parsed[1])
    ) throw new Error("Invalid cursor");
    return { created_at: parsed[0], id: parsed[1] };
  } catch {
    throw new PostError("validation", "Invalid pagination cursor. Use next_cursor from list_posts.");
  }
}

export class Posts {
  constructor(
    private readonly db: D1Database,
    private readonly render: (markdown: string) => Rendered = renderMarkdown,
  ) {}

  // Stored output is a cache of the Markdown. A Worker can't see its CPU limit coming, so the save
  // is awaited: if the Worker is killed, posts already rebuilt stay rebuilt for the next request.
  private async published(post: StoredPost): Promise<PublishedPost> {
    if (post.render_version === RENDER_VERSION) return post as PublishedPost;
    const rendered = this.render(post.markdown);
    try {
      // Matching version stops a slow read overwriting a newer edit. This isn't an edit, so version
      // and updated_at stay as they are.
      await this.db.prepare(
        "UPDATE posts SET html = ?, title = ?, summary = ?, render_version = ? WHERE id = ? AND version = ?",
      ).bind(rendered.html, rendered.title, rendered.summary, RENDER_VERSION, post.id, post.version).run();
    } catch (error) {
      console.error("Render cache write failed", error instanceof Error ? error.name : "unknown");
    }
    return { ...post, ...rendered };
  }

  private async page<T extends Post>(columns: string, cursor: string | undefined, limit: number): Promise<PostPage<T>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PostError("validation", "Limit must be an integer between 1 and 100.");
    }
    const before = cursor ? decodeCursor(cursor) : null;
    const statement = before
      ? this.db.prepare(`SELECT ${columns} FROM posts WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`)
          .bind(before.created_at, before.id, limit + 1)
      : this.db.prepare(`SELECT ${columns} FROM posts ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit + 1);
    const { results } = await statement.all<T>();
    const posts = results.slice(0, limit);
    const last = posts.at(-1);
    return {
      posts,
      next_cursor: results.length > limit && last
        ? btoa(JSON.stringify([last.created_at, last.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
        : null,
    };
  }

  list(cursor?: string, limit = PAGE_SIZE): Promise<PostPage> {
    return this.page<Post>(POST_COLUMNS, cursor, limit);
  }

  async listPublished(cursor?: string, limit = PAGE_SIZE): Promise<PostPage<PublishedPost>> {
    const page = await this.page<StoredPost>("*", cursor, limit);
    const posts: PublishedPost[] = [];
    // One at a time, so each post is saved before the next is rendered.
    for (const post of page.posts) posts.push(await this.published(post));
    return { ...page, posts };
  }

  async get(id: string): Promise<Post> {
    const post = await this.db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).bind(id).first<Post>();
    if (!post) throw new PostError("not_found", "Post not found.");
    return post;
  }

  async getPublished(id: string): Promise<PublishedPost> {
    const post = await this.db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<StoredPost>();
    if (!post) throw new PostError("not_found", "Post not found.");
    return this.published(post);
  }

  // Sitemaps are split on rowid: it's unique, so a bucket can't outgrow SITEMAP_SIZE however posts
  // were created, and deleting a post moves no other. Neither query renders, so the cost of a
  // request doesn't depend on the render cache. SITEMAP_SIZE is written into the SQL because D1 can
  // bind numbers as REAL, which would turn this into float division and one bucket per post.
  async sitemapBuckets(): Promise<SitemapBucket[]> {
    const { results } = await this.db.prepare(
      `SELECT rowid / ${SITEMAP_SIZE} AS bucket, MAX(updated_at) AS lastmod FROM posts GROUP BY bucket ORDER BY bucket`,
    ).all<SitemapBucket>();
    return results;
  }

  async sitemapPosts(bucket: number): Promise<SitemapPost[]> {
    const { results } = await this.db.prepare("SELECT id, updated_at FROM posts WHERE rowid >= ? AND rowid < ? ORDER BY rowid")
      .bind(bucket * SITEMAP_SIZE, (bucket + 1) * SITEMAP_SIZE).all<SitemapPost>();
    return results;
  }

  async create(markdown: string): Promise<Post> {
    validateMarkdown(markdown);
    const { html, title, summary } = this.render(markdown);
    const timestamp = new Date().toISOString();
    const post = await this.db.prepare(
      `INSERT INTO posts (id, markdown, html, title, summary, render_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POST_COLUMNS}`,
    ).bind(crypto.randomUUID(), markdown, html, title, summary, RENDER_VERSION, timestamp, timestamp).first<Post>();
    if (!post) throw new Error("Post insert returned no result.");
    return post;
  }

  async update(id: string, markdown: string, expectedVersion: number): Promise<Post> {
    validateMarkdown(markdown);
    const { html, title, summary } = this.render(markdown);
    const post = await this.db.prepare(
      `UPDATE posts SET markdown = ?, html = ?, title = ?, summary = ?, render_version = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING ${POST_COLUMNS}`,
    ).bind(markdown, html, title, summary, RENDER_VERSION, new Date().toISOString(), id, expectedVersion).first<Post>();
    if (!post) {
      await this.get(id);
      throw new PostError("conflict", "Post changed. Call get_post and review the latest version before editing again.");
    }
    return post;
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    const result = await this.db.prepare("DELETE FROM posts WHERE id = ? AND version = ? RETURNING id")
      .bind(id, expectedVersion).first<{ id: string }>();
    if (!result) {
      await this.get(id);
      throw new PostError("conflict", "Post changed. Call get_post and review the latest version before deleting.");
    }
  }
}
