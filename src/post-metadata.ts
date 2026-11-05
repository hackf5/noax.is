import MarkdownIt from "markdown-it";
import type { Post } from "./types";

export const markdown = new MarkdownIt("commonmark", { html: false }).disable("image");
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parsePost(source: string) {
  const tokens = markdown.parse(source, {});
  const titleIndex = tokens.findIndex((token) => token.type === "heading_open" && token.tag === "h1" && token.level === 0);
  const title = (titleIndex < 0 ? "" : tokens[titleIndex + 1]?.children?.map((token) => {
    if (token.type === "text" || token.type === "code_inline") return token.content;
    return token.type === "softbreak" || token.type === "hardbreak" ? " " : "";
  }).join(""))?.replace(/\s+/g, " ").trim();
  return { tokens, titleIndex: title ? titleIndex : -1, title: title || "Post" };
}

export function slugifyTitle(title: string): string {
  const slug = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 160).replace(/^-+|-+$/g, "") || "post";
  // UUID-shaped slugs would overlap the legacy permalink namespace.
  return UUID_PATTERN.test(slug) ? `post-${slug}` : slug;
}

export function slugCandidate(base: string, attempt: number): string {
  return attempt === 1 ? base : `${base}-${attempt}`;
}

export function postPath(post: Pick<Post, "id" | "slug">): string {
  return `/posts/${post.slug ?? post.id}`;
}
