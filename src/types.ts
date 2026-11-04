export interface Env {
  DB: D1Database;
  PUBLIC_HOST: string;
  MCP_HOST: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

export interface Post {
  id: string;
  markdown: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface PostPage {
  posts: Post[];
  next_cursor: string | null;
}

export class PostError extends Error {
  constructor(
    public readonly code: "validation" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PostError";
  }
}
