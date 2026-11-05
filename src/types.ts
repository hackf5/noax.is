export interface Env {
  DB: D1Database;
  PUBLIC_HOST: string;
  MCP_HOST: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SITE_TITLE: string;
  SITE_DESCRIPTION: string;
  SITE_LOCALE: string;
  SITE_CONTENT_SIGNAL: string;
}

export interface Post {
  id: string;
  slug: string | null;
  markdown: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Rendered {
  html: string;
  title: string;
  summary: string;
}

export type PublishedPost = Post & Rendered;

export interface PostPage<T = Post> {
  posts: T[];
  next_cursor: string | null;
}

export interface SitemapBucket {
  bucket: number;
  lastmod: string;
}

export type SitemapPost = Pick<Post, "id" | "slug" | "updated_at">;

export class PostError extends Error {
  constructor(
    public readonly code: "validation" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PostError";
  }
}
