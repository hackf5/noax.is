import { PostError, type Post, type PostPage } from "./types";

export const PAGE_SIZE = 20;
export const MAX_MARKDOWN_LENGTH = 64_000;

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
  constructor(private readonly db: D1Database) {}

  async list(cursor?: string, limit = PAGE_SIZE): Promise<PostPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PostError("validation", "Limit must be an integer between 1 and 100.");
    }
    const before = cursor ? decodeCursor(cursor) : null;
    const statement = before
      ? this.db.prepare("SELECT * FROM posts WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?")
          .bind(before.created_at, before.id, limit + 1)
      : this.db.prepare("SELECT * FROM posts ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit + 1);
    const { results } = await statement.all<Post>();
    const posts = results.slice(0, limit);
    const last = posts.at(-1);
    return {
      posts,
      next_cursor: results.length > limit && last
        ? btoa(JSON.stringify([last.created_at, last.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
        : null,
    };
  }

  async get(id: string): Promise<Post> {
    const post = await this.db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Post>();
    if (!post) throw new PostError("not_found", "Post not found.");
    return post;
  }

  async create(markdown: string): Promise<Post> {
    validateMarkdown(markdown);
    const timestamp = new Date().toISOString();
    const post = await this.db.prepare(
      "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *",
    ).bind(crypto.randomUUID(), markdown, timestamp, timestamp).first<Post>();
    if (!post) throw new Error("Post insert returned no result.");
    return post;
  }

  async update(id: string, markdown: string, expectedVersion: number): Promise<Post> {
    validateMarkdown(markdown);
    const post = await this.db.prepare(
      "UPDATE posts SET markdown = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING *",
    ).bind(markdown, new Date().toISOString(), id, expectedVersion).first<Post>();
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
